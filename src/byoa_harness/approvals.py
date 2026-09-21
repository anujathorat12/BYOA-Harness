"""Human-in-the-loop approvals.

An approval-required call is *held open*: the broker coroutine awaits a future until an external
approver decides (or the timeout expires). Because the agent is blocked on that very response, and
its container is additionally frozen (cgroup freezer), nothing can proceed without a decision.
Every failure mode resolves to deny.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING

from .config import Settings
from .errors import DomainError
from .policy import Action, Decision
from .store import Store

if TYPE_CHECKING:
    from .broker.broker import SessionGov

log = logging.getLogger("approvals")


class ApprovalService:
    def __init__(self, store: Store, settings: Settings) -> None:
        self.store, self.settings = store, settings
        self._waiters: dict[str, asyncio.Future[str]] = {}

    async def request(self, gov: SessionGov, action: Action, decision: Decision, audit_ref: int) -> str:
        """Blocks until decided. Returns 'approved' | 'denied' | 'expired'."""
        aid = await asyncio.to_thread(
            self.store.create_approval, gov.session_id, gov.agent_id, gov.submitted_by, audit_ref,
            action.to_dict(), action.digest(), decision.rule_id,
            f"{decision.policy_id}@{decision.policy_version}", self.settings.approval_timeout_s)
        fut: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._waiters[aid] = fut
        status = "expired"
        paused = False
        try:
            # Everything after the row exists is inside the guard, so a cancellation at any await
            # (including the audit write) still resolves the approval to 'expired'.
            await gov.audit("approval.requested", {"approval_id": aid, "action_digest": action.digest(),
                                                   "timeout_s": self.settings.approval_timeout_s},
                            action=action, decision=decision)
            paused = True
            await gov.pause()
            status = await asyncio.wait_for(fut, self.settings.approval_timeout_s)
        except TimeoutError:
            if await asyncio.to_thread(self.store.decide_approval, aid, "expired", "harness", "timed out"):
                status = "expired"
            else:  # decided in the instant before the timeout fired
                status = (await asyncio.to_thread(self.store.get_approval, aid))["status"]
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await asyncio.shield(asyncio.to_thread(
                    self.store.decide_approval, aid, "expired", "harness", "session ended"))
            raise
        except Exception:  # e.g. audit unavailable: never leave a pending approval behind, and deny
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self.store.decide_approval, aid, "expired", "harness", "internal error")
            log.exception("approval request failed")
        finally:
            self._waiters.pop(aid, None)
            if paused:
                await gov.resume()
        rec = await asyncio.to_thread(self.store.get_approval, aid)
        await gov.audit("approval.resolved", {"approval_id": aid, "status": status,
                                              "decided_by": rec.get("decided_by"), "comment": rec.get("comment")},
                        action=action, decision=decision)
        return status

    async def decide(self, aid: str, approve: bool, by: str, comment: str | None) -> dict:
        rec = await asyncio.to_thread(self.store.get_approval, aid)
        if not rec:
            raise DomainError(404, "approval not found")
        if rec["status"] != "pending":
            raise DomainError(409, f"approval already {rec['status']}")
        if self.settings.separation_of_duties and rec["submitted_by"] == by:
            raise DomainError(403, "the submitter of a task may not approve its actions")
        status = "approved" if approve else "denied"
        if not await asyncio.to_thread(self.store.decide_approval, aid, status, by, comment):
            raise DomainError(409, "approval was decided concurrently")
        fut = self._waiters.get(aid)
        if fut and not fut.done():
            fut.set_result(status)
        return await asyncio.to_thread(self.store.get_approval, aid)

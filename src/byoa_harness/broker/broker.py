"""Policy Enforcement Point.

`Broker.handle_call` is the single code path through which an agent request can have any effect.
Order of operations (never reordered, never skipped):

  canonicalize -> decide (PDP) -> AUDIT decision (fail closed) -> enforce -> execute the *same* action -> AUDIT outcome
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ..approvals import ApprovalService
from ..config import Settings
from ..policy import (ALLOW, DENY, REQUIRE_APPROVAL, Action, CanonicalizationError, Decision, EvalContext,
                      Policy, canonical_json, evaluate_all)
from ..policy.canonical import sha256_hex
from ..store import Store
from .tools import Tool, ToolArgError, ToolContext

log = logging.getLogger("broker")
TOOL_TIMEOUT_S = 30
MAX_RESULT_BYTES = 64 * 1024


class AuditUnavailable(RuntimeError):
    """The audit log could not be written after an action had already executed."""


@dataclass
class SessionGov:
    """Everything the harness knows about one session's governance state. Lives in harness memory only."""

    session_id: str
    agent_id: str
    submitted_by: str
    policies: list[Policy]
    store: Store
    action_count: int = 0
    spent_tokens: int = 0
    spent_amount: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending: int = 0
    on_pause: Callable[[], Awaitable[None]] | None = None
    on_resume: Callable[[], Awaitable[None]] | None = None

    def context(self, offset: int = 0) -> EvalContext:
        return EvalContext(self.agent_id, self.session_id, self.spent_tokens, self.spent_amount,
                           self.action_count + offset)

    async def audit(self, kind: str, payload: dict[str, Any], *, action: Action | None = None,
                    decision: Decision | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(
            self.store.append_audit, self.session_id, self.agent_id, kind, payload,
            action_type=action.type if action else None, resource=action.resource if action else None,
            effect=decision.effect if decision else None, rule_id=decision.rule_id if decision else None,
            policy_id=decision.policy_id if decision else None,
            policy_version=decision.policy_version if decision else None)

    async def pause(self) -> None:
        self.pending += 1
        if self.pending == 1 and self.on_pause:
            await self.on_pause()

    async def resume(self) -> None:
        self.pending = max(0, self.pending - 1)
        if self.pending == 0 and self.on_resume:
            await self.on_resume()

    async def reserve(self, tokens: int, amount: float) -> None:
        self.spent_tokens += tokens
        self.spent_amount += amount
        try:
            await asyncio.to_thread(self.store.bump_session, self.session_id, tokens, amount, 0)
        except Exception:  # in-memory value is authoritative for enforcement; persisted copy is for reporting
            log.exception("failed to persist spend", extra={"session_id": self.session_id})


def _truncate(value: Any, limit: int = 2000) -> Any:
    try:
        s = canonical_json(value)
    except ValueError:
        return {"unserializable": True}
    return value if len(s) <= limit else {"truncated": True, "preview": s[:limit]}


class Broker:
    def __init__(self, store: Store, settings: Settings, tools: dict[str, Tool], tool_ctx: ToolContext,
                 approvals: ApprovalService) -> None:
        self.store, self.settings, self.tools, self.tool_ctx, self.approvals = store, settings, tools, tool_ctx, approvals

    @staticmethod
    def _error(call_id: str, code: str, message: str, rule_id: str | None = None) -> dict[str, Any]:
        err: dict[str, Any] = {"code": code, "message": message}
        if rule_id:
            err["rule_id"] = rule_id
        return {"type": "response", "id": call_id, "ok": False, "error": err}

    async def _refuse(self, gov: SessionGov, call_id: str, tool: str, raw_args: Any, rule: str, reason: str,
                      code: str) -> dict[str, Any]:
        """Audited denial for requests that never became a valid Action."""
        d = Decision(DENY, rule, "", 0, reason)
        try:
            await gov.audit("action.decided", {"call_id": call_id, "tool": tool[:64], "args": _truncate(raw_args),
                                               "context": gov.context().to_dict(), "decision": d.to_dict()},
                            decision=d)
        except Exception:
            log.exception("audit write failed")
            return self._error(call_id, "audit_unavailable", "action refused: audit log unavailable")
        return self._error(call_id, code, reason, rule)

    async def handle_call(self, gov: SessionGov, call: dict[str, Any]) -> dict[str, Any]:
        call_id = str(call.get("id", ""))[:64]
        tool_name, args = call.get("tool"), call.get("args", {})
        if not isinstance(tool_name, str) or not isinstance(args, dict):
            return await self._refuse(gov, call_id, str(tool_name), args, "harness:malformed-call",
                                      "call must have a string 'tool' and an object 'args'", "invalid_call")
        tool = self.tools.get(tool_name)
        if tool is None:
            return await self._refuse(gov, call_id, tool_name, args, "harness:unknown-tool",
                                      f"unknown tool '{tool_name[:64]}'", "unknown_tool")

        # ---- 1-3. canonicalize, decide, audit: serialized per session so budgets can't be raced ----------
        async with gov.lock:
            try:
                action = tool.build_action(args)
            except (ToolArgError, CanonicalizationError) as e:
                gov.action_count += 1
                return await self._refuse(gov, call_id, tool_name, args, "harness:invalid-arguments",
                                          str(e)[:300], "invalid_arguments")
            ctx = gov.context()
            try:
                decision = evaluate_all(gov.policies, action, ctx)
            except Exception:  # engine bug must never become an allow
                log.exception("policy engine error")
                decision = Decision(DENY, "harness:engine-error", "", 0, "policy evaluation failed")
            if gov.action_count >= self.settings.max_actions_per_session:
                decision = Decision(DENY, "harness:action-cap", "", 0, "session action cap reached")
            gov.action_count += 1
            digest = action.digest()
            try:
                ref = await gov.audit("action.decided", {
                    "call_id": call_id, "tool": tool_name, "action": _truncate(action.to_dict(), 8000),
                    "action_digest": digest, "context": ctx.to_dict(), "decision": decision.to_dict()},
                    action=action, decision=decision)
            except Exception:
                log.exception("audit write failed; refusing action")
                return self._error(call_id, "audit_unavailable", "action refused: audit log unavailable")
            if decision.effect == ALLOW:
                await gov.reserve(action.cost.tokens, action.cost.amount)
        try:
            await asyncio.to_thread(self.store.bump_session, gov.session_id, 0, 0.0, 1)
        except Exception:
            log.exception("failed to persist action count")

        # ---- 4. enforce ------------------------------------------------------------------------------------
        if decision.effect == DENY:
            return self._error(call_id, "policy_denied", decision.reason or "denied by policy", decision.rule_id)

        if decision.effect == REQUIRE_APPROVAL:
            status = await self.approvals.request(gov, action, decision, ref["id"])
            if status != "approved":
                await self._outcome(gov, call_id, tool_name, action, decision, ref["id"], f"approval_{status}", 0, None)
                return self._error(call_id, "approval_" + status,
                                   f"approver {'denied' if status == 'denied' else 'did not approve'} this action",
                                   decision.rule_id)
            async with gov.lock:  # budgets may have moved while we waited
                recheck = evaluate_all(gov.policies, action, gov.context(offset=-1))
                if recheck.effect == DENY:
                    await self._outcome(gov, call_id, tool_name, action, recheck, ref["id"], "blocked_after_approval", 0, None)
                    return self._error(call_id, "policy_denied", recheck.reason, recheck.rule_id)
                await gov.reserve(action.cost.tokens, action.cost.amount)

        # ---- 5. execute exactly what was evaluated ----------------------------------------------------------
        if action.digest() != digest:  # defence in depth: the evaluated object must not have changed
            return self._error(call_id, "integrity_error", "action changed after evaluation", "harness:integrity")
        started = time.monotonic()
        status, output, err_msg, actual_tokens = "ok", None, "", action.cost.tokens
        try:
            res = await asyncio.wait_for(tool.execute(action, self.tool_ctx), TOOL_TIMEOUT_S)
            output = res.output
            if res.tokens:
                actual_tokens = res.tokens
        except asyncio.CancelledError:
            raise
        except (LookupError, ValueError) as e:
            status, err_msg = "error", str(e)[:200]
        except TimeoutError:
            status, err_msg = "error", "tool timed out"
        except Exception:
            log.exception("tool failed", extra={"tool": tool_name, "session_id": gov.session_id})
            status, err_msg = "error", "tool execution failed"
        duration_ms = int((time.monotonic() - started) * 1000)
        if actual_tokens != action.cost.tokens:  # reconcile estimate with actual usage
            await gov.reserve(actual_tokens - action.cost.tokens, 0.0)
        await self._outcome(gov, call_id, tool_name, action, decision, ref["id"], status, duration_ms, output, err_msg)
        if status != "ok":
            return self._error(call_id, "tool_error", err_msg)
        if len(canonical_json(output)) > MAX_RESULT_BYTES:
            output = {"truncated": True, "preview": canonical_json(output)[:2000]}
        return {"type": "response", "id": call_id, "ok": True, "result": output}

    async def _outcome(self, gov: SessionGov, call_id: str, tool: str, action: Action, decision: Decision,
                       decision_ref: int, status: str, duration_ms: int, output: Any, error: str = "") -> None:
        payload: dict[str, Any] = {"call_id": call_id, "tool": tool, "decision_ref": decision_ref,
                                   "status": status, "duration_ms": duration_ms}
        if error:
            payload["error"] = error
        if output is not None:
            payload["result_digest"] = sha256_hex(json.dumps(output, sort_keys=True, default=str))
            payload["result_preview"] = _truncate(output, 500)
        try:
            await gov.audit("action.executed" if status == "ok" else "action.failed", payload,
                            action=action, decision=decision)
        except Exception as e:
            log.critical("audit write failed AFTER execution", extra={"session_id": gov.session_id})
            raise AuditUnavailable("outcome could not be audited") from e

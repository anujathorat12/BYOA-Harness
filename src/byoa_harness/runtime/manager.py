"""Session lifecycle: bounded concurrency, sandbox supervision, watchdog, crash/hang handling."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from ..approvals import ApprovalService
from ..broker.broker import AuditUnavailable, Broker, SessionGov
from ..config import Settings
from ..errors import DomainError
from ..policy import Policy, PolicyError, canonical_json, parse_policy
from ..store import Store, now_iso
from .sandbox import Limits, ProtocolViolation, Sandbox, SandboxError, docker_available, reap_orphans
from .shapes import SHAPES

log = logging.getLogger("sessions")
MAX_INFLIGHT_CALLS = 16
MAX_TASK_BYTES = 64 * 1024


@dataclass
class ActiveSession:
    sid: str
    agent_id: str
    limits: Limits
    gov: SessionGov
    sandbox: Any
    started: float = field(default_factory=time.monotonic)
    paused_total: float = 0.0
    paused_at: float | None = None
    kill_reason: str | None = None

    def active_seconds(self) -> float:
        now = time.monotonic()
        paused = self.paused_total + (now - self.paused_at if self.paused_at else 0.0)
        return now - self.started - paused


class SessionManager:
    def __init__(self, store: Store, settings: Settings, broker: Broker, approvals: ApprovalService) -> None:
        self.store, self.settings, self.broker, self.approvals = store, settings, broker, approvals
        self._sem = asyncio.Semaphore(settings.max_concurrent_sessions)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self.active: dict[str, ActiveSession] = {}
        self._finalizers: set[asyncio.Future[None]] = set()

    # ---------------------------------------------------------------- lifecycle
    async def startup(self) -> None:
        failed = await asyncio.to_thread(self.store.fail_orphaned_sessions)
        expired = await asyncio.to_thread(self.store.expire_stale_approvals)
        reaped = 0
        try:
            reaped = await reap_orphans()
        except Exception:
            log.warning("could not reap orphaned containers (docker unavailable?)")
        log.info("startup recovery", extra={"failed_sessions": len(failed), "expired_approvals": expired,
                                            "reaped_containers": reaped})

    async def shutdown(self) -> None:
        for t in list(self._tasks.values()):
            t.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        await asyncio.gather(*list(self._finalizers), return_exceptions=True)
        for act in list(self.active.values()):  # last resort: never leave a sandbox behind
            with contextlib.suppress(Exception):
                await act.sandbox.destroy()

    async def docker_ok(self) -> bool:
        return await docker_available()

    # ------------------------------------------------------------------- submit
    def _resolve_policies(self, agent_id: str, session_refs: list[dict[str, Any]]) -> tuple[list[Policy], list[dict[str, Any]]]:
        pinned: list[dict[str, Any]] = []
        policies: list[Policy] = []
        agent_level = self.store.list_attachments(agent_id)
        if not agent_level:
            return [], []  # no admin-attached policy => deny-all. Session policies must never be the only grant.
        refs = [(a["policy_id"], a["policy_version"], "agent") for a in agent_level]
        refs += [(r["id"], r.get("version"), "session") for r in session_refs]
        for pid, ver, source in refs:
            row = self.store.get_policy(pid, ver)
            if not row:
                raise DomainError(422, f"policy {pid}{'@' + str(ver) if ver else ''} not found")
            try:
                pol = parse_policy(row["document"]).with_version(row["version"])
            except PolicyError as e:  # stored documents were validated on write; fail closed regardless
                raise DomainError(500, f"stored policy {pid} is invalid: {e}") from e
            if pol.scope_agents and agent_id not in pol.scope_agents:
                raise DomainError(422, f"policy {pid} is not scoped to agent {agent_id}")
            policies.append(pol)
            pinned.append({"id": pid, "version": row["version"], "source": source})
        return policies, pinned

    async def submit(self, agent_id: str, task: dict[str, Any], by: str, session_refs: list[dict[str, Any]],
                     agent_version: int | None = None) -> dict[str, Any]:
        agent = await asyncio.to_thread(self.store.get_agent, agent_id, agent_version)
        if not agent:
            raise DomainError(404, "agent not found")
        try:
            if len(canonical_json(task)) > MAX_TASK_BYTES:
                raise DomainError(413, "task too large")
        except ValueError as e:
            raise DomainError(422, f"task is not valid JSON data: {e}") from e
        if len(self._tasks) >= self.settings.max_concurrent_sessions + self.settings.max_queued_sessions:
            raise DomainError(429, "harness at capacity; retry later")
        _, pinned = await asyncio.to_thread(self._resolve_policies, agent_id, session_refs)
        sid = await asyncio.to_thread(self.store.create_session, agent_id, agent["version"], by, task, pinned)
        await asyncio.to_thread(self.store.append_audit, sid, agent_id, "session.created",
                                {"submitted_by": by, "agent_version": agent["version"], "policies": pinned})
        self._tasks[sid] = asyncio.create_task(self._run(sid), name=f"session-{sid}")
        self._tasks[sid].add_done_callback(lambda _t, s=sid: self._tasks.pop(s, None))
        return await asyncio.to_thread(self.store.get_session, sid)

    async def cancel(self, sid: str) -> bool:
        t = self._tasks.get(sid)
        if not t:
            return False
        t.cancel()
        return True

    # ---------------------------------------------------------------------- run
    async def _run(self, sid: str) -> None:
        status, reason, output = "failed", "unknown", None
        act: ActiveSession | None = None
        try:
            async with self._sem:  # queued until a slot frees up
                status, reason, output, act = await self._execute(sid)
        except asyncio.CancelledError:
            status, reason = "cancelled", "cancelled by request"
        except Exception as e:
            log.exception("session crashed", extra={"session_id": sid})
            status, reason = "failed", f"internal error: {type(e).__name__}"
        finally:
            # Tracked so shutdown() can wait for it even if this task is cancelled a second time.
            fin = asyncio.ensure_future(self._finalize(sid, status, reason, output, act))
            self._finalizers.add(fin)
            fin.add_done_callback(self._finalizers.discard)
            await asyncio.shield(fin)

    async def _finalize(self, sid: str, status: str, reason: str, output: Any, act: ActiveSession | None) -> None:
        act = act or self.active.get(sid)  # cancelled/crashed mid-run: `_execute` never returned its handle
        with contextlib.suppress(Exception):
            if act:
                await act.sandbox.destroy()
        self.active.pop(sid, None)
        row = await asyncio.to_thread(self.store.get_session, sid)
        try:
            if row and await asyncio.to_thread(
                    self.store.finish_session_if_active, sid, status, result=output if status == "succeeded" else None,
                    error=None if status == "succeeded" else reason):
                await asyncio.to_thread(self.store.append_audit, sid, row["agent_id"], "session.finished",
                                        {"status": status, "reason": reason if status != "succeeded" else "",
                                         "spent_tokens": act.gov.spent_tokens if act else 0,
                                         "spent_amount": act.gov.spent_amount if act else 0.0,
                                         "actions": act.gov.action_count if act else 0})
        except Exception:
            log.exception("could not record session outcome", extra={"session_id": sid})
        log.info("session finished", extra={"session_id": sid, "status": status, "reason": reason})

    async def _execute(self, sid: str) -> tuple[str, str, Any, ActiveSession | None]:
        row = await asyncio.to_thread(self.store.get_session, sid)
        agent = await asyncio.to_thread(self.store.get_agent, row["agent_id"], row["agent_version"])
        adapter = SHAPES[agent["shape"]]
        policies = []
        for p in row["policies"]:
            doc = await asyncio.to_thread(self.store.get_policy, p["id"], p["version"])
            policies.append(parse_policy(doc["document"]).with_version(p["version"]))
        limits = adapter.limits(agent["manifest"], self.settings)
        gov = SessionGov(sid, row["agent_id"], row["submitted_by"], policies, self.store)
        sb = Sandbox(sid, adapter.image(self.settings), limits, self.settings.max_message_bytes)
        act = ActiveSession(sid, row["agent_id"], limits, gov, sb)
        self.active[sid] = act

        async def on_pause() -> None:
            act.paused_at = time.monotonic()
            await sb.pause()

        async def on_resume() -> None:
            await sb.resume()
            if act.paused_at:
                act.paused_total += time.monotonic() - act.paused_at
                act.paused_at = None
        gov.on_pause, gov.on_resume = on_pause, on_resume

        await asyncio.to_thread(self.store.update_session, sid, status="running",
                                started_at=now_iso())
        await asyncio.to_thread(self.store.append_audit, sid, row["agent_id"], "session.started", {
            "shape": agent["shape"], "agent_version": agent["version"], "policies": row["policies"],
            "limits": {"memory_mb": limits.memory_mb, "cpus": limits.cpus, "pids": limits.pids,
                       "timeout_s": limits.timeout_s}})
        try:
            await sb.start()
            await sb.send({"type": "init", "protocol": 1, "session_id": sid, "agent_id": row["agent_id"],
                           "shape": agent["shape"], "task": row["task"], **adapter.init_payload(agent["manifest"])})
        except (SandboxError, OSError) as e:
            return "failed", f"sandbox failed to start: {e}", None, act

        watchdog = asyncio.create_task(self._watchdog(act))
        inflight: set[asyncio.Task[None]] = set()
        result: dict[str, Any] | None = None
        violation: str | None = None
        progress_n = 0
        fatal: list[str] = []
        try:
            while True:
                try:
                    line = await sb.readline()
                except ProtocolViolation as e:
                    violation = str(e)
                    break
                if line is None:
                    break
                try:
                    msg = json.loads(line)
                    mtype = msg["type"]
                except (ValueError, KeyError, TypeError):
                    violation = "non-JSON or untyped message"
                    break
                if mtype == "call":
                    if len(inflight) >= MAX_INFLIGHT_CALLS:
                        resp = await self.broker.refuse(gov, str(msg.get("id", ""))[:64], str(msg.get("tool")),
                                                        msg.get("args"), "harness:inflight-cap",
                                                        "too many concurrent calls", "too_many_inflight")
                        await sb.send(resp)
                        continue
                    t = asyncio.create_task(self._call(act, msg, fatal))
                    inflight.add(t)
                    t.add_done_callback(inflight.discard)
                elif mtype == "progress":
                    if progress_n < self.settings.max_progress_events:
                        progress_n += 1
                        await asyncio.to_thread(self.store.append_audit, sid, row["agent_id"], "agent.progress",
                                                {"message": str(msg.get("message", ""))[:500]})
                elif mtype == "result":
                    result = msg
                    break
                else:
                    violation = f"unknown message type {str(mtype)[:32]!r}"
                    break
                if fatal:
                    break
            await sb.close_stdin()
            if result is None and not (violation or fatal or act.kill_reason):
                await sb.wait_exit(5)
        finally:
            watchdog.cancel()
            for t in inflight:
                t.cancel()
            await asyncio.gather(*inflight, return_exceptions=True)

        if act.kill_reason:
            return "failed", act.kill_reason, None, act
        if fatal:
            return "failed", fatal[0], None, act
        if violation:
            return "failed", f"protocol violation: {violation}", None, act
        if result is not None:
            if result.get("ok"):
                return "succeeded", "", result.get("output"), act
            return "failed", f"agent error: {str(result.get('error'))[:300]}", None, act
        await sb.wait_exit(3)
        info = await sb.exit_info()
        if info.get("oom_killed"):
            return "failed", f"agent killed: exceeded memory limit ({limits.memory_mb} MB)", None, act
        tail = sb.stderr_tail.strip()[-300:]
        return "failed", f"agent exited without a result (code {info.get('exit_code')}) {tail}".strip(), None, act

    async def _call(self, act: ActiveSession, msg: dict[str, Any], fatal: list[str]) -> None:
        try:
            resp = await self.broker.handle_call(act.gov, msg)
            await act.sandbox.send(resp)
        except AuditUnavailable:
            fatal.append("audit log unavailable; session terminated")
            await act.sandbox.destroy()
        except SandboxError:
            pass  # agent went away; the reader loop will observe EOF
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("call handling failed", extra={"session_id": act.sid})
            fatal.append("internal error while handling a call")
            await act.sandbox.destroy()

    async def _watchdog(self, act: ActiveSession) -> None:
        """Kills a hung or runaway agent. Time spent frozen awaiting an approval is not counted."""
        while True:
            await asyncio.sleep(0.5)
            if act.active_seconds() > act.limits.timeout_s:
                act.kill_reason = f"timeout: exceeded {act.limits.timeout_s}s of active runtime"
                log.warning("session timeout", extra={"session_id": act.sid})
                await act.sandbox.destroy()
                return

    # -------------------------------------------------------------------- admin
    async def admin_snapshot(self) -> list[dict[str, Any]]:
        out = []
        for act in list(self.active.values()):
            stats = {}
            with contextlib.suppress(Exception):
                stats = await act.sandbox.stats() if hasattr(act.sandbox, "stats") else {}
            out.append({"session_id": act.sid, "agent_id": act.agent_id,
                        "active_seconds": round(act.active_seconds(), 1), "paused": act.gov.pending > 0,
                        "pending_approvals": act.gov.pending, "actions": act.gov.action_count,
                        "spent_tokens": act.gov.spent_tokens, "spent_amount": act.gov.spent_amount,
                        "limits": {"memory_mb": act.limits.memory_mb, "cpus": act.limits.cpus,
                                   "timeout_s": act.limits.timeout_s},
                        "sandbox": stats})
        return out

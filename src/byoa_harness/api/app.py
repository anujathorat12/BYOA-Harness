"""HTTP API (versioned under /v1). Thin: validation, authn/authz, and delegation. No policy logic here."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from .. import __version__
from ..approvals import ApprovalError, ApprovalService
from ..broker.broker import Broker
from ..broker.llm import make_provider
from ..broker.tools import Backends, ToolContext, default_tools
from ..config import Principal, Settings
from ..logging_setup import setup_logging
from ..policy import (Action, CanonicalizationError, EvalContext, HistoricalAction, PolicyError, evaluate_all,
                      parse_policy, simulate)
from ..runtime.manager import SessionManager, SubmitError
from ..runtime.shapes import SHAPES, ManifestError
from ..store import Store

log = logging.getLogger("api")
TERMINAL = ("succeeded", "failed", "cancelled")


# --------------------------------------------------------------------------------------- schemas
class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentRegistration(_In):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    shape: str
    description: str = ""
    package: dict[str, Any] | None = None
    spec: dict[str, Any] | None = None
    resources: dict[str, Any] | None = None


class PolicyUpload(_In):
    document: str = Field(max_length=512_000)


class Attach(_In):
    policy_id: str
    version: int | None = Field(default=None, ge=1)


class PolicyRef(_In):
    id: str
    version: int | None = Field(default=None, ge=1)


class TaskSubmission(_In):
    task: dict[str, Any] = {}
    policies: list[PolicyRef] = Field(default=[], max_length=8)
    agent_version: int | None = Field(default=None, ge=1)


class Decision(_In):
    comment: str | None = Field(default=None, max_length=500)


class EvaluateRequest(_In):
    documents: list[str] = Field(min_length=1, max_length=8)
    action: dict[str, Any]
    agent_id: str = "simulated-agent"
    spent_tokens: int = 0
    spent_amount: float = 0.0
    action_count: int = 0


class SimulateRequest(_In):
    documents: list[str] | None = Field(default=None, max_length=8)
    policies: list[PolicyRef] | None = Field(default=None, max_length=8)
    agent_id: str | None = None
    session_id: str | None = None
    since: str | None = None
    limit: int = Field(default=1000, ge=1, le=5000)


# ------------------------------------------------------------------------------------------ app
def create_app(settings: Settings | None = None, sandbox_factory=None) -> FastAPI:  # noqa: ANN001
    settings = settings or Settings.from_env()
    settings.validate()
    setup_logging(settings.log_level)
    store = Store(settings.database_url)
    store.init_schema()
    approvals = ApprovalService(store, settings)
    tool_ctx = ToolContext(Backends(), make_provider(settings.llm_provider, settings.groq_api_key, settings.groq_model),
                           settings.egress_allow_private)
    broker = Broker(store, settings, default_tools(), tool_ctx, approvals)
    manager = SessionManager(store, settings, broker, approvals, sandbox_factory)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if not settings.api_keys:
            log.warning("no HARNESS_API_KEYS configured: running UNAUTHENTICATED as dev-admin (dev mode only)")
        await manager.startup()
        yield
        await manager.shutdown()

    app = FastAPI(title="BYOA Harness", version=__version__, lifespan=lifespan,
                  description="Run untrusted third-party agents in sandboxes, governed per action by declarative policy.")
    app.state.store, app.state.manager, app.state.broker, app.state.settings = store, manager, broker, settings
    app.state.tool_ctx = tool_ctx

    # ------------------------------------------------------------------- errors / middleware
    def err(status: int, code: str, message: str, rid: str = "") -> JSONResponse:
        return JSONResponse({"error": {"code": code, "message": message, "request_id": rid}}, status_code=status)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        return err(exc.status_code, "http_error", str(exc.detail), getattr(request.state, "rid", ""))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        msg = "; ".join(f"{'.'.join(str(p) for p in e['loc'][1:])}: {e['msg']}" for e in exc.errors())[:500]
        return err(422, "validation_error", msg, getattr(request.state, "rid", ""))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.exception("unhandled error", extra={"request_id": getattr(request.state, "rid", "")})
        return err(500, "internal_error", "internal error", getattr(request.state, "rid", ""))

    @app.middleware("http")
    async def _request_log(request: Request, call_next):
        request.state.rid = request.headers.get("x-request-id", uuid.uuid4().hex[:16])[:64]
        t0 = time.monotonic()
        resp = await call_next(request)
        resp.headers["x-request-id"] = request.state.rid
        if request.url.path not in ("/healthz", "/readyz", "/metrics"):
            log.info("request", extra={"request_id": request.state.rid, "method": request.method,
                                       "path": request.url.path, "status": resp.status_code,
                                       "ms": int((time.monotonic() - t0) * 1000)})
        return resp

    # ------------------------------------------------------------------------------ auth
    def principal(request: Request) -> Principal:
        if not settings.api_keys:
            return Principal("dev-admin", frozenset({"admin"}))
        h = request.headers.get("authorization", "")
        token = h[7:] if h.lower().startswith("bearer ") else ""
        p = settings.api_keys.get(token)
        if not p:
            raise HTTPException(401, "missing or invalid API key")
        return p

    def need(*roles: str):
        def dep(p: Principal = Depends(principal)) -> Principal:
            if "admin" in p.roles or p.roles & set(roles):
                return p
            raise HTTPException(403, f"requires one of roles: {', '.join(roles) or 'admin'}")
        return dep

    def is_privileged(p: Principal) -> bool:
        return bool(p.roles & {"admin", "auditor", "approver"})

    async def db(fn, *a, **kw):  # noqa: ANN001
        return await asyncio.to_thread(fn, *a, **kw)

    def visible_session(p: Principal, row: dict[str, Any] | None) -> dict[str, Any]:
        if not row or (not is_privileged(p) and row["submitted_by"] != p.name):
            raise HTTPException(404, "session not found")  # 404 not 403: don't reveal existence
        return row

    # ------------------------------------------------------------------------ operational
    @app.get("/healthz", tags=["ops"], summary="Liveness")
    async def healthz():
        return {"status": "ok", "version": __version__}

    @app.get("/readyz", tags=["ops"], summary="Readiness: database and (if enabled) Docker daemon")
    async def readyz():
        checks: dict[str, str] = {}
        try:
            await db(store.ping)
            checks["database"] = "ok"
        except Exception:
            checks["database"] = "unavailable"
        if settings.sandbox_enabled and sandbox_factory is None:
            checks["sandbox"] = "ok" if await manager.docker_ok() else "unavailable"
        ok = all(v == "ok" for v in checks.values())
        return JSONResponse({"status": "ready" if ok else "not_ready", "checks": checks}, status_code=200 if ok else 503)

    @app.get("/metrics", tags=["ops"], response_class=PlainTextResponse, summary="Prometheus metrics")
    async def metrics():
        dec, ses = await db(store.decision_counts), await db(store.session_counts)
        pend = len(await db(store.list_approvals, "pending"))
        lines = ["# TYPE byoa_active_sessions gauge", f"byoa_active_sessions {len(manager.active)}",
                 "# TYPE byoa_pending_approvals gauge", f"byoa_pending_approvals {pend}",
                 "# TYPE byoa_policy_decisions_total counter"]
        lines += [f'byoa_policy_decisions_total{{effect="{k}"}} {v}' for k, v in sorted(dec.items())]
        lines += ["# TYPE byoa_sessions_total counter"]
        lines += [f'byoa_sessions_total{{status="{k}"}} {v}' for k, v in sorted(ses.items())]
        return "\n".join(lines) + "\n"

    v1 = "/v1"

    # ------------------------------------------------------------------------------ agents
    @app.post(f"{v1}/agents", status_code=201, tags=["agents"], summary="Register an agent (new immutable version)")
    async def register_agent(body: AgentRegistration, p: Principal = Depends(need("developer"))):
        adapter = SHAPES.get(body.shape)
        if not adapter:
            raise HTTPException(422, f"unknown shape '{body.shape}'; supported: {sorted(SHAPES)}")
        manifest = {"shape": body.shape, "description": body.description,
                    **({"package": body.package} if body.package is not None else {}),
                    **({"spec": body.spec} if body.spec is not None else {}),
                    **({"resources": body.resources} if body.resources else {})}
        try:
            manifest = adapter.validate(manifest, settings)
        except ManifestError as e:
            raise HTTPException(422, str(e)) from e
        try:
            version = await db(store.create_agent_version, body.id, p.name, body.shape, manifest)
        except PermissionError as e:
            raise HTTPException(403, str(e)) from e
        await db(store.append_audit, f"agent:{body.id}", body.id, "agent.registered",
                 {"version": version, "shape": body.shape, "by": p.name})
        return {"id": body.id, "version": version, "shape": body.shape,
                "note": "agents run under deny-all until an admin attaches a policy"}

    @app.get(f"{v1}/agents", tags=["agents"])
    async def list_agents(p: Principal = Depends(need("developer", "auditor", "approver"))):
        rows = await db(store.list_agents, None if is_privileged(p) else p.name)
        return [{k: r[k] for k in ("id", "version", "shape", "owner", "created_at")} for r in rows]

    @app.get(f"{v1}/agents/{{agent_id}}", tags=["agents"])
    async def get_agent(agent_id: str, version: int | None = None,
                        p: Principal = Depends(need("developer", "auditor", "approver"))):
        a = await db(store.get_agent, agent_id, version)
        if not a or (not is_privileged(p) and a["owner"] != p.name):
            raise HTTPException(404, "agent not found")
        return {**a, "policies": await db(store.list_attachments, agent_id)}

    # ---------------------------------------------------------------------------- policies
    @app.post(f"{v1}/policies/validate", tags=["policies"], summary="Validate a policy document without storing it")
    async def validate_policy(body: PolicyUpload, _: Principal = Depends(need("auditor"))):
        try:
            pol = parse_policy(body.document)
        except PolicyError as e:
            raise HTTPException(422, str(e)) from e
        return {"valid": True, "id": pol.id, "rules": len(pol.rules), "content_hash": pol.content_hash}

    @app.post(f"{v1}/policies", status_code=201, tags=["policies"], summary="Create a new immutable policy version")
    async def create_policy(body: PolicyUpload, p: Principal = Depends(need())):
        try:
            pol = parse_policy(body.document)
        except PolicyError as e:
            raise HTTPException(422, str(e)) from e
        latest = await db(store.get_policy, pol.id)
        if latest and latest["content_hash"] == pol.content_hash:
            return JSONResponse({"id": pol.id, "version": latest["version"], "unchanged": True}, status_code=200)
        v = await db(store.create_policy_version, pol.id, body.document, pol.content_hash, p.name)
        await db(store.append_audit, f"policy:{pol.id}", "-", "policy.created",
                 {"policy_id": pol.id, "version": v, "content_hash": pol.content_hash, "by": p.name})
        return {"id": pol.id, "version": v, "content_hash": pol.content_hash}

    @app.get(f"{v1}/policies", tags=["policies"])
    async def list_policies(_: Principal = Depends(need("auditor"))):
        return await db(store.list_policy_versions)

    @app.get(f"{v1}/policies/{{policy_id}}", tags=["policies"])
    async def get_policy(policy_id: str, version: int | None = None, _: Principal = Depends(need("auditor"))):
        row = await db(store.get_policy, policy_id, version)
        if not row:
            raise HTTPException(404, "policy not found")
        return row

    @app.post(f"{v1}/policies/evaluate", tags=["policies"],
              summary="Evaluate one hypothetical action against policy documents (no agent involved)")
    async def evaluate_action(body: EvaluateRequest, _: Principal = Depends(need("auditor"))):
        try:
            pols = [parse_policy(d).with_version(0) for d in body.documents]
            a = body.action
            action = Action.build(a["type"], a["resource"], a.get("params"))
        except (PolicyError, KeyError, CanonicalizationError, TypeError) as e:
            raise HTTPException(422, f"invalid input: {e}") from e
        d = evaluate_all(pols, action, EvalContext(body.agent_id, "", body.spent_tokens, body.spent_amount,
                                                   body.action_count))
        return d.to_dict()

    @app.post(f"{v1}/policies/simulate", tags=["policies"],
              summary="Dry-run candidate policies against recorded actions (no agent is re-run)")
    async def simulate_policies(body: SimulateRequest, _: Principal = Depends(need("auditor"))):
        if bool(body.documents) == bool(body.policies):
            raise HTTPException(422, "provide exactly one of 'documents' or 'policies'")
        try:
            if body.documents:
                pols = [parse_policy(d).with_version(0) for d in body.documents]
            else:
                pols = []
                for ref in body.policies or []:
                    row = await db(store.get_policy, ref.id, ref.version)
                    if not row:
                        raise HTTPException(404, f"policy {ref.id} not found")
                    pols.append(parse_policy(row["document"]).with_version(row["version"]))
        except PolicyError as e:
            raise HTTPException(422, str(e)) from e
        rows = await db(store.query_audit, kind="action.decided", agent_id=body.agent_id,
                        session_id=body.session_id, since=body.since, limit=body.limit)
        hist, skipped = [], 0
        for r in rows:
            pl = r["payload"]
            if "action" not in pl or "type" not in pl["action"]:
                skipped += 1  # refusals that never became an Action, or truncated payloads
                continue
            hist.append(HistoricalAction(str(r["id"]), Action.from_dict(pl["action"]),
                                         EvalContext.from_dict(pl["context"]), r["effect"], r["rule_id"]))
        return {**simulate(pols, hist), "skipped": skipped}

    @app.post(f"{v1}/agents/{{agent_id}}/policies", status_code=201, tags=["policies"],
              summary="Attach a policy to an agent (admin only)")
    async def attach_policy(agent_id: str, body: Attach, p: Principal = Depends(need())):
        if not await db(store.get_agent, agent_id):
            raise HTTPException(404, "agent not found")
        row = await db(store.get_policy, body.policy_id, body.version)
        if not row:
            raise HTTPException(404, "policy not found")
        pol = parse_policy(row["document"])
        if pol.scope_agents and agent_id not in pol.scope_agents:
            raise HTTPException(422, f"policy scope does not include agent {agent_id}")
        await db(store.attach_policy, agent_id, body.policy_id, body.version, p.name)
        await db(store.append_audit, f"agent:{agent_id}", agent_id, "policy.attached",
                 {"policy_id": body.policy_id, "version": body.version or "latest", "by": p.name})
        return {"agent_id": agent_id, "policy_id": body.policy_id, "version": body.version or "latest"}

    @app.delete(f"{v1}/agents/{{agent_id}}/policies/{{policy_id}}", tags=["policies"])
    async def detach_policy(agent_id: str, policy_id: str, p: Principal = Depends(need())):
        if not await db(store.detach_policy, agent_id, policy_id):
            raise HTTPException(404, "attachment not found")
        await db(store.append_audit, f"agent:{agent_id}", agent_id, "policy.detached",
                 {"policy_id": policy_id, "by": p.name})
        return {"detached": True}

    # ---------------------------------------------------------------------------- sessions
    @app.post(f"{v1}/agents/{{agent_id}}/sessions", status_code=202, tags=["sessions"],
              summary="Submit a task; returns immediately with a session to poll or stream")
    async def submit(agent_id: str, body: TaskSubmission, p: Principal = Depends(need("developer"))):
        agent = await db(store.get_agent, agent_id)
        if agent and not is_privileged(p) and agent["owner"] != p.name:
            raise HTTPException(404, "agent not found")
        try:
            s = await manager.submit(agent_id, body.task, p.name, [r.model_dump() for r in body.policies],
                                     body.agent_version)
        except SubmitError as e:
            raise HTTPException(e.status, e.message) from e
        return _session_view(s)

    def _session_view(s: dict[str, Any]) -> dict[str, Any]:
        return {k: s[k] for k in ("id", "agent_id", "agent_version", "submitted_by", "status", "result", "error",
                                  "policies", "spent_tokens", "spent_amount", "action_count", "created_at",
                                  "started_at", "finished_at")}

    @app.get(f"{v1}/sessions", tags=["sessions"])
    async def list_sessions(agent_id: str | None = None, status: str | None = None, limit: int = Query(50, le=500),
                            p: Principal = Depends(need("developer", "auditor", "approver"))):
        rows = await db(store.list_sessions, agent_id, status, None if is_privileged(p) else p.name, limit)
        return [_session_view(r) for r in rows]

    @app.get(f"{v1}/sessions/{{sid}}", tags=["sessions"], summary="Poll a session: status, result, spend")
    async def get_session(sid: str, p: Principal = Depends(need("developer", "auditor", "approver"))):
        return _session_view(visible_session(p, await db(store.get_session, sid)))

    @app.delete(f"{v1}/sessions/{{sid}}", tags=["sessions"], summary="Cancel a session (kills its sandbox)")
    async def cancel(sid: str, p: Principal = Depends(need("developer"))):
        visible_session(p, await db(store.get_session, sid))
        return {"cancelled": await manager.cancel(sid)}

    @app.get(f"{v1}/sessions/{{sid}}/events", tags=["sessions"],
             summary="Server-sent events: live audit/progress stream until the session ends")
    async def stream(sid: str, request: Request, after: int = 0,
                     p: Principal = Depends(need("developer", "auditor", "approver"))):
        visible_session(p, await db(store.get_session, sid))

        async def gen():
            cursor = after
            while True:
                rows = await db(store.query_audit, session_id=sid, after_id=cursor, limit=200)
                for r in rows:
                    cursor = r["id"]
                    yield f"id: {r['id']}\nevent: {r['kind']}\ndata: {json.dumps(_event_view(r))}\n\n"
                if not rows:
                    row = await db(store.get_session, sid)
                    if row["status"] in TERMINAL:
                        yield f"event: end\ndata: {json.dumps({'status': row['status']})}\n\n"
                        return
                    yield ": keep-alive\n\n"
                    await asyncio.sleep(0.5)
                if await request.is_disconnected():
                    return
        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache"})

    # ------------------------------------------------------------------------------ audit
    def _event_view(r: dict[str, Any]) -> dict[str, Any]:
        return {k: r[k] for k in ("id", "session_id", "seq", "ts", "agent_id", "kind", "action_type", "resource",
                                  "effect", "rule_id", "policy_id", "policy_version", "payload", "hash")}

    @app.get(f"{v1}/audit", tags=["audit"], summary="Query the audit trail")
    async def audit(session_id: str | None = None, agent_id: str | None = None, kind: str | None = None,
                    effect: str | None = None, rule_id: str | None = None, action_type: str | None = None,
                    since: str | None = None, until: str | None = None, after_id: int = 0,
                    limit: int = Query(100, ge=1, le=1000), p: Principal = Depends(need("auditor", "approver"))):
        rows = await db(store.query_audit, session_id=session_id, agent_id=agent_id, kind=kind, effect=effect,
                        rule_id=rule_id, action_type=action_type, since=since, until=until, after_id=after_id,
                        limit=limit)
        return {"events": [_event_view(r) for r in rows], "next_after_id": rows[-1]["id"] if rows else after_id}

    @app.get(f"{v1}/audit/sessions/{{sid}}/verify", tags=["audit"], summary="Verify the session's hash chain")
    async def verify(sid: str, _: Principal = Depends(need("auditor"))):
        return await db(store.verify_chain, sid)

    @app.get(f"{v1}/sessions/{{sid}}/audit", tags=["sessions"], summary="This session's full decision trail")
    async def session_audit(sid: str, after_id: int = 0, limit: int = Query(200, ge=1, le=1000),
                            p: Principal = Depends(need("developer", "auditor", "approver"))):
        visible_session(p, await db(store.get_session, sid))
        rows = await db(store.query_audit, session_id=sid, after_id=after_id, limit=limit)
        return {"events": [_event_view(r) for r in rows], "next_after_id": rows[-1]["id"] if rows else after_id}

    # --------------------------------------------------------------------------- approvals
    def _approval_view(a: dict[str, Any]) -> dict[str, Any]:
        return {k: a[k] for k in ("id", "session_id", "agent_id", "submitted_by", "action", "action_digest",
                                  "rule_id", "policy_ref", "status", "requested_at", "expires_at", "decided_by",
                                  "decided_at", "comment")}

    @app.get(f"{v1}/approvals", tags=["approvals"])
    async def list_approvals(status: str | None = "pending", session_id: str | None = None,
                             _: Principal = Depends(need("approver", "auditor"))):
        return [_approval_view(a) for a in await db(store.list_approvals, status, session_id)]

    async def _decide(aid: str, approve: bool, body: Decision, p: Principal):
        try:
            return _approval_view(await approvals.decide(aid, approve, p.name, body.comment))
        except ApprovalError as e:
            raise HTTPException(e.status, e.message) from e

    @app.post(f"{v1}/approvals/{{aid}}/approve", tags=["approvals"], summary="Approve: resumes the paused agent")
    async def approve(aid: str, body: Decision = Decision(), p: Principal = Depends(need("approver"))):
        return await _decide(aid, True, body, p)

    @app.post(f"{v1}/approvals/{{aid}}/deny", tags=["approvals"], summary="Deny: the agent's call fails")
    async def deny(aid: str, body: Decision = Decision(), p: Principal = Depends(need("approver"))):
        return await _decide(aid, False, body, p)

    # ------------------------------------------------------------------------------- admin
    @app.get(f"{v1}/admin/overview", tags=["admin"],
             summary="Running sessions with sandbox resource usage, pending approvals, decision counts")
    async def overview(_: Principal = Depends(need("auditor", "approver"))):
        return {"active_sessions": await manager.admin_snapshot(),
                "pending_approvals": [_approval_view(a) for a in await db(store.list_approvals, "pending")],
                "decisions": await db(store.decision_counts), "sessions": await db(store.session_counts),
                "capacity": {"max_concurrent": settings.max_concurrent_sessions,
                             "max_queued": settings.max_queued_sessions}}

    return app

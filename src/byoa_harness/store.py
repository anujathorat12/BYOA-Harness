"""Persistence: SQLAlchemy Core, Postgres in production, SQLite for tests/dev.

All methods are synchronous; async code calls them through asyncio.to_thread.
"""
from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy import event as sa_event

from .policy import canonical_json
from .policy.canonical import sha256_hex

md = sa.MetaData()

agents = sa.Table(
    "agents", md,
    sa.Column("id", sa.String(64), primary_key=True),
    sa.Column("version", sa.Integer, primary_key=True),
    sa.Column("owner", sa.String(128), nullable=False),
    sa.Column("shape", sa.String(32), nullable=False),
    sa.Column("manifest", sa.JSON, nullable=False),
    sa.Column("created_at", sa.String(32), nullable=False),
)
policies = sa.Table(
    "policies", md,
    sa.Column("id", sa.String(64), primary_key=True),
    sa.Column("version", sa.Integer, primary_key=True),
    sa.Column("document", sa.Text, nullable=False),
    sa.Column("content_hash", sa.String(64), nullable=False),
    sa.Column("created_by", sa.String(128), nullable=False),
    sa.Column("created_at", sa.String(32), nullable=False),
)
attachments = sa.Table(
    "policy_attachments", md,
    sa.Column("agent_id", sa.String(64), primary_key=True),
    sa.Column("policy_id", sa.String(64), primary_key=True),
    sa.Column("policy_version", sa.Integer, nullable=True),  # NULL = follow latest at session start
    sa.Column("attached_by", sa.String(128), nullable=False),
    sa.Column("attached_at", sa.String(32), nullable=False),
)
sessions = sa.Table(
    "sessions", md,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("agent_id", sa.String(64), nullable=False, index=True),
    sa.Column("agent_version", sa.Integer, nullable=False),
    sa.Column("submitted_by", sa.String(128), nullable=False),
    sa.Column("status", sa.String(24), nullable=False, index=True),
    sa.Column("task", sa.JSON, nullable=False),
    sa.Column("result", sa.JSON),
    sa.Column("error", sa.Text),
    sa.Column("policies", sa.JSON, nullable=False),  # pinned [{id, version, source}]
    sa.Column("spent_tokens", sa.Integer, nullable=False, default=0),
    sa.Column("spent_amount", sa.Float, nullable=False, default=0.0),
    sa.Column("action_count", sa.Integer, nullable=False, default=0),
    sa.Column("created_at", sa.String(32), nullable=False),
    sa.Column("started_at", sa.String(32)),
    sa.Column("finished_at", sa.String(32)),
)
audit_events = sa.Table(
    "audit_events", md,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("session_id", sa.String(40), nullable=False),
    sa.Column("seq", sa.Integer, nullable=False),
    sa.Column("ts", sa.String(32), nullable=False),
    sa.Column("agent_id", sa.String(64), nullable=False),
    sa.Column("kind", sa.String(40), nullable=False),
    # denormalised for querying
    sa.Column("action_type", sa.String(128)),
    sa.Column("resource", sa.String(512)),
    sa.Column("effect", sa.String(24)),
    sa.Column("rule_id", sa.String(80)),
    sa.Column("policy_id", sa.String(64)),
    sa.Column("policy_version", sa.Integer),
    sa.Column("payload", sa.JSON, nullable=False),
    sa.Column("prev_hash", sa.String(64), nullable=False),
    sa.Column("hash", sa.String(64), nullable=False),
    sa.UniqueConstraint("session_id", "seq", name="uq_audit_session_seq"),
    sa.Index("ix_audit_agent_ts", "agent_id", "ts"),
    sa.Index("ix_audit_rule", "rule_id"),
    sa.Index("ix_audit_effect", "effect"),
)
approvals = sa.Table(
    "approvals", md,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("session_id", sa.String(40), nullable=False, index=True),
    sa.Column("agent_id", sa.String(64), nullable=False),
    sa.Column("submitted_by", sa.String(128), nullable=False),
    sa.Column("audit_ref", sa.Integer),
    sa.Column("action", sa.JSON, nullable=False),
    sa.Column("action_digest", sa.String(64), nullable=False),
    sa.Column("rule_id", sa.String(80), nullable=False),
    sa.Column("policy_ref", sa.String(80), nullable=False),
    sa.Column("status", sa.String(16), nullable=False, index=True),
    sa.Column("requested_at", sa.String(32), nullable=False),
    sa.Column("expires_at", sa.String(32), nullable=False),
    sa.Column("decided_by", sa.String(128)),
    sa.Column("decided_at", sa.String(32)),
    sa.Column("comment", sa.Text),
)

GENESIS = "0" * 64


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def event_hash(prev_hash: str, session_id: str, seq: int, ts: str, agent_id: str, kind: str,
               payload: dict[str, Any]) -> str:
    body = canonical_json({"s": session_id, "n": seq, "t": ts, "a": agent_id, "k": kind, "p": payload})
    return sha256_hex(prev_hash + body)


class Store:
    def __init__(self, url: str) -> None:
        kwargs: dict[str, Any] = {"pool_pre_ping": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
            if ":memory:" in url or url == "sqlite://":
                kwargs["poolclass"] = sa.pool.StaticPool
        self.engine = sa.create_engine(url, **kwargs)
        if url.startswith("sqlite"):
            @sa_event.listens_for(self.engine, "connect")
            def _pragmas(dbapi_conn, _):  # noqa: ANN001
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA synchronous=NORMAL")
                cur.close()
        self._chain_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def init_schema(self) -> None:
        md.create_all(self.engine)

    def ping(self) -> bool:
        with self.engine.connect() as c:
            c.execute(sa.text("SELECT 1"))
        return True

    # ------------------------------------------------------------------ agents
    def create_agent_version(self, agent_id: str, owner: str, shape: str, manifest: dict[str, Any]) -> int:
        with self.engine.begin() as c:
            cur = c.execute(sa.select(sa.func.max(agents.c.version)).where(agents.c.id == agent_id)).scalar()
            if cur is not None:
                existing = c.execute(sa.select(agents.c.owner).where(agents.c.id == agent_id)
                                     .limit(1)).scalar()
                if existing != owner:
                    raise PermissionError("agent id belongs to another owner")
            version = (cur or 0) + 1
            c.execute(agents.insert().values(id=agent_id, version=version, owner=owner, shape=shape,
                                             manifest=manifest, created_at=now_iso()))
            return version

    def get_agent(self, agent_id: str, version: int | None = None) -> dict[str, Any] | None:
        q = sa.select(agents).where(agents.c.id == agent_id)
        q = q.where(agents.c.version == version) if version else q.order_by(agents.c.version.desc()).limit(1)
        with self.engine.connect() as c:
            row = c.execute(q).mappings().first()
        return dict(row) if row else None

    def list_agents(self, owner: str | None = None) -> list[dict[str, Any]]:
        latest = sa.select(agents.c.id, sa.func.max(agents.c.version).label("v")).group_by(agents.c.id).subquery()
        q = sa.select(agents).join(latest, sa.and_(agents.c.id == latest.c.id, agents.c.version == latest.c.v))
        if owner:
            q = q.where(agents.c.owner == owner)
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(q.order_by(agents.c.id)).mappings()]

    # ---------------------------------------------------------------- policies
    def create_policy_version(self, policy_id: str, document: str, content_hash: str, by: str) -> int:
        with self.engine.begin() as c:
            cur = c.execute(sa.select(sa.func.max(policies.c.version)).where(policies.c.id == policy_id)).scalar()
            version = (cur or 0) + 1
            c.execute(policies.insert().values(id=policy_id, version=version, document=document,
                                               content_hash=content_hash, created_by=by, created_at=now_iso()))
            return version

    def get_policy(self, policy_id: str, version: int | None = None) -> dict[str, Any] | None:
        q = sa.select(policies).where(policies.c.id == policy_id)
        q = q.where(policies.c.version == version) if version else q.order_by(policies.c.version.desc()).limit(1)
        with self.engine.connect() as c:
            row = c.execute(q).mappings().first()
        return dict(row) if row else None

    def list_policy_versions(self, policy_id: str | None = None) -> list[dict[str, Any]]:
        q = sa.select(policies.c.id, policies.c.version, policies.c.content_hash, policies.c.created_by,
                      policies.c.created_at).order_by(policies.c.id, policies.c.version)
        if policy_id:
            q = q.where(policies.c.id == policy_id)
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(q).mappings()]

    def attach_policy(self, agent_id: str, policy_id: str, version: int | None, by: str) -> None:
        with self.engine.begin() as c:
            c.execute(attachments.delete().where(sa.and_(attachments.c.agent_id == agent_id,
                                                         attachments.c.policy_id == policy_id)))
            c.execute(attachments.insert().values(agent_id=agent_id, policy_id=policy_id,
                                                  policy_version=version, attached_by=by, attached_at=now_iso()))

    def detach_policy(self, agent_id: str, policy_id: str) -> bool:
        with self.engine.begin() as c:
            return c.execute(attachments.delete().where(sa.and_(
                attachments.c.agent_id == agent_id, attachments.c.policy_id == policy_id))).rowcount > 0

    def list_attachments(self, agent_id: str) -> list[dict[str, Any]]:
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(
                sa.select(attachments).where(attachments.c.agent_id == agent_id)
                .order_by(attachments.c.policy_id)).mappings()]

    # ---------------------------------------------------------------- sessions
    def create_session(self, agent_id: str, agent_version: int, submitted_by: str, task: dict[str, Any],
                       pinned: list[dict[str, Any]]) -> str:
        sid = new_id("ses")
        with self.engine.begin() as c:
            c.execute(sessions.insert().values(
                id=sid, agent_id=agent_id, agent_version=agent_version, submitted_by=submitted_by,
                status="queued", task=task, policies=pinned, spent_tokens=0, spent_amount=0.0,
                action_count=0, created_at=now_iso()))
        return sid

    def update_session(self, sid: str, **fields: Any) -> None:
        with self.engine.begin() as c:
            c.execute(sessions.update().where(sessions.c.id == sid).values(**fields))

    def finish_session_if_active(self, sid: str, status: str, **fields: Any) -> bool:
        """Terminal transition that never overwrites an already-terminal status."""
        with self.engine.begin() as c:
            r = c.execute(sessions.update().where(sa.and_(
                sessions.c.id == sid, sessions.c.status.in_(("queued", "running")))).values(
                status=status, finished_at=now_iso(), **fields))
            return r.rowcount > 0

    def bump_session(self, sid: str, tokens: int = 0, amount: float = 0.0, actions: int = 0) -> None:
        with self.engine.begin() as c:
            c.execute(sessions.update().where(sessions.c.id == sid).values(
                spent_tokens=sessions.c.spent_tokens + tokens,
                spent_amount=sessions.c.spent_amount + amount,
                action_count=sessions.c.action_count + actions))

    def get_session(self, sid: str) -> dict[str, Any] | None:
        with self.engine.connect() as c:
            row = c.execute(sa.select(sessions).where(sessions.c.id == sid)).mappings().first()
        return dict(row) if row else None

    def list_sessions(self, agent_id: str | None = None, status: str | None = None,
                      submitted_by: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        q = sa.select(sessions).order_by(sessions.c.created_at.desc()).limit(min(limit, 500))
        for col, val in ((sessions.c.agent_id, agent_id), (sessions.c.status, status),
                         (sessions.c.submitted_by, submitted_by)):
            if val:
                q = q.where(col == val)
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(q).mappings()]

    def fail_orphaned_sessions(self) -> list[str]:
        """Called at startup: anything left running/queued belonged to a dead process."""
        with self.engine.begin() as c:
            ids = [r[0] for r in c.execute(sa.select(sessions.c.id).where(
                sessions.c.status.in_(("queued", "running"))))]
            if ids:
                c.execute(sessions.update().where(sessions.c.id.in_(ids)).values(
                    status="failed", error="harness restarted while session was active", finished_at=now_iso()))
            return ids

    # ------------------------------------------------------------------- audit
    def _lock_for(self, session_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._chain_locks.setdefault(session_id, threading.Lock())

    def append_audit(self, session_id: str, agent_id: str, kind: str, payload: dict[str, Any], *,
                     action_type: str | None = None, resource: str | None = None, effect: str | None = None,
                     rule_id: str | None = None, policy_id: str | None = None,
                     policy_version: int | None = None) -> dict[str, Any]:
        """Append one hash-chained event. Raises on failure: callers on the enforcement path must fail closed."""
        canonical_json(payload)  # refuse non-canonical payloads up front
        with self._lock_for(session_id), self.engine.begin() as c:
            last = c.execute(sa.select(audit_events.c.seq, audit_events.c.hash).where(
                audit_events.c.session_id == session_id).order_by(audit_events.c.seq.desc()).limit(1)).first()
            seq, prev = (last[0] + 1, last[1]) if last else (1, GENESIS)
            ts = now_iso()
            h = event_hash(prev, session_id, seq, ts, agent_id, kind, payload)
            res = c.execute(audit_events.insert().values(
                session_id=session_id, seq=seq, ts=ts, agent_id=agent_id, kind=kind, action_type=action_type,
                resource=resource, effect=effect, rule_id=rule_id, policy_id=policy_id,
                policy_version=policy_version, payload=payload, prev_hash=prev, hash=h))
            return {"id": res.inserted_primary_key[0], "session_id": session_id, "seq": seq, "ts": ts,
                    "agent_id": agent_id, "kind": kind, "hash": h}

    def query_audit(self, *, session_id: str | None = None, agent_id: str | None = None,
                    kind: str | None = None, effect: str | None = None, rule_id: str | None = None,
                    action_type: str | None = None, since: str | None = None, until: str | None = None,
                    after_id: int = 0, limit: int = 100) -> list[dict[str, Any]]:
        q = sa.select(audit_events).where(audit_events.c.id > after_id).order_by(audit_events.c.id).limit(
            min(max(limit, 1), 1000))
        for col, val in ((audit_events.c.session_id, session_id), (audit_events.c.agent_id, agent_id),
                         (audit_events.c.kind, kind), (audit_events.c.effect, effect),
                         (audit_events.c.rule_id, rule_id), (audit_events.c.action_type, action_type)):
            if val:
                q = q.where(col == val)
        if since:
            q = q.where(audit_events.c.ts >= since)
        if until:
            q = q.where(audit_events.c.ts <= until)
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(q).mappings()]

    def verify_chain(self, session_id: str) -> dict[str, Any]:
        with self.engine.connect() as c:
            rows = list(c.execute(sa.select(audit_events).where(audit_events.c.session_id == session_id)
                                  .order_by(audit_events.c.seq)).mappings())
        prev, expected_seq = GENESIS, 1
        for r in rows:
            if r["seq"] != expected_seq:
                return {"valid": False, "events": len(rows), "broken_at_seq": expected_seq,
                        "reason": "missing or reordered event"}
            if r["prev_hash"] != prev or r["hash"] != event_hash(prev, r["session_id"], r["seq"], r["ts"],
                                                                 r["agent_id"], r["kind"], r["payload"]):
                return {"valid": False, "events": len(rows), "broken_at_seq": r["seq"], "reason": "hash mismatch"}
            prev, expected_seq = r["hash"], expected_seq + 1
        return {"valid": True, "events": len(rows), "head_hash": prev}

    # --------------------------------------------------------------- approvals
    def create_approval(self, session_id: str, agent_id: str, submitted_by: str, audit_ref: int | None,
                        action: dict[str, Any], digest: str, rule_id: str, policy_ref: str,
                        timeout_s: int) -> str:
        aid = new_id("apr")
        expires = (datetime.now(UTC) + timedelta(seconds=timeout_s)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        with self.engine.begin() as c:
            c.execute(approvals.insert().values(
                id=aid, session_id=session_id, agent_id=agent_id, submitted_by=submitted_by,
                audit_ref=audit_ref, action=action, action_digest=digest, rule_id=rule_id,
                policy_ref=policy_ref, status="pending", requested_at=now_iso(), expires_at=expires))
        return aid

    def get_approval(self, aid: str) -> dict[str, Any] | None:
        with self.engine.connect() as c:
            row = c.execute(sa.select(approvals).where(approvals.c.id == aid)).mappings().first()
        return dict(row) if row else None

    def list_approvals(self, status: str | None = None, session_id: str | None = None) -> list[dict[str, Any]]:
        q = sa.select(approvals).order_by(approvals.c.requested_at.desc()).limit(500)
        if status:
            q = q.where(approvals.c.status == status)
        if session_id:
            q = q.where(approvals.c.session_id == session_id)
        with self.engine.connect() as c:
            return [dict(r) for r in c.execute(q).mappings()]

    def decide_approval(self, aid: str, status: str, by: str, comment: str | None) -> bool:
        """Atomic pending -> terminal transition. Returns False if it was already decided."""
        with self.engine.begin() as c:
            r = c.execute(approvals.update().where(sa.and_(approvals.c.id == aid, approvals.c.status == "pending"))
                          .values(status=status, decided_by=by, decided_at=now_iso(), comment=comment))
            return r.rowcount == 1

    def expire_stale_approvals(self) -> int:
        """Fail closed: anything still pending from a previous process is denied."""
        with self.engine.begin() as c:
            return c.execute(approvals.update().where(approvals.c.status == "pending").values(
                status="expired", decided_by="harness", decided_at=now_iso(),
                comment="harness restarted while approval was pending")).rowcount

import threading

import pytest
import sqlalchemy as sa

from byoa_harness import store as st


@pytest.fixture
def db(tmp_path):
    s = st.Store(f"sqlite:///{tmp_path / 't.db'}")
    s.init_schema()
    return s


def test_chain_valid_and_queryable_by_rule(db):
    db.append_audit("s1", "a1", "action.decided", {"n": 1}, effect="deny", rule_id="r-x", action_type="t",
                    resource="res", policy_id="p", policy_version=3)
    db.append_audit("s1", "a1", "action.decided", {"n": 2}, effect="allow", rule_id="r-y")
    assert db.verify_chain("s1") == {"valid": True, "events": 2, "head_hash": db.query_audit(session_id="s1")[-1]["hash"]}
    rows = db.query_audit(rule_id="r-x")
    assert len(rows) == 1 and rows[0]["policy_version"] == 3 and rows[0]["effect"] == "deny"


def test_tampering_detected(db):
    for i in range(3):
        db.append_audit("s1", "a1", "k", {"i": i})
    with db.engine.begin() as c:
        c.execute(st.audit_events.update().where(st.audit_events.c.seq == 2).values(payload={"i": 999}))
    v = db.verify_chain("s1")
    assert v["valid"] is False and v["broken_at_seq"] == 2


def test_deleted_middle_event_detected(db):
    for i in range(3):
        db.append_audit("s1", "a1", "k", {"i": i})
    with db.engine.begin() as c:
        c.execute(st.audit_events.delete().where(st.audit_events.c.seq == 2))
    assert db.verify_chain("s1")["valid"] is False


def test_concurrent_appends_keep_chain_intact_and_sessions_independent(db):
    def worker(sid):
        for i in range(25):
            db.append_audit(sid, "a", "k", {"i": i})
    ts = [threading.Thread(target=worker, args=(f"s{n}",)) for n in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    for n in range(6):
        v = db.verify_chain(f"s{n}")
        assert v["valid"] and v["events"] == 25


def test_non_canonical_payload_refused(db):
    with pytest.raises(ValueError):
        db.append_audit("s1", "a", "k", {"x": float("nan")})


def test_policy_versions_are_immutable_and_monotonic(db):
    assert db.create_policy_version("p", "doc1", "h1", "admin") == 1
    assert db.create_policy_version("p", "doc2", "h2", "admin") == 2
    assert db.get_policy("p")["document"] == "doc2"
    assert db.get_policy("p", 1)["document"] == "doc1"
    assert [v["version"] for v in db.list_policy_versions("p")] == [1, 2]


def test_agent_versions_and_owner_protection(db):
    assert db.create_agent_version("bot", "alice", "package", {"a": 1}) == 1
    assert db.create_agent_version("bot", "alice", "package", {"a": 2}) == 2
    with pytest.raises(PermissionError):
        db.create_agent_version("bot", "mallory", "package", {})
    assert db.get_agent("bot")["version"] == 2 and db.get_agent("bot", 1)["manifest"] == {"a": 1}


def test_approval_decides_once_atomically(db):
    aid = db.create_approval("s", "a", "alice", None, {"type": "t"}, "d" * 64, "r", "p@1", 60)
    results = []
    ts = [threading.Thread(target=lambda st_=s: results.append(db.decide_approval(aid, st_, "bob", None)))
          for s in ("approved", "denied", "approved", "denied")]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert results.count(True) == 1
    assert db.get_approval(aid)["status"] in ("approved", "denied")


def test_restart_fails_closed(db):
    sid = db.create_session("a", 1, "alice", {}, [])
    db.update_session(sid, status="running")
    aid = db.create_approval(sid, "a", "alice", None, {}, "d" * 64, "r", "p@1", 60)
    assert db.fail_orphaned_sessions() == [sid]
    assert db.expire_stale_approvals() == 1
    assert db.get_session(sid)["status"] == "failed"
    assert db.get_approval(aid)["status"] == "expired"


def test_terminal_status_never_overwritten(db):
    sid = db.create_session("a", 1, "alice", {}, [])
    db.update_session(sid, status="running")
    assert db.finish_session_if_active(sid, "succeeded", result={"ok": 1}) is True
    assert db.finish_session_if_active(sid, "failed", error="late") is False
    assert db.get_session(sid)["status"] == "succeeded"

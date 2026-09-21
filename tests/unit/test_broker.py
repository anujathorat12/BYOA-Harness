"""Broker (PEP) tests: enforcement semantics without any sandbox."""
import asyncio
from pathlib import Path

import pytest

from byoa_harness import store as st
from byoa_harness.approvals import ApprovalError, ApprovalService
from byoa_harness.broker.broker import Broker, SessionGov
from byoa_harness.broker.llm import MockLlm
from byoa_harness.broker.tools import Backends, ToolContext, default_tools
from byoa_harness.config import Settings
from byoa_harness.policy import parse_policy

EX = Path(__file__).resolve().parents[2] / "examples" / "policies"


def policy(name, version=1):
    return parse_policy((EX / f"{name}.yaml").read_text()).with_version(version)


@pytest.fixture
def env(tmp_path):
    s = Settings(approval_timeout_s=5)
    store = st.Store(f"sqlite:///{tmp_path / 'b.db'}")
    store.init_schema()
    backends = Backends()
    approvals = ApprovalService(store, s)
    broker = Broker(store, s, default_tools(), ToolContext(backends, MockLlm()), approvals)

    def gov(pols, submitter="alice"):
        sid = store.create_session("agent", 1, submitter, {}, [])
        return SessionGov(sid, "agent", submitter, pols, store)

    return type("E", (), {"store": store, "backends": backends, "approvals": approvals, "broker": broker,
                          "gov": staticmethod(gov), "settings": s})


def call(tool, **args):
    return {"id": "c1", "tool": tool, "args": args}


async def test_allow_executes_and_audits_decision_before_outcome(env):
    g = env.gov([policy("enterprise-it")])
    r = await env.broker.handle_call(g, call("data.read", dataset="prod.logs"))
    assert r["ok"] and len(r["result"]["records"]) == 5
    kinds = [e["kind"] for e in env.store.query_audit(session_id=g.session_id)]
    assert kinds == ["action.decided", "action.executed"]
    dec = env.store.query_audit(session_id=g.session_id)[0]
    assert (dec["effect"], dec["rule_id"], dec["policy_id"], dec["policy_version"]) == \
           ("allow", "allow-read-logs", "enterprise-it", 1)
    assert env.store.verify_chain(g.session_id)["valid"]


async def test_deny_never_reaches_resource_and_names_rule(env):
    g = env.gov([policy("enterprise-it")])
    r = await env.broker.handle_call(g, call("production.delete", service="payments-db"))
    assert not r["ok"] and r["error"]["code"] == "policy_denied" and r["error"]["rule_id"] == "never-delete-prod"
    assert env.backends.prod_deleted == []
    assert [e["kind"] for e in env.store.query_audit(session_id=g.session_id)] == ["action.decided"]


async def test_no_policy_attached_denies_everything(env):
    g = env.gov([])
    r = await env.broker.handle_call(g, call("ticket.create", title="x"))
    assert r["error"]["rule_id"] == "no-policy" and env.backends.tickets == []


async def test_unknown_tool_and_malformed_calls_are_audited_denials(env):
    g = env.gov([policy("enterprise-it")])
    r1 = await env.broker.handle_call(g, call("shell.exec", cmd="rm -rf /"))
    r2 = await env.broker.handle_call(g, {"id": "x", "tool": 5, "args": []})
    assert r1["error"]["rule_id"] == "harness:unknown-tool" and r2["error"]["rule_id"] == "harness:malformed-call"
    assert len(env.store.query_audit(session_id=g.session_id, effect="deny")) == 2


async def test_agent_cannot_choose_action_type_or_resource(env):
    g = env.gov([policy("enterprise-it")])
    # tries to smuggle a benign type/resource on a destructive tool
    r = await env.broker.handle_call(g, call("production.delete", service="db", type="data.read", resource="prod.logs"))
    assert r["error"]["rule_id"] == "harness:invalid-arguments" and env.backends.prod_deleted == []


@pytest.mark.parametrize("amount", ["5000", None, -5, 0, float("inf"), True])
async def test_payment_type_confusion_is_rejected_not_allowed(env, amount):
    g = env.gov([policy("financial-ops")])
    r = await env.broker.handle_call(g, call("payment.transfer", to="acct", amount=amount))
    assert not r["ok"] and env.backends.ledger == []


async def test_audit_failure_fails_closed_no_execution(env, monkeypatch):
    g = env.gov([policy("enterprise-it")])

    def boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(env.store, "append_audit", boom)
    r = await env.broker.handle_call(g, call("ticket.create", title="t"))
    assert r["error"]["code"] == "audit_unavailable" and env.backends.tickets == []


async def test_engine_exception_becomes_deny(env, monkeypatch):
    import byoa_harness.broker.broker as bmod
    monkeypatch.setattr(bmod, "evaluate_all", lambda *a: (_ for _ in ()).throw(RuntimeError("bug")))
    g = env.gov([policy("enterprise-it")])
    r = await env.broker.handle_call(g, call("ticket.create", title="t"))
    assert r["error"]["rule_id"] == "harness:engine-error" and env.backends.tickets == []


# ---- approvals: real pause / resume ----------------------------------------------------------------
async def _pending(env, sid):
    for _ in range(100):
        p = env.store.list_approvals("pending", sid)
        if p:
            return p[0]
        await asyncio.sleep(0.02)
    raise AssertionError("no approval appeared")


async def test_approval_blocks_until_approved_then_executes(env):
    events = []
    g = env.gov([policy("enterprise-it")])

    async def pause():
        events.append("pause")

    async def resume():
        events.append("resume")
    g.on_pause, g.on_resume = pause, resume
    task = asyncio.create_task(env.broker.handle_call(g, call("production.modify", service="api", change="scale=5")))
    apr = await _pending(env, g.session_id)
    await asyncio.sleep(0.2)
    assert not task.done() and env.backends.prod_changes == [] and events == ["pause"]  # genuinely paused
    await env.approvals.decide(apr["id"], True, "bob", "ok")
    r = await asyncio.wait_for(task, 2)
    assert r["ok"] and env.backends.prod_changes == [{"service": "api", "change": "scale=5"}]
    assert events == ["pause", "resume"]
    kinds = [e["kind"] for e in env.store.query_audit(session_id=g.session_id)]
    assert kinds == ["action.decided", "approval.requested", "approval.resolved", "action.executed"]


async def test_approval_denied_never_executes(env):
    g = env.gov([policy("enterprise-it")])
    task = asyncio.create_task(env.broker.handle_call(g, call("production.modify", service="api", change="x")))
    apr = await _pending(env, g.session_id)
    await env.approvals.decide(apr["id"], False, "bob", "no")
    r = await asyncio.wait_for(task, 2)
    assert r["error"]["code"] == "approval_denied" and env.backends.prod_changes == []


async def test_approval_timeout_denies(env):
    svc = ApprovalService(env.store, Settings(approval_timeout_s=1))
    env.broker.approvals = svc
    g = env.gov([policy("enterprise-it")])
    r = await asyncio.wait_for(env.broker.handle_call(g, call("production.modify", service="api", change="x")), 4)
    assert r["error"]["code"] == "approval_expired" and env.backends.prod_changes == []
    assert env.store.list_approvals("expired")


async def test_separation_of_duties_and_double_decision(env):
    g = env.gov([policy("enterprise-it")], submitter="alice")
    task = asyncio.create_task(env.broker.handle_call(g, call("production.modify", service="api", change="x")))
    apr = await _pending(env, g.session_id)
    with pytest.raises(ApprovalError) as e:
        await env.approvals.decide(apr["id"], True, "alice", None)  # submitter approving own action
    assert e.value.status == 403 and not task.done()
    await env.approvals.decide(apr["id"], True, "bob", None)
    with pytest.raises(ApprovalError) as e2:
        await env.approvals.decide(apr["id"], False, "carol", None)
    assert e2.value.status == 409
    assert (await asyncio.wait_for(task, 2))["ok"]


async def test_cancelled_session_expires_pending_approval(env):
    g = env.gov([policy("enterprise-it")])
    task = asyncio.create_task(env.broker.handle_call(g, call("production.modify", service="api", change="x")))
    apr = await _pending(env, g.session_id)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert env.store.get_approval(apr["id"])["status"] == "expired" and env.backends.prod_changes == []


# ---- budgets, concurrency ----------------------------------------------------------------------------
async def test_concurrent_calls_cannot_race_past_budget(env):
    # each mock llm call reserves prompt_tokens + max_tokens; budget of 20000 admits a bounded number
    from byoa_harness.broker.llm import LlmResult

    class FullUsageLlm:  # reports exactly the reserved worst case, and yields so calls truly overlap
        name = "fixed"

        async def complete(self, prompt, max_tokens):
            await asyncio.sleep(0.01)
            return LlmResult("x", 1100)
    env.broker.tool_ctx.llm = FullUsageLlm()
    g = env.gov([policy("financial-ops")])
    results = await asyncio.gather(*[
        env.broker.handle_call(g, {"id": str(i), "tool": "llm.complete",
                                   "args": {"prompt": "x" * 400, "max_tokens": 1000}}) for i in range(40)])
    ok = sum(r["ok"] for r in results)
    denied = [r for r in results if not r["ok"]]
    assert ok == 18 and all(r["error"]["rule_id"] == "budget:tokens" for r in denied)  # 18 * 1100 <= 20000 < 19 * 1100
    assert g.spent_tokens <= 20000


async def test_session_policy_can_only_narrow_agent_policy(env):
    narrow = parse_policy("id: readonly\nrules:\n - {id: r, decision: allow, match: {type: data.read}}").with_version(1)
    g = env.gov([policy("enterprise-it"), narrow])
    assert (await env.broker.handle_call(g, call("data.read", dataset="prod.logs")))["ok"]
    r = await env.broker.handle_call(g, call("ticket.create", title="t"))
    assert r["error"]["code"] == "policy_denied" and env.backends.tickets == []


async def test_max_actions_limit_counts_attempts_including_denied(env):
    g = env.gov([policy("enterprise-it")])
    for _ in range(50):
        await env.broker.handle_call(g, call("production.delete", service="x"))  # all denied, all counted
    r = await env.broker.handle_call(g, call("data.read", dataset="prod.logs"))
    assert r["error"]["rule_id"] == "limit:max_actions"


async def test_tool_error_is_audited_and_does_not_leak_internals(env):
    g = env.gov([parse_policy("id: p\nrules:\n - {id: a, decision: allow, match: {type: data.read}}").with_version(1)])
    r = await env.broker.handle_call(g, call("data.read", dataset="nope"))
    assert r["error"]["code"] == "tool_error"
    assert env.store.query_audit(session_id=g.session_id, kind="action.failed")

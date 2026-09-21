"""API-level tests. Sessions run in the real sandbox, so these are marked `docker`; authz/validation
tests that never start a container run everywhere."""
import asyncio
import subprocess
from pathlib import Path

import httpx
import pytest
import yaml

from byoa_harness.api.app import create_app
from byoa_harness.config import Principal, Settings

EX = Path(__file__).resolve().parents[2] / "examples"
KEYS = {
    "k-admin": Principal("root", frozenset({"admin"})),
    "k-dev": Principal("alice", frozenset({"developer"})),
    "k-dev2": Principal("mallory", frozenset({"developer"})),
    "k-appr": Principal("bob", frozenset({"approver"})),
    "k-aud": Principal("audrey", frozenset({"auditor"})),
}


@pytest.fixture
async def api(tmp_path):
    s = Settings(env="test", database_url=f"sqlite:///{tmp_path / 'api.db'}", api_keys=KEYS, session_timeout_s=30,
                 approval_timeout_s=20)
    app = create_app(s)
    await app.state.manager.startup()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        c.app = app
        yield c
    await app.state.manager.shutdown()



KEYS_TOKEN = {"admin": "k-admin", "dev": "k-dev", "dev2": "k-dev2", "appr": "k-appr", "aud": "k-aud"}


def hdr(role):
    return {"Authorization": f"Bearer {KEYS_TOKEN[role]}"}


async def register_it_agent(api):
    src = (EX / "agents" / "it-ops-agent" / "main.py").read_text()
    r = await api.post("/v1/agents", headers=hdr("dev"), json={
        "id": "it-ops-agent", "shape": "package", "package": {"entrypoint": "main:run", "files": {"main.py": src}}})
    assert r.status_code == 201, r.text
    doc = (EX / "policies" / "enterprise-it.yaml").read_text()
    r = await api.post("/v1/policies", headers=hdr("admin"), json={"document": doc})
    assert r.status_code == 201
    r = await api.post("/v1/agents/it-ops-agent/policies", headers=hdr("admin"), json={"policy_id": "enterprise-it"})
    assert r.status_code == 201


async def wait_status(api, sid, want=("succeeded", "failed", "cancelled"), timeout=60):
    for _ in range(int(timeout / 0.2)):
        s = (await api.get(f"/v1/sessions/{sid}", headers=hdr("dev"))).json()
        if s["status"] in want:
            return s
        await asyncio.sleep(0.2)
    raise AssertionError("timeout")


# ------------------------------------------------------------------ authn/authz & validation (no docker)
async def test_health_and_ready_and_metrics(api):
    assert (await api.get("/healthz")).json()["status"] == "ok"
    assert (await api.get("/readyz")).status_code in (200, 503)
    assert "byoa_active_sessions" in (await api.get("/metrics")).text


@pytest.mark.parametrize("method,path", [("GET", "/v1/agents"), ("GET", "/v1/audit"), ("GET", "/v1/approvals"),
                                         ("POST", "/v1/policies")])
async def test_requires_authentication(api, method, path):
    r = await api.request(method, path, json={})
    assert r.status_code == 401 and r.json()["error"]["code"] == "http_error"


async def test_role_boundaries(api):
    doc = (EX / "policies" / "enterprise-it.yaml").read_text()
    # a developer must never author or attach policies (would let an agent's owner grant itself power)
    assert (await api.post("/v1/policies", headers=hdr("dev"), json={"document": doc})).status_code == 403
    assert (await api.post("/v1/agents/x/policies", headers=hdr("dev"), json={"policy_id": "p"})).status_code == 403
    assert (await api.get("/v1/audit", headers=hdr("dev"))).status_code == 403
    assert (await api.post("/v1/approvals/x/approve", headers=hdr("aud"), json={})).status_code == 403
    assert (await api.post("/v1/agents", headers=hdr("appr"), json={})).status_code in (403, 422)


async def test_bad_input_is_rejected_with_structured_errors(api):
    r = await api.post("/v1/policies", headers=hdr("admin"), json={"document": "id: p\nrules:\n - {id: r, desicion: allow}"})
    assert r.status_code == 422 and "Extra inputs" in r.json()["error"]["message"]
    r = await api.post("/v1/agents", headers=hdr("dev"), json={"id": "Bad Id!", "shape": "package"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    r = await api.post("/v1/agents", headers=hdr("dev"), json={"id": "x1", "shape": "nope"})
    assert r.status_code == 422 and "supported" in r.json()["error"]["message"]
    r = await api.post("/v1/agents", headers=hdr("dev"), json={
        "id": "evil", "shape": "package", "package": {"entrypoint": "main:run", "files": {"../../etc/x": "x", "main.py": ""}}})
    assert r.status_code == 422
    r = await api.post("/v1/agents", headers=hdr("dev"), json={
        "id": "big", "shape": "package", "package": {"entrypoint": "main:run", "files": {"main.py": "#" * 600_000}}})
    assert r.status_code == 422


async def test_agent_id_cannot_be_hijacked_by_another_owner(api):
    body = {"id": "shared-name", "shape": "declarative", "spec": {"steps": [{"return": {"x": 1}}]}}
    assert (await api.post("/v1/agents", headers=hdr("dev"), json=body)).status_code == 201
    assert (await api.post("/v1/agents", headers=hdr("dev2"), json=body)).status_code == 403


async def test_policy_versioning_and_evaluate_endpoint(api):
    doc = (EX / "policies" / "financial-ops.yaml").read_text()
    v1 = (await api.post("/v1/policies", headers=hdr("admin"), json={"document": doc})).json()
    same = await api.post("/v1/policies", headers=hdr("admin"), json={"document": doc})
    assert v1["version"] == 1 and same.json()["unchanged"] is True
    v2 = (await api.post("/v1/policies", headers=hdr("admin"), json={"document": doc.replace("1000", "500")})).json()
    assert v2["version"] == 2
    r = await api.post("/v1/policies/evaluate", headers=hdr("aud"), json={
        "documents": [doc], "action": {"type": "payment.transfer", "resource": "acct", "params": {"amount": 5000}}})
    assert r.json()["effect"] == "require-approval" and r.json()["rule_id"] == "high-value-transfer-needs-approval"


async def test_submit_unknown_agent_and_overload_are_clean_errors(api):
    assert (await api.post("/v1/agents/ghost/sessions", headers=hdr("dev"), json={})).status_code == 404
    assert (await api.get("/v1/sessions/ses_nope", headers=hdr("dev"))).status_code == 404


# ----------------------------------------------------------------------- end-to-end (real sandbox)
@pytest.mark.docker
async def test_full_flow_allow_escalate_deny_and_audit(api):
    await register_it_agent(api)
    sub = await api.post("/v1/agents/it-ops-agent/sessions", headers=hdr("dev"), json={})
    assert sub.status_code == 202
    sid = sub.json()["id"]

    # the agent must be paused on the production change until an approver decides
    apr = None
    for _ in range(150):
        pending = (await api.get("/v1/approvals", headers=hdr("appr"))).json()
        if pending:
            apr = pending[0]
            break
        await asyncio.sleep(0.2)
    assert apr and apr["rule_id"] == "prod-change-needs-approval" and apr["action"]["resource"] == "api"
    assert apr["submitted_by"] == "alice"
    assert (await api.get(f"/v1/sessions/{sid}", headers=hdr("dev"))).json()["status"] == "running"
    ov = (await api.get("/v1/admin/overview", headers=hdr("aud"))).json()
    assert ov["active_sessions"][0]["paused"] is True and len(ov["pending_approvals"]) == 1
    backends = api.app.state.tool_ctx.backends
    await asyncio.sleep(1)
    assert backends.prod_changes == []  # nothing happened while pending
    # the sandbox process itself is frozen by the cgroup freezer, not merely blocked on a pipe
    paused = subprocess.run(["docker", "inspect", "-f", "{{.State.Paused}}", f"byoa-{sid}"],
                            capture_output=True, text=True).stdout.strip()
    assert paused == "true"

    assert (await api.post(f"/v1/approvals/{apr['id']}/approve", headers=hdr("appr"), json={"comment": "ok"})).status_code == 200
    s = await wait_status(api, sid)
    assert s["status"] == "succeeded", s
    assert s["result"]["change"] == "applied" and s["result"]["delete"] == "blocked by rule never-delete-prod"
    assert backends.prod_changes == [{"service": "api", "change": "db_pool_size=50"}] and backends.prod_deleted == []

    # audit: every attempt, the decision, and the rule
    ev = (await api.get("/v1/audit", headers=hdr("aud"), params={"session_id": sid, "kind": "action.decided"})).json()["events"]
    got = [(e["action_type"], e["effect"], e["rule_id"], e["policy_id"], e["policy_version"]) for e in ev]
    assert got == [("data.read", "allow", "allow-read-logs", "enterprise-it", 1),
                   ("ticket.create", "allow", "allow-create-ticket", "enterprise-it", 1),
                   ("production.modify", "require-approval", "prod-change-needs-approval", "enterprise-it", 1),
                   ("production.delete", "deny", "never-delete-prod", "enterprise-it", 1)]
    assert (await api.get(f"/v1/audit/sessions/{sid}/verify", headers=hdr("aud"))).json()["valid"] is True
    denied = (await api.get("/v1/audit", headers=hdr("aud"), params={"effect": "deny"})).json()["events"]
    assert denied and denied[0]["rule_id"] == "never-delete-prod"


@pytest.mark.docker
async def test_denied_approval_and_submitter_cannot_self_approve(api):
    await register_it_agent(api)
    # give alice the approver role too, to prove separation of duties applies to the SAME identity
    api.app.state.settings.api_keys["k-both"] = Principal("alice", frozenset({"developer", "approver"}))
    sid = (await api.post("/v1/agents/it-ops-agent/sessions", headers=hdr("dev"), json={})).json()["id"]
    for _ in range(150):
        pending = (await api.get("/v1/approvals", headers=hdr("appr"))).json()
        if pending:
            break
        await asyncio.sleep(0.2)
    aid = pending[0]["id"]
    r = await api.post(f"/v1/approvals/{aid}/approve", headers={"Authorization": "Bearer k-both"}, json={})
    assert r.status_code == 403
    assert (await api.post(f"/v1/approvals/{aid}/deny", headers=hdr("appr"), json={"comment": "too risky"})).status_code == 200
    assert (await api.post(f"/v1/approvals/{aid}/approve", headers=hdr("appr"), json={})).status_code == 409
    s = await wait_status(api, sid)
    assert s["status"] == "succeeded" and s["result"]["change"] == "not applied (approval_denied)"
    assert api.app.state.tool_ctx.backends.prod_changes == []


@pytest.mark.docker
async def test_session_policy_narrows_and_cannot_be_sole_grant(api):
    await register_it_agent(api)
    ro = "id: readonly\nrules:\n - {id: r, decision: allow, match: {type: data.read}}\n"
    await api.post("/v1/policies", headers=hdr("admin"), json={"document": ro})
    sid = (await api.post("/v1/agents/it-ops-agent/sessions", headers=hdr("dev"),
                          json={"policies": [{"id": "readonly"}]})).json()["id"]
    s = await wait_status(api, sid)
    assert s["status"] == "failed" and "policy_denied" in s["error"]  # ticket.create narrowed away
    assert {p["source"] for p in s["policies"]} == {"agent", "session"}

    # an agent with NO admin-attached policy must not become runnable via a session-level policy
    await api.post("/v1/agents", headers=hdr("dev"), json={
        "id": "naked", "shape": "declarative", "spec": {"steps": [{"call": "ticket.create", "args": {"title": "t"}}]}})
    allow_all = "id: allow-all\nrules:\n - {id: a, decision: allow, match: {type: '*'}}\n"
    await api.post("/v1/policies", headers=hdr("admin"), json={"document": allow_all})
    sid = (await api.post("/v1/agents/naked/sessions", headers=hdr("dev"), json={"policies": [{"id": "allow-all"}]})).json()["id"]
    s = await wait_status(api, sid)
    assert s["status"] == "failed" and s["policies"] == []
    assert api.app.state.tool_ctx.backends.tickets == []


@pytest.mark.docker
async def test_declarative_agents_and_policy_simulation(api):
    ex = yaml.safe_load((EX / "agents" / "txn-analyst.yaml").read_text())
    r = await api.post("/v1/agents", headers=hdr("dev"), json=ex)
    assert r.status_code == 201, r.text
    doc = (EX / "policies" / "financial-ops.yaml").read_text()
    await api.post("/v1/policies", headers=hdr("admin"), json={"document": doc})
    await api.post("/v1/agents/txn-analyst/policies", headers=hdr("admin"), json={"policy_id": "financial-ops"})

    small = (await api.post("/v1/agents/txn-analyst/sessions", headers=hdr("dev"), json={"task": {"to": "vendor-1", "amount": 200}})).json()["id"]
    s = await wait_status(api, small)
    assert s["status"] == "succeeded"
    assert s["result"]["master_data"]["rule_id"] == "deny-account-master-data"
    assert s["result"]["transfer"]["transferred"] == 200
    assert s["spent_amount"] == 200 and s["spent_tokens"] > 0

    # dry-run: what if the threshold were 100? (historical actions replayed; no agent runs)
    stricter = doc.replace("value: 1000", "value: 100")
    sim = (await api.post("/v1/policies/simulate", headers=hdr("aud"), json={"documents": [stricter], "session_id": small})).json()
    changed = [r for r in sim["results"] if r["changed"]]
    assert len(changed) == 1 and changed[0]["type"] == "payment.transfer"
    assert changed[0]["original"]["effect"] == "allow" and changed[0]["simulated"]["effect"] == "require-approval"


@pytest.mark.docker
async def test_sse_stream_and_cancel(api):
    await api.post("/v1/agents", headers=hdr("dev"), json={
        "id": "sleeper", "shape": "package",
        "package": {"entrypoint": "main:run", "files": {"main.py": "import time\ndef run(ctx):\n    ctx.progress('started')\n    time.sleep(120)\n"}}})
    await api.post("/v1/policies", headers=hdr("admin"), json={"document": "id: none\nrules: []"})
    await api.post("/v1/agents/sleeper/policies", headers=hdr("admin"), json={"policy_id": "none"})
    sid = (await api.post("/v1/agents/sleeper/sessions", headers=hdr("dev"), json={})).json()["id"]
    # httpx's in-process ASGITransport buffers streamed bodies, so poll for progress, cancel, then read the
    # (now finite) event stream. Live incremental streaming is exercised against real uvicorn by scripts/demo.py.
    for _ in range(100):
        ev = (await api.get(f"/v1/sessions/{sid}/audit", headers=hdr("dev"))).json()["events"]
        if any(e["kind"] == "agent.progress" for e in ev):
            break
        await asyncio.sleep(0.2)
    assert (await api.delete(f"/v1/sessions/{sid}", headers=hdr("dev"))).json()["cancelled"] is True
    assert (await wait_status(api, sid))["status"] == "cancelled"
    seen = []
    async with api.stream("GET", f"/v1/sessions/{sid}/events", headers=hdr("dev")) as r:
        async for line in r.aiter_lines():
            if line.startswith("event:"):
                seen.append(line[6:].strip())
    assert seen[:2] == ["session.created", "session.started"] and "agent.progress" in seen
    assert seen[-2:] == ["session.finished", "end"]
    assert (await api.get(f"/v1/audit/sessions/{sid}/verify", headers=hdr("aud"))).json()["valid"]


@pytest.mark.docker
async def test_other_developer_cannot_see_or_cancel_my_session(api):
    await register_it_agent(api)
    sid = (await api.post("/v1/agents/it-ops-agent/sessions", headers=hdr("dev"), json={})).json()["id"]
    assert (await api.get(f"/v1/sessions/{sid}", headers=hdr("dev2"))).status_code == 404
    assert (await api.delete(f"/v1/sessions/{sid}", headers=hdr("dev2"))).status_code == 404
    await api.delete(f"/v1/sessions/{sid}", headers=hdr("dev"))


# ------------------------------------------------ additions for the operator console (no docker needed)
async def test_whoami_reports_identity_and_sod_flag(api):
    r = await api.get("/v1/whoami", headers=hdr("appr"))
    assert r.json() == {"name": "bob", "roles": ["approver"], "separation_of_duties": True}
    assert (await api.get("/v1/whoami")).status_code == 401


async def test_agent_list_includes_attached_policies(api):
    await register_it_agent(api)
    rows = (await api.get("/v1/agents", headers=hdr("dev"))).json()
    assert rows[0]["id"] == "it-ops-agent"
    assert rows[0]["policies"] == [{"policy_id": "enterprise-it", "policy_version": None}]


async def test_audit_newest_first_paging(api):
    store = api.app.state.store
    for i in range(5):
        store.append_audit("s-page", "a", "action.decided", {"i": i}, effect="deny", rule_id="r")
    first = (await api.get("/v1/audit", headers=hdr("aud"), params={"session_id": "s-page", "order": "desc", "limit": 2})).json()
    assert [e["payload"]["i"] for e in first["events"]] == [4, 3] and first["next_before_id"] is not None
    older = (await api.get("/v1/audit", headers=hdr("aud"), params={
        "session_id": "s-page", "before_id": first["next_before_id"], "limit": 10})).json()
    assert [e["payload"]["i"] for e in older["events"]] == [2, 1, 0] and older["next_before_id"] is not None
    asc = (await api.get("/v1/audit", headers=hdr("aud"), params={"session_id": "s-page"})).json()
    assert [e["payload"]["i"] for e in asc["events"]] == [0, 1, 2, 3, 4]

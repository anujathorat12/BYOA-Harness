"""Server-side authorization, exhaustively: every protected endpoint x every role.

The console mirrors this table only to disable buttons; THIS is the enforcement. For each endpoint:
  * a role that is not allowed gets exactly 403 (even with an invalid body: authz runs before validation),
  * an allowed role gets anything except 401/403 (the fake ids used here yield 404/422, which proves the
    request got past authorization),
  * no key or a wrong key gets 401.
`admin` satisfies every requirement, exactly as in api/app.py `need()`.
"""
import pytest

from .helpers import hdr

ROLES = ["admin", "dev", "appr", "aud"]  # one identity per role; a second developer is used only in the ownership test
ANY = set(ROLES)

# (method, path, allowed roles besides admin)
ENDPOINTS = [
    ("GET", "/v1/whoami", ANY),
    ("POST", "/v1/agents", {"dev"}),
    ("GET", "/v1/agents", ANY),
    ("GET", "/v1/agents/x", ANY),
    ("POST", "/v1/agents/x/policies", set()),
    ("DELETE", "/v1/agents/x/policies/p", set()),
    ("POST", "/v1/agents/x/sessions", {"dev"}),
    ("POST", "/v1/policies", set()),
    ("GET", "/v1/policies", {"aud"}),
    ("GET", "/v1/policies/x", {"aud"}),
    ("POST", "/v1/policies/validate", {"aud"}),
    ("POST", "/v1/policies/evaluate", {"aud"}),
    ("POST", "/v1/policies/simulate", {"aud"}),
    ("GET", "/v1/sessions", ANY),
    ("GET", "/v1/sessions/x", ANY),
    ("DELETE", "/v1/sessions/x", {"dev"}),
    ("GET", "/v1/sessions/x/events", ANY),
    ("GET", "/v1/sessions/x/audit", ANY),
    ("GET", "/v1/approvals", {"appr", "aud"}),
    ("POST", "/v1/approvals/x/approve", {"appr"}),
    ("POST", "/v1/approvals/x/deny", {"appr"}),
    ("GET", "/v1/audit", {"appr", "aud"}),
    ("GET", "/v1/audit/sessions/x/verify", {"aud"}),
    ("GET", "/v1/admin/overview", {"appr", "aud"}),
]
CASES = [(m, p, role, role == "admin" or role in allowed)
         for m, p, allowed in ENDPOINTS for role in ROLES]


def call(api, method, path, role=None, body=None):
    # Deliberately sends an EMPTY (invalid) JSON body on POSTs: a forbidden role must see 403, never a 422 that
    # would reveal the request schema to someone who is not allowed to use the endpoint.
    kwargs = {"headers": hdr(role)} if role else {}
    if method == "POST":
        kwargs["json"] = {} if body is None else body
    return api.request(method, path, **kwargs)


@pytest.mark.parametrize("method,path,role,allowed", CASES, ids=[f"{m} {p} as {r}" for m, p, r, _ in CASES])
async def test_role_is_enforced_by_the_server(api, method, path, role, allowed):
    r = await call(api, method, path, role)
    if allowed:
        assert r.status_code not in (401, 403), f"{role} should reach {method} {path}, got {r.status_code}"
    else:
        assert r.status_code == 403, f"{role} must be refused {method} {path}, got {r.status_code}: {r.text[:120]}"
        assert r.json()["error"]["code"] == "http_error"


@pytest.mark.parametrize("method,path", [(m, p) for m, p, _ in ENDPOINTS])
async def test_no_key_is_401_on_every_protected_endpoint(api, method, path):
    assert (await call(api, method, path)).status_code == 401


@pytest.mark.parametrize("method,path", [(m, p) for m, p, _ in ENDPOINTS])
async def test_wrong_or_malformed_key_is_401(api, method, path):
    for headers in ({"Authorization": "Bearer nope"}, {"Authorization": "Bearer "}, {"Authorization": "test-key-admin"},
                    {"Authorization": "Basic azphZG1pbg=="}, {"Authorization": "Bearer test-key-admin "}):
        kwargs = {"headers": headers, **({"json": {}} if method == "POST" else {})}
        assert (await api.request(method, path, **kwargs)).status_code == 401, headers


@pytest.mark.parametrize("path", ["/healthz", "/readyz", "/metrics"])
async def test_operational_endpoints_are_intentionally_unauthenticated(api, path):
    # Liveness/readiness/metrics are scraped by orchestrators and Prometheus without credentials. They expose
    # no agent, policy or audit data (documented in docs/OPERATIONS.md).
    assert (await api.get(path)).status_code in (200, 503)


async def test_developer_only_sees_and_touches_their_own_sessions_and_agents(api):
    body = {"id": "owned-agent", "shape": "declarative", "spec": {"steps": [{"return": {"ok": 1}}]}}
    assert (await api.post("/v1/agents", headers=hdr("dev"), json=body)).status_code == 201
    # another developer cannot see it, list it, or run it (404, not 403: existence is not revealed)
    assert (await api.get("/v1/agents/owned-agent", headers=hdr("dev2"))).status_code == 404
    assert "owned-agent" not in [a["id"] for a in (await api.get("/v1/agents", headers=hdr("dev2"))).json()]
    assert (await api.post("/v1/agents/owned-agent/sessions", headers=hdr("dev2"), json={})).status_code == 404
    # privileged read roles can
    assert (await api.get("/v1/agents/owned-agent", headers=hdr("aud"))).status_code == 200

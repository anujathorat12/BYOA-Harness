# BYOA Harness

**A runtime governance and enforcement layer for untrusted or third-party AI agents.**
Agents run in isolated sandboxes with no direct access to anything. Every side effect goes through one
broker that asks a declarative policy engine first: `allow`, `deny`, or `require-approval` (which genuinely
freezes the agent until a human decides). Every attempt, decision, and the rule that made it is in a
tamper-evident audit log.

```
Third-party agent -> Sandbox -> Harness (PEP) -> Policy engine (PDP) -> allow | deny | approval -> Resource -> Audit
```

## Why this exists

Teams that ship agents today put guardrails inside the agent's own code. That fails three ways: the agent
enforces its own limits (a bug or a prompt injection skips them), every team encodes rules differently so
security cannot review them centrally, and after an incident nobody can answer *"what did agent X do, and
which rule allowed it?"*. This service moves enforcement out of the agent, into a boundary the agent has no
way around, and makes the rules and the evidence central.

It is sector-agnostic and makes **no compliance claims**. `examples/policies/` shows the same engine
expressing enterprise-IT, financial-operations and healthcare-style rules.

## Run it

Requires Docker (with Compose).

```bash
cp .env.example .env            # local-only demo keys; replace for anything shared
docker compose up --build       # harness :8080, Postgres, restricted docker-socket proxy, sandbox image
python -m venv .venv && pip install -e .
python scripts/demo.py          # end-to-end walkthrough (screen-record friendly)
```

Operator console: <http://localhost:8081> (see [`console/README.md`](console/README.md)) · Interactive API docs: <http://localhost:8080/docs> · static spec: [`docs/openapi.json`](docs/openapi.json).

Local development without Compose (SQLite; `HARNESS_ENV=dev` explicitly opts in to running without API keys):

```bash
docker build -t byoa-runtime:latest runtime       # sandbox image
pip install -e ".[dev]" && pytest                 # 316 tests; the 21 that use the real sandbox skip if Docker is absent
HARNESS_ENV=dev uvicorn --factory byoa_harness.main:create_app
```

## 60-second tour of the API

```python
from byoa_harness.client import HarnessClient
dev, admin, approver = (HarnessClient("http://localhost:8080", k) for k in (DEV_KEY, ADMIN_KEY, APPROVER_KEY))

dev.register_agent(id="it-ops-agent", shape="package",
                   package={"entrypoint": "main:run", "files": {"main.py": open("main.py").read()}})
admin.put_policy(open("examples/policies/enterprise-it.yaml").read())   # only admins author/attach policy
admin.attach_policy("it-ops-agent", "enterprise-it")

s = dev.submit("it-ops-agent")                     # 202: returns a session immediately
for event in dev.events(s["id"]): ...              # live SSE: decisions, approvals, progress
approver.approve(approver.pending_approvals()[0]["id"])   # resumes the frozen agent
print(dev.wait(s["id"])["result"])
```

| Area | Endpoints (all under `/v1`, role-checked) |
|---|---|
| Agents (BYOA) | `POST /agents` · `GET /agents[/{id}]` |
| Policies | `POST /policies` (new immutable version) · `GET /policies[/{id}?version=]` · `POST /policies/validate` · `POST /policies/evaluate` · `POST /policies/simulate` (dry-run) · `POST /agents/{id}/policies` · `DELETE /agents/{id}/policies/{pid}` |
| Tasks | `POST /agents/{id}/sessions` · `GET /sessions[/{id}]` · `GET /sessions/{id}/events` (SSE) · `GET /sessions/{id}/audit` · `DELETE /sessions/{id}` |
| Approvals | `GET /approvals` · `POST /approvals/{id}/approve` · `POST /approvals/{id}/deny` |
| Audit | `GET /audit?agent_id&session_id&effect&rule_id&action_type&since&until` · `GET /audit/sessions/{id}/verify` |
| Operate | `GET /admin/overview` · `/healthz` · `/readyz` · `/metrics` |

Roles: `admin`, `developer` (register agents, submit tasks, sees own sessions), `approver`, `auditor`.
Developers **cannot** author or attach policies, so an agent's owner cannot grant itself power.

## How the assignment's requirements map to the code

| Requirement | Where |
|---|---|
| BYOA, ≥2 shapes, documented contract | [`docs/BYOA_CONTRACT.md`](docs/BYOA_CONTRACT.md), `runtime/shapes.py` (`package`, `declarative`) |
| Sandboxed execution with CPU/mem/time limits | `runtime/sandbox.py` (`docker_args` is the whole isolation contract) |
| Distinct, independently testable policy engine | `src/byoa_harness/policy/` — pure, no I/O, enforced by `tests/unit/test_architecture.py` |
| Declarative, per-agent / per-session scoping | [`docs/POLICY_AUTHORING.md`](docs/POLICY_AUTHORING.md) |
| Human-in-the-loop that pauses and resumes | `approvals.py`, container frozen via `docker pause` |
| Full audit trail tied to rule + version | `store.py` (hash-chained), `GET /v1/audit` |
| Concurrent independent sessions | `runtime/manager.py` (bounded semaphore + queue) |
| Task API + SDK, separate policy interface | `api/app.py`, `client.py` |
| Bonus: versioning, dry-run, budgets, admin view | all four implemented |

## Measured results

Benchmarks on a developer laptop (Windows 11, Docker Desktop). They show orders of magnitude, not SLAs.

* **Policy evaluation** (`scripts/bench_policy.py`, 201 rules, 20 000 evaluations): p50 169 µs, p99 508 µs.
* **Concurrency** (`scripts/bench_concurrency.py 16`): 16 sessions against a cap of 8 concurrent, all 16 succeeded
  in 9.4 s (8 ran, 8 queued), zero leaked containers afterwards.
* **Tests**: 316 backend (134 unit: policy engine, broker, store, config/auth; 167 API, including an exhaustive role x endpoint authorization matrix; 15 adversarial attacks against the real sandbox), 18 console unit tests, and 29 Playwright end-to-end tests that drive a real browser against the live stack.

## Known limitations

Read [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for the full list and [`docs/ENGINEERING_REVIEW.md`](docs/ENGINEERING_REVIEW.md) for the audit of the codebase (fixed / intentional / needs a decision). The ones that matter most:

1. **Containers share the host kernel.** The isolation flags are strong, but a kernel exploit is out of scope.
   For hostile multi-tenant use, run sandboxes under gVisor/Kata/Firecracker (`--runtime`).
2. **The harness holds Docker access.** Compose gives it a proxy that allows container lifecycle calls only, but
   the proxy cannot restrict *flags*. The harness is trusted code that builds every container config itself.
3. **Package agents are stdlib-only** — the sandbox has no network, so it cannot install libraries.
   Bring-your-own-image is the natural third shape (see the contract doc).
4. **Reference connectors are simulators.** Real organisations add `Tool` subclasses for their own systems.
5. **A session lives on one replica** and pending approvals do not survive a restart (they fail closed).
6. **The Groq provider is verified by hand against the live API, not in CI**; `mock` is the default.
7. The 3–5 minute demo video is not included; `scripts/demo.py` is the script for recording it.

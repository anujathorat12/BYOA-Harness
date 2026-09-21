# BYOA Harness — Design (Phases 1–7)

Status: living document. Sections map to the engineering phases; the one-page
summary is [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## 1. Problem definition

**Problem.** Organizations want agents that call tools, touch data and spend
money, but today each team hand-rolls guardrails *inside the agent's own code*.
That has three failures: (a) the guardrail is enforced by the thing being
governed, so a buggy, prompt-injected or malicious agent can skip it;
(b) every team encodes rules differently, so security cannot review or change
them centrally; (c) after an incident nobody can answer "what did agent X do,
and which rule allowed it?" without grepping heterogeneous logs.

**Who has it.** Platform / security / internal-tooling teams at any organization
where more than one team (or a vendor) ships agents. The buyer is whoever is
accountable for "what can these agents do to our systems".

**What changes after deployment.** Agents lose *all* direct access to
anything. Every side effect goes through one broker that asks a policy engine
first. Rules live in versioned files owned by security. Every attempt is in a
tamper-evident audit log tied to the rule and policy version that decided it.

**Success metrics** (measured by tests/benchmarks in this repo, never invented):

| KPI | How measured |
|---|---|
| Mediated actions = 100% of side effects | Architecture test: agent container has no network/mounts; only channel is the broker pipe |
| Unauthorized actions reaching a resource = 0 | Adversarial suite (`tests/adversarial`) |
| Policy evaluation latency (p50/p99) | `scripts/bench_policy.py` |
| Audit completeness | Every broker call yields a decision row *before* execution; chain verification endpoint |
| Time to answer "what did agent X do" | Single audit query; seconds |
| Approval pause fidelity | Integration test: container is frozen (cgroup freezer) while pending |
| Concurrent isolated sessions | Concurrency test |

## 2. Industry use cases (same engine, different policy bundles)

The platform is sector-agnostic; it makes **no compliance claims**. Illustrative
bundles in `examples/policies/`:

| Scenario | Allow | Require approval | Deny |
|---|---|---|---|
| Enterprise IT | read logs, create tickets | production config change | destructive production op |
| Financial ops | read permitted transactions | transfer above threshold | unauthorised dataset, spend over budget |
| Healthcare data | read permitted dataset | external transfer of sensitive data | restricted records |

## 3. Requirements

**Core (assignment):** BYOA registration with ≥2 shapes; sandbox with
CPU/mem/time limits; policy engine returning allow/deny/require-approval per
action; per-agent and per-session policies; real pause/resume approvals; queryable
audit trail with rule attribution; concurrent sessions; task submit / stream /
result API; separate policy API.

**Security:** default-deny; agent identity derived from the channel, never from
message content; the *harness* classifies actions (agents cannot mislabel);
approval bound to the hash of the exact arguments; fail closed on any harness
error (audit write failure, engine exception, restart, timeout); secrets never
enter the sandbox; RBAC with separation between agent owners and policy/approval
authorities.

**Bonus (built, because they fall out of the design):** policy versioning,
historical dry-run simulation, token/spend budgets with hard cutoff, admin view.

**Explicitly out of scope:** marketplace UI, gRPC, formal verification, real
compliance certification, multi-region HA.

## 4. Policy model

* **Action** (canonical, immutable): `{type, resource, params, cost}`. Built by
  the harness's tool definition from the agent's raw arguments — the agent never
  supplies `type` or `resource`. Resources are canonicalized (NFKC, case,
  `..` collapse, trailing dots, host normalisation) *before* matching, and the
  executor runs the same canonical object that was evaluated (no TOCTOU).
* **Policy** (YAML/JSON): `id`, `rules[]`, optional `budgets`
  (`tokens`, `spend`) and `limits` (`max_actions`), `defaults.decision`
  (always `deny` unless explicitly overridden — and overriding is rejected by
  the loader for MVP).
* **Rule**: `id`, `decision` (`allow|deny|require-approval`), `match`
  (`type`, `resource` glob, `when[]` conditions on `params.*`/`cost`/
  `spend.*`/`agent.id`), `reason`.
* **Conditions**: `eq ne gt gte lt lte in not_in glob prefix contains exists`.
  No regex (ReDoS) and no code evaluation.
* **Evaluation**: all matching rules collected; **deny > require-approval >
  allow**; no match ⇒ default deny. Order-independent, so rule edits can't
  silently change outcomes through reordering.
* **Scope and composition**: policies attach to an agent (by admin) and/or a
  session (at task submission). A session is governed by *all* attached policies;
  the strictest decision wins and every policy needs an allow. A session policy
  can therefore only narrow what the agent's policy grants.
* **Versioning**: policies are immutable `(id, version)` with a content hash. A
  session pins versions at start. Audit rows record `policy_id@version` and
  `rule_id`.
* **Evaluation context**: `agent.id`, `session.id`, cumulative `spend.tokens`,
  `spend.amount`, `session.action_count`. Snapshot stored with the audit row so
  dry-run replays are exact.

## 5. Enforcement architecture (PEP / PDP)

```
 sandbox (no net, no mounts, no secrets)            harness (trusted)
┌──────────────────────────────┐   stdin/stdout   ┌────────────────────────────────────────────┐
│ third-party agent code       │  JSON-lines pipe │ PEP: Broker.handle_call(call)                │
│  (package | declarative | …) │ ───────────────▶ │  1 canonicalize → Action                   │
│  can only *request*          │                  │  2 PDP: PolicyEngine.evaluate(action, ctx) │
│                              │ ◀─────────────── │  3 audit row (decision) — fail closed      │
└──────────────────────────────┘   result/denied  │  4 allow → run tool / deny → refuse /      │
                                                   │    approval → freeze container, wait       │
                                                   │  5 audit row (outcome)                     │
                                                   │ protected resources & LLM keys live here   │
                                                   └────────────────────────────────────────────┘
```

* **PDP** = `byoa_harness.policy` — pure functions, no I/O, no imports from the
  rest of the app (enforced by a test). Unit-testable without any agent.
* **PEP** = `Broker.handle_call`. The *only* code path that invokes a tool, and it
  cannot invoke a tool without a `Decision` object. There is no second door:
  the sandbox has no network, no mounts and no credentials, so a side effect that
  does not go through the broker is impossible rather than merely forbidden.
* **Approval**: `require-approval` persists a pending approval bound to
  `sha256(canonical action)`, freezes the container (`docker pause`; excluded from the
  runtime budget), and blocks that call until an approver with a different
  identity than the submitter approves or denies. Timeout, harness restart or
  error ⇒ deny.

## 6. System architecture

Single deployable service (FastAPI) + Postgres + a sandbox runtime image.
Deliberately no more microservices than that.

| Component | Responsibility |
|---|---|
| API layer `/v1` | agents, policies, sessions (+SSE), approvals, audit, admin; API-key RBAC |
| Registry | agent manifests; shapes `package` and `declarative`; immutable versions |
| Session manager | bounded concurrency (semaphore + queue), lifecycle, reaper for orphaned containers |
| Sandbox | `docker run` with fixed flags built only by the harness; per-session container |
| Broker (PEP) | canonicalize → decide → audit → execute → audit |
| Tools / connectors | harness-side executors (data, ticket, prod, payment, http, llm); pluggable |
| Policy store + engine | versioned policies, pure evaluation, dry-run simulation |
| Audit store | append-only, per-session hash chain, queryable |
| Approvals | pending queue, decisions, timeouts |

**Persistence:** Postgres in compose/production; SQLite for tests and local dev
(same SQLAlchemy Core code).
**Concurrency:** one asyncio task per session; audit chain is per session, so
sessions never contend on a global lock. Scaling out: sessions are pinned to the
replica that started them (documented limitation).
**Why `docker` CLI over the Docker SDK:** a stdin/stdout pipe works identically on
Windows, macOS and Linux (bind-mounted unix sockets do not cross Docker Desktop's
VM boundary), and the flag set is auditable in one place.

## 7. Threat model

Attacker: the agent code, and anything it can be talked into doing (prompt
injection). Trusted: harness, policy files, approvers.

| # | Attack | Mitigation |
|---|---|---|
| T1 | Call a resource directly | No network (`--network none`), no mounts, no creds; only channel is the broker pipe |
| T2 | Lie about action type/resource | Harness derives type/resource from its own tool definition |
| T3 | Path/host tricks (`..`, case, unicode, trailing dot, `0x7f…`) | Canonicalization before evaluation; executor uses canonical form; SSRF guard on egress |
| T4 | Get approval for A, execute B | Approval bound to canonical-action hash; executed args = approved args |
| T5 | Forge identity / decisions in messages | Identity = the pipe; agents can't send "decision" messages (unknown types are protocol violations) |
| T6 | Flood the broker / stdout | Line-size cap, per-session action cap, output cap → kill |
| T7 | Fork bomb / memory / CPU / disk | `--pids-limit`, `--memory` (no swap), `--cpus`, tmpfs size, `ulimit`; wall-clock kill |
| T8 | Hang the harness | Per-call timeouts; hung agent killed at deadline; approvals time out to deny |
| T9 | Interfere with other agents | One container/pipe per session; no shared volumes/network; separate pid namespace |
| T10 | Escape via privileges | Non-root, `--cap-drop ALL`, `no-new-privileges`, read-only rootfs, default seccomp, no `--privileged`, no docker.sock in the sandbox |
| T11 | Tamper with audit | Hash chain + verification endpoint; agents have no write path |
| T12 | Owner grants own agent permissive policy | Only `admin` can author/attach policies; owners can only register agents |
| T13 | Harness crash mid-approval | Pending approvals expire to deny on restart; orphan containers reaped by label |
| T14 | Audit DB down | Decision rows written *before* execution; failure ⇒ deny |

**Residual risks (documented, not hidden):** kernel-level container escapes
(mitigate in production with gVisor/Kata/Firecracker); the harness talks to the
Docker daemon (mount only a restricted socket proxy in production); tools
executed by the harness inherit the harness's own bugs; audit hash chain proves
tampering but not deletion of a *suffix* without an external anchor.

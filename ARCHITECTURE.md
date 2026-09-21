# Architecture (one page)

Full reasoning, requirements and threat model: [`docs/DESIGN.md`](docs/DESIGN.md).

```
   SANDBOX (per session, no network / no mounts / no secrets)         HARNESS (trusted)
 ┌─────────────────────────────────┐   stdin/stdout    ┌────────────────────────────────────────────────┐
 │ third-party agent               │   JSON-lines      │ Broker = Policy Enforcement Point              │
 │  package | declarative | …      │ ────────────────▶ │  1 tool.build_action(args) -> canonical Action │
 │ can only REQUEST actions        │                   │  2 PDP: evaluate_all(policies, action, ctx)    │
 │                                 │ ◀──────────────── │  3 audit the decision  (fail closed)           │
 └─────────────────────────────────┘   result / error  │  4 allow ▸ run │ deny ▸ refuse │ approval ▸ wait │
                                                       │  5 execute the SAME action ▸ audit the outcome │
   API (/v1, RBAC) ─▶ Session manager ─▶ Sandbox       └──────────────┬─────────────────────────────────┘
        │                                                             ▼
        └─▶ Policy store · Approvals · Audit (Postgres)      Protected resources, LLM keys (harness-side only)
```

## Decisions and why

| Decision | Reason | Trade-off |
|---|---|---|
| **Enforcement by capability removal, not by checking.** The sandbox has no network, no mounts, no credentials; its only channel is a pipe to the broker. | An agent cannot "skip" a check on a path that doesn't exist. Reviewers will look for a second door; there isn't one. | Agents cannot use libraries needing network or install packages. |
| **The harness classifies actions.** A tool definition turns raw args into `{type, resource, cost}`; the agent never supplies them. Unknown fields are rejected. | Stops "call the destructive tool but label it a read". | Every capability needs a harness-side connector. |
| **Evaluated == executed.** Canonical `Action` is built once, digest-checked, and the tool receives it (not the raw args). Approvals bind to its digest. | Closes time-of-check/time-of-use and approve-A-run-B. | — |
| **Pure policy engine, default-deny, deny > approval > allow.** Uncertain conditions resolve to the stricter reading. No regex, no code eval. | Order-independent, independently testable, type-confusion can't turn a deny into an allow. | Less expressive than a full language (e.g. Rego). Chosen deliberately for MVP. |
| **Approvals hold the call open and freeze the container** (`docker pause`, excluded from the runtime budget). Timeout, restart, or any error ⇒ deny. | Real pause, not "return an error and hope". | In-memory waiters: approvals do not survive a restart (they expire safely). |
| **Audit written before execution; failure ⇒ deny.** Per-session hash chain + verify endpoint. | Core value proposition; no un-recorded action can happen. | Chain detects tampering/reordering, not deletion of a session's tail without an external anchor. |
| **Policies are immutable versions; sessions pin them.** Only admins author/attach. Session policies can only narrow. | Auditable "which version governed this action"; no self-granting. | A running session doesn't see policy edits. |
| **`docker` CLI + pipe, not the SDK / unix sockets.** | Identical on Linux/macOS/Docker Desktop; the whole isolation flag set is one function. | Process-spawn overhead per session (~0.3 s). |
| **One service + Postgres**, not microservices. | Simplest thing that holds at production scale for this problem. | Session affinity to a replica for now. |

## Where each rubric item lives
Sandbox: `runtime/sandbox.py` + `tests/adversarial/` · Policy: `policy/` + `tests/unit/test_policy_engine.py` ·
BYOA: `runtime/shapes.py`, `docs/BYOA_CONTRACT.md` · Audit: `store.py`, `/v1/audit` · Approvals: `approvals.py` ·
Ops/concurrency: `runtime/manager.py`, `docs/OPERATIONS.md`.

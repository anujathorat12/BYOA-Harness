# Architecture

Full reasoning, requirements and threat model: [`docs/DESIGN.md`](docs/DESIGN.md).

## The big picture

```mermaid
flowchart TB
    subgraph PEOPLE["Who uses it"]
        DEV["Developer<br/>adds agents, sends tasks"]
        ADM["Admin<br/>writes the rules"]
        APR["Approver<br/>says yes or no"]
        AUD["Auditor<br/>reads the history"]
        EXT["Other apps"]
    end

    UI["Operator Console<br/>(the web screen)"]

    subgraph HARNESS["The Harness (what we built)"]
        API["Harness API - the only front door<br/>checks your key and your role first"]
        TASK["Task manager<br/>8 at a time, the rest wait in line"]
        DOCKER["Docker<br/>makes a new locked box for every task"]
        GUARD["Guard<br/>the only way to a real tool"]
        CHECK["Rule checker<br/>allow, deny, or ask a human"]
        WAIT["Approval desk<br/>freezes the agent until a human answers"]
    end

    AGENT["The agent, inside a locked box<br/>no internet, no files, no keys<br/>it can only ask the Guard"]

    subgraph SAVED["Saved in the Database (Postgres)"]
        LIST["Agent list"]
        RULES["Rulebook<br/>every change is a new version"]
        LOG["History book<br/>every attempt is written down<br/>a change to it can be detected"]
    end

    TOOLS["Real tools<br/>(demo versions today)"]
    AI["AI model (Groq)<br/>the key stays with the Harness"]

    DEV --> UI
    ADM --> UI
    APR --> UI
    AUD --> UI
    UI --> API
    EXT -->|"REST call + API key"| API

    API --> TASK
    TASK --> DOCKER
    DOCKER --> AGENT
    AGENT <-->|"asks, and gets the answer"| GUARD

    GUARD --> CHECK
    GUARD --> WAIT
    GUARD --> TOOLS
    GUARD --> AI
    GUARD -->|"writes before and after"| LOG
    CHECK -->|"reads"| RULES
    API -->|"developer adds"| LIST
    API -->|"admin only"| RULES

    classDef people fill:#fff4e0,stroke:#e0a030,color:#222
    classDef door fill:#e3f0ff,stroke:#3b82f6,color:#222
    classDef guard fill:#e0f5ee,stroke:#10a37f,color:#222
    classDef locked fill:#fde8e8,stroke:#dc2626,color:#222
    classDef store fill:#f1eefc,stroke:#7c5cd6,color:#222
    class DEV,ADM,APR,AUD,EXT people
    class API,UI door
    class GUARD,CHECK,WAIT guard
    class AGENT locked
    class LIST,RULES,LOG store
```

| Plain word | Technical name | Where in the code |
|---|---|---|
| Guard | Policy Enforcement Point (the broker) | `src/byoa_harness/broker/broker.py` |
| Rule checker | Policy Decision Point (the policy engine, no I/O) | `src/byoa_harness/policy/engine.py` |
| Rulebook | Policy store (versioned YAML) | `src/byoa_harness/store.py` |
| Locked box | Sandbox (one Docker container per task) | `src/byoa_harness/runtime/sandbox.py` |
| Task manager | Session manager (queue, limits, watchdog) | `src/byoa_harness/runtime/manager.py` |
| Approval desk | Human-in-the-loop approvals | `src/byoa_harness/approvals.py` |
| History book | Audit log (hash-chained, tamper-evident) | `src/byoa_harness/store.py` |
| Harness API | REST API, key check and role check | `src/byoa_harness/api/app.py` |

The four roles are **admin**, **developer**, **approver** and **auditor**. The server checks the role on every request; the
console only mirrors it to grey out buttons. The person who submitted a task can never approve its actions.

## What happens to one action

```mermaid
flowchart TD
    A["The agent says: I want to do X"] --> B{"Is X a tool we know?"}
    B -- "No" --> R1["Refused<br/>and written in the history"]
    B -- "Yes" --> C["The Guard builds the action itself<br/>(the agent cannot pick its own label)"]
    C --> D["Rule checker reads the rulebook<br/>and also checks the token and money limits"]
    D --> E["Write the decision in the history book"]
    E --> F{"Was it written OK?"}
    F -- "No" --> R2["Refused, nothing runs"]
    F -- "Yes" --> G{"What did the rules say?"}
    G -- "Allow" --> H["Run the real tool<br/>exactly as it was checked"]
    G -- "Deny" --> R3["The agent is told no<br/>the tool is never touched"]
    G -- "Ask a human" --> I["Freeze the agent"]
    I --> J{"Did a different person answer<br/>within 15 minutes?"}
    J -- "Yes, approve" --> H
    J -- "No, or no answer" --> R4["The agent is told no"]
    H --> K["Write the result in the history book"]
    K --> L["Give the result back to the agent"]

    classDef good fill:#e0f5ee,stroke:#10a37f,color:#222
    classDef bad fill:#fde8e8,stroke:#dc2626,color:#222
    classDef wait fill:#fff4e0,stroke:#e0a030,color:#222
    class H,K,L good
    class R1,R2,R3,R4 bad
    class I,J wait
```

"8 at a time" and "15 minutes" are the default settings (`MAX_CONCURRENT_SESSIONS`, `APPROVAL_TIMEOUT_S`). The real tools are
in-memory simulators today; a real deployment writes connectors for its own systems.

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

## Deployment and trust boundaries

```
 browser (untrusted) ─▶ nginx :8081 (static console, CSP, same-origin proxy) ─▶ harness :8080 ─▶ Postgres
                                                                              ├─▶ docker-socket-proxy ─▶ Docker ─▶ sandboxes (no network)
                                                                              └─▶ Groq (API key lives only here)
```
Untrusted: the browser and all agent code. Trusted: nginx, harness, Postgres, socket proxy. Authentication is a bearer key
mapped to a name and roles; **authorization is enforced by the harness on every request** (the console only mirrors it
to disable controls). Unauthenticated by design: `/healthz`, `/readyz`, `/metrics`, `/docs`. Review findings, what was
fixed and what still needs a decision: [`docs/ENGINEERING_REVIEW.md`](docs/ENGINEERING_REVIEW.md).

## Where each rubric item lives
Sandbox: `runtime/sandbox.py` + `tests/adversarial/` · Policy: `policy/` + `tests/unit/test_policy_engine.py` ·
BYOA: `runtime/shapes.py`, `docs/BYOA_CONTRACT.md` · Audit: `store.py`, `/v1/audit` · Approvals: `approvals.py` ·
Ops/concurrency: `runtime/manager.py`, `docs/OPERATIONS.md`.

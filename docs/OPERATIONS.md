# Operations, failure behaviour and limitations

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `HARNESS_ENV` | `dev` | Outside `dev` the service refuses to start without API keys |
| `HARNESS_API_KEYS` | — | JSON `{"token":{"name":"alice","roles":["developer"]}}` |
| `DATABASE_URL` | `sqlite:///./harness.db` | `postgresql+psycopg://…` in production |
| `SANDBOX_IMAGE` | `byoa-runtime:latest` | Image every agent runs in |
| `MAX_CONCURRENT_SESSIONS` / `MAX_QUEUED_SESSIONS` | 8 / 100 | Running slots / queue before `429` |
| `SANDBOX_MEMORY_MB` `SANDBOX_CPUS` `SANDBOX_PIDS` `SANDBOX_TMPFS_MB` | 256 / 0.5 / 64 / 32 | Per-session ceilings (agents may only lower) |
| `SESSION_TIMEOUT_S` | 120 | Active-runtime ceiling (excludes approval pauses) |
| `APPROVAL_TIMEOUT_S` | 900 | Pending approval → `expired` (deny) |
| `SEPARATION_OF_DUTIES` | 1 | Submitter may not approve their own actions |
| `MAX_ACTIONS_PER_SESSION` `MAX_MESSAGE_BYTES` | 500 / 1 MiB | Broker flood limits |
| `LLM_PROVIDER` `GROQ_API_KEY` `GROQ_MODEL` | `mock` | Model layer; keys never enter a sandbox |
| `LOG_LEVEL` | `INFO` | JSON logs to stdout, with `request_id` / `session_id` |

## Endpoints for operators

`/healthz` (liveness) · `/readyz` (database + Docker; 503 if either is down) · `/metrics` (Prometheus text:
active sessions, pending approvals, decisions by effect, sessions by status) · `GET /v1/admin/overview`
(running sessions with `docker stats`, paused state, pending approvals, capacity).

## Behaviour under failure (each is covered by a test unless noted)

| Situation | Behaviour |
|---|---|
| Agent hangs / spins | Killed at `timeout_s` of active runtime; session `failed`, container removed |
| Agent OOMs / fork-bombs | Memory cap (no swap) / pids cap contain it; `failed: exceeded memory limit` |
| Agent crashes or exits without a result | `failed` with exit code and stderr head |
| Agent forges/garbles protocol, floods stdout | Protocol violation → killed |
| Policy engine raises | Action denied (`harness:engine-error`) |
| Audit write fails before an action | Action **not executed**, agent told `audit_unavailable` |
| Audit write fails after an action | Session terminated, error logged at CRITICAL |
| Approval never answered | `expired` → denied after `APPROVAL_TIMEOUT_S` |
| Harness restarts | Running/queued sessions → `failed`; pending approvals → `expired`; labelled containers reaped |
| Cancel during container start | Client killed first, removal verified in a retry loop (found and fixed by tests) |
| Overload | Queue up to `MAX_QUEUED_SESSIONS`, then `429`; queued sessions do not consume sandbox resources |
| Bad input | Strict validation, `422` with structured `{"error":{code,message,request_id}}` |
| Docker daemon down | `/readyz` → 503; new sessions fail at start with a clear reason (not covered by an automated test) |

## Known limitations (be honest with your security team)

1. **Shared kernel.** Container isolation is not a VM boundary. For hostile multi-tenant workloads run the sandbox
   under gVisor, Kata or Firecracker (`--runtime=runsc`); no other harness change is needed.
2. **Docker access.** The harness needs a Docker API. Compose fronts it with a proxy that allows container lifecycle
   calls only (no images, networks, volumes, exec, build), but a proxy cannot restrict create-time flags, so the
   harness itself remains a high-value target. Kubernetes Jobs with a restricted service account are the better
   production backend; the `Sandbox` class is the seam.
3. **Audit integrity.** The per-session hash chain detects modification and reordering. It does not detect deletion
   of a session's *tail*, or of a whole session; anchor `head_hash` in an external write-once store for that.
   Action parameters are stored (truncated) and may contain sensitive data; there is no redaction layer yet.
4. **Package agents are stdlib-only** and there is no bring-your-own-image shape yet.
5. **Reference connectors are simulators.** Real systems need real `Tool` subclasses (and their credentials).
6. **Single-replica sessions.** A session, its approvals and its budgets live in one process. Scaling out needs
   sticky routing or moving the broker state to the database.
7. **Static API keys** from the environment. Use your IdP/OIDC and a secret manager when integrating.
8. **DNS**: the http tool pins the validated IP and does not follow redirects; it is not a general egress proxy.
9. **Groq provider** is implemented but was not run against the live API in automated tests.
10. **No agent code signing or provenance** — registration proves who submitted an agent, not that its code is safe.

## Suggested path to production

Dev (SQLite, `dev` mode) → CI (`pytest` incl. adversarial sandbox suite, OpenAPI drift check) → Staging (compose or
Kubernetes, Postgres, real API keys, seeded policies, run `scripts/demo.py` as a smoke test) → Production (gVisor/Kata
runtime, secrets manager, DB backups + PITR, ship JSON logs and `/metrics` to your stack, alert on `audit_unavailable`,
rising `deny` rates and `expired` approvals). Roll policy changes with `simulate` first.

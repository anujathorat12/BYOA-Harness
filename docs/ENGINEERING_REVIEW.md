# Engineering review (pre-architecture-review pass)

A critical audit of the whole codebase (API, auth, policy engine, broker, sandbox, persistence, console, Docker/Compose,
nginx, tests, scripts, dependencies). Tools used: `ruff` (broad rule set), `vulture` (dead code), `knip` (unused
files/exports/deps), `jscpd` (duplication), `pip-audit` and `npm audit` (vulnerabilities), plus a manual read of the
security-critical paths. Findings are split into four groups so nothing is hidden.

## A. Fixed

| # | Finding | Why it mattered | Fix |
|---|---|---|---|
| A1 | `HARNESS_ENV` defaulted to `dev`, which serves **unauthenticated admin** when no keys are set. Only the Docker image overrode it. | A bare `uvicorn` run that forgot the variable was an open admin API. | Default is now `production`; `dev` must be requested explicitly. `principal()` re-checks per request and answers 401 otherwise. Tests: `tests/unit/test_config_and_auth.py`. |
| A2 | Unset `${ADMIN_KEY}` in Compose silently became `""`, and an empty `Bearer` header would then authenticate as admin. | Auth bypass caused by a config mistake. | Three layers: Compose uses `${VAR:?message}` (fails loudly); the harness refuses keys shorter than 8 chars at startup; `_authenticate` never matches an empty token. Tested. |
| A3 | API-key lookup was a plain dict lookup. | Not constant-time. | `hmac.compare_digest` against every key, no early exit. |
| A4 | No exhaustive authorization test; only spot checks. | An architect will ask "prove the server enforces every role on every endpoint". | `tests/integration/test_authorization_matrix.py`: every protected endpoint x every role (exactly 403 when forbidden, even with an invalid body so schemas do not leak), 401 for no/wrong/malformed keys, ownership isolation between developers. ~150 cases. |
| A5 | `SANDBOX_ENABLED` sounded like it disabled sandboxing but only skipped startup cleanup and the Docker readiness check. | A misleading control on a security boundary. | Removed. |
| A6 | `sandbox_factory` test seam threaded through `create_app` and `SessionManager` but never used. | Dead abstraction. | Removed. |
| A7 | `SubmitError` and `ApprovalError` were identical classes; two try/except blocks in routes translated them. | Duplicate abstraction. | One `DomainError` (`errors.py`) and one exception handler. Response shape unchanged. |
| A8 | Pydantic request model named `Decision` collided conceptually with `policy.Decision`. | Naming confusion in the same file. | Renamed `ApprovalDecision`. |
| A9 | `store._chain_locks` created a lock per session and never freed it. | Unbounded memory growth. | Weak-valued map; regression test. |
| A10 | Production silently defaulted to the **mock LLM** (placeholder text). | A deployer forgetting `LLM_PROVIDER` would get fake output with no signal. | Loud startup warning; tested. |
| A11 | Every shadcn component imported `cn` from a young third-party package (`cn@0.3.0`) while the app had its own `clsx + tailwind-merge` helper. | Two implementations of one function; a weeks-old dependency in the UI path. | All components use `@/lib/utils`; package removed. |
| A12 | Whole console shipped as one 763 kB JS file (Vite size warning). | Slow first load; a build warning. | Route-level `React.lazy`; main chunk 483 kB; build is warning-free. |
| A13 | Unused UI files (`scroll-area`, `separator`), needless exports, duplicated "session finished" logic, an effect that synced default selection into the URL, stale `eslint-disable` comments (no ESLint here). | Dead code and noise. | Removed; `isFinished()` is the single definition; selection is derived. |
| A14 | Stale `noqa` suppressions for rules that are not enabled; `runtime/` was not linted in CI. | Suppressions that suppress nothing hide real ones later. | Removed; CI lints `runtime/` too. |
| A15 | Scripts reached into a private client method (`_req`); an unused variable and misleading comment in a benchmark. | Poor SDK surface. | Public `sessions()`, `overview()`, `simulate()`, `verify_chain()`. |
| A16 | Version defined in two places (`pyproject.toml`, `__init__.py`). | Drift. | Single source (`byoa_harness.__version__`). |
| A17 | Runtime image kept `setuptools` (flagged by `pip-audit`). | Needless attack surface. | Removed after install. |
| A18 | Fresh clones failed `docker compose build` (untracked `certs/`). | Broken first-run experience. | Tracked placeholder + README (committed earlier). |
| A19 | Docs drift: `Broker.execute`, dev-mode wording, Groq status, test counts. | Documentation contradicting code. | Corrected. |
| A20 | An e2e test fell back to "approve whichever approval is first". | Could act on another test's data. | Deterministic lookup. |

## B. Intentionally retained (looks unusual, is deliberate)

| Item | Reason |
|---|---|
| Sandbox driven through the `docker` **CLI** with a stdin/stdout pipe | Works identically on Linux/macOS/Docker Desktop (unix sockets do not cross the VM boundary); the entire isolation flag set is one auditable function. |
| `bootstrap.py` duplicates fd 1 and redirects stdout to stderr | Stray `print()` from agent code must not forge protocol messages. |
| Reference connectors are **in-memory simulators** wired into the real broker | They are the only connectors shipped; real deployments add `Tool` subclasses. The API behaves identically. Documented in `docs/BYOA_CONTRACT.md`. |
| Console mirrors the role matrix (`roles.ts`) | Only to disable-and-explain controls. The server is the authority and is tested exhaustively (A4). See C2. |
| SSE over `fetch()` instead of `EventSource` | `EventSource` cannot send `Authorization`; putting the key in the URL would leak it. |
| API key in `sessionStorage` | Dies with the tab; never `localStorage`. Trade-off documented in `console/README.md`. |
| CSP allows `'unsafe-inline'` for **styles** only | Radix positions popovers with inline `style` attributes. Scripts remain `'self'`. |
| Broad `except Exception` in `broker.py`, `approvals.py`, `manager.py` | Each is fail-closed enforcement (engine bug becomes a deny, audit failure refuses the action) or best-effort cleanup that must not mask the original error. |
| Other users' resources answer **404**, not 403 | Existence must not be revealed. |
| `/healthz`, `/readyz`, `/metrics`, `/docs`, `/openapi.json` are unauthenticated | Orchestrators and Prometheus scrape them without credentials; none exposes agent, policy or audit data. Tested (`test_operational_endpoints_are_intentionally_unauthenticated`). |
| Policy `defaults:` accepts only `deny`; a `version:` label is accepted but ignored | Reserved for a future non-deny default; the store assigns real versions. |
| `Broker.handle_call`, `SessionManager._execute` are long | The enforcement order (canonicalize, decide, audit, enforce, execute, audit) is kept linear on purpose so it can be audited top to bottom. See C4. |
| e2e tests create uniquely named data and do not delete it | There is deliberately no delete-agent/audit endpoint. |
| Unused exports in generated `components/ui/*` | Generated shadcn library files are kept intact by convention. |

## C. Needs an architectural decision

1. **`api/app.py` is one ~480-line `create_app` closure** holding every route. Splitting into `APIRouter` modules plus a
   dependency module is the natural next step but touches every endpoint; do it when the API grows, behind the
   authorization matrix test.
2. **Authorization is defined twice** (server `need(...)` calls and console `roles.ts`). Guarded by tests on both sides.
   Better: the server returns effective capabilities from `/v1/whoami` and the console stops re-deriving them.
3. **No database migrations.** Schema is created with `create_all` at startup (racy with several replicas, and
   impossible to evolve in place). Introduce Alembic before the first production schema change.
4. **Long functions** (`handle_call`, `_execute`, `_eval_condition`). Decomposition is possible now that adversarial
   tests exist, but must not blur the enforcement order.
5. **Single-process state**: budgets, pending-approval waiters and running sessions live in one replica's memory. Scaling
   out needs sticky routing or moving this state into the database/a broker.
6. **Live streams poll the database** every 0.5 s per subscriber. Use LISTEN/NOTIFY or a message bus at scale.
7. **Budgets are per session**, not per agent, team or time window.
8. **Identity**: static bearer keys with no expiry, rotation, revocation, rate limiting or lockout; failed sign-ins appear
   only in request logs, not in the audit trail. Production needs OIDC/SSO (roles from IdP groups), TLS at the edge and a
   rate-limiting proxy/WAF.
9. **Sandbox backend**: the harness needs a Docker API and the socket proxy cannot restrict create-time flags. A
   Kubernetes Job backend with a restricted service account (and gVisor/Kata) is the production answer; `Sandbox` is the seam.
10. **Audit**: the per-session chain cannot detect deletion of a whole session or a session's tail; parameters are stored
    without redaction; there is no retention policy. Anchor head hashes in write-once storage; add redaction and retention.
11. **API hardening**: no request-size limit on the API itself (only nginx in front of the console), synchronous DB calls
    run in threads, hand-written Prometheus text, no tracing.
12. **Readiness checks reachability, not capability.** `/readyz` reports "sandbox ok" if the Docker daemon answers
    `docker version`. During a real incident (host disk full, Docker storage remounted read-only) it kept reporting ready
    while no container could be created and Postgres could not write. A meaningful probe must also prove a sandbox can start
    and the database can write; decide the cost (extra latency per probe) before changing it.
13. **The startup reaper is global to the Docker daemon.** `reap_orphans()` removes every container labelled
    `byoa.managed=1`, so a second harness (or a test run) on the same daemon can kill the first one's live sandboxes.
    Scope containers with an instance label (e.g. `byoa.instance=<id>`) before running more than one harness per daemon.
14. **Startup depends on Docker answering.** Each Docker call has a 20 s timeout and startup tolerates failure, which is
    correct, but a wedged daemon makes every start (and every API-level test) slow instead of failing fast. Consider a
    single fail-fast probe with a short timeout.
15. **Supply chain**: Python dependencies use `>=` ranges without a lockfile; base images are pinned by tag not digest;
    no SBOM or image scanning in CI.

## D. Known limitations

* Containers share the host kernel; a kernel-level escape is out of scope (mitigate with gVisor/Kata/Firecracker).
* `package` agents are standard-library only (no network in the sandbox); there is no bring-your-own-image shape yet.
* Connectors are simulators; nothing talks to real customer systems.
* Sessions and pending approvals do not survive a harness restart (they fail closed).
* The Groq provider is verified by hand, not in CI. Prompts and data sent to the model are not redacted.
* Console: desktop-only light theme; the session list can mark "frozen" only for roles allowed to read the overview;
  API response types are hand-written and unvalidated at runtime (the e2e suite detects drift).
* `console/README.md` and `docs/OPERATIONS.md` list further operational caveats.

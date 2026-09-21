# BYOA Harness — Operator Console

The screen an operator or security reviewer opens to govern agents: what is running, what is waiting on a human,
what was blocked and by which rule, and proof the record hasn't been altered. Everything shown comes from the real
harness API. There is no mock data and no client-side policy logic: the UI only ever displays what the backend's
policy engine decided.

## Run it

```bash
# from the repo root
cp .env.example .env
docker compose up --build        # harness :8080, Postgres, docker-socket proxy, sandbox image, console :8081
```

Open **http://localhost:8081** and paste an API key.

| Role | Key (from `.env`) | Can do |
|---|---|---|
| `admin` | `ADMIN_KEY` | everything, including creating/attaching policies |
| `developer` | `DEV_KEY` | register agents, submit and cancel tasks, see own sessions |
| `approver` | `APPROVER_KEY` | approve/deny, read audit and overview |
| `auditor` | `AUDITOR_KEY` | read policies/audit/overview, dry-run, verify hash chains |

Sign in as **different people in different browsers** to see the real workflow: a developer submits, an approver
approves, and the developer's screen unfreezes live. Your role is always shown in the sidebar; controls you cannot use
are **disabled with the reason on hover**. The server enforces the same rules regardless of the UI.

To see something immediately: `python scripts/demo.py` from the repo root registers agents and runs all three
sector scenarios, then everything appears in the console.

### Development

```bash
cd console
cp .env.example .env
npm install
npm run dev          # http://localhost:5180, proxies /v1 to the harness on :8080
npm test             # unit tests (SSE parser, role guard, timeline fold)
npm run build        # strict typecheck + production build
```

## Screens and the question each answers

| Screen | Answers | Backed by |
|---|---|---|
| Overview | Is it healthy? Who is running, what is frozen, what was just denied? | `/healthz` `/readyz` `/v1/admin/overview` `/v1/audit` |
| Agents | What is registered and what governs it? | `/v1/agents`, `/v1/agents/{id}/policies` |
| Policy Studio | What would this policy have done to our real traffic? | `/v1/policies` (+`validate`, `evaluate`, `simulate`) |
| Live Sessions | What are they doing right now, and why was each action allowed? | `/v1/sessions`, SSE `/v1/sessions/{id}/events` |
| Approvals | What is waiting on me? | `/v1/approvals` |
| Audit Log | What happened, which rule fired, can I prove it? | `/v1/audit`, `/v1/audit/sessions/{id}/verify` |
| Attack Lab | Does the sandbox really stop a hostile agent? | registers and runs four real hostile agents (`/v1/agents`, `/v1/agents/{id}/sessions`); the verdict is read from the real session, never faked |

Two display-only helpers: **Policy in plain English** (beside the YAML in Policy Studio; `lib/explainPolicy.ts` only
rephrases the document, the server engine still decides everything) and **Approval alerts** (toast always; opt-in sound,
desktop notification and tab-title badge for roles that can decide approvals; approvals already waiting on page load stay silent).

## Design decisions you should know about

* **SSE over `fetch()`, not `EventSource`.** The browser's `EventSource` cannot send an `Authorization` header, and every
  harness endpoint requires a Bearer key. Putting the key in the URL would leak it to logs and history. We speak the same
  SSE protocol through a streaming `fetch`, with resume from the last event id. Still SSE; no WebSocket, no backend change.
* **Same-origin, no CORS.** The backend deliberately has no CORS. Vite's proxy (dev) and nginx (compose) put the console
  and API on one origin. nginx also sets a strict CSP, `X-Frame-Options: DENY`, and runs non-root.
* **The API key** lives in `sessionStorage` only (dies with the tab, never `localStorage`). A CSP limits injected script,
  but any XSS could still read it — the same trade-off as any bearer-key SPA. Use your IdP/OIDC for real deployments.
* **Role matrix mirrors the server's `need(...)` checks** (`src/lib/roles.ts`, unit-tested) purely to disable-and-explain.
  The server is the authority. Separation of duties uses the server's own `separation_of_duties` flag from `/v1/whoami`.
* **Live validation is the backend's.** The policy editor calls `POST /v1/policies/validate` as you type. There is no
  client-side linter, so what the editor says is exactly what saving would do.
* **Audit paging is cursor-based, newest first** (`order=desc&before_id`), with "Load older". There is no total count.
* **TanStack Table v8** (the stable line); v9 is a different API and nothing here needs it yet.

## Tests

* `npm test`: 44 unit tests.
* `npm run e2e`: **44 Playwright tests in a real browser against the real backend** (no mocks): two-user
  approve-and-resume, separation of duties, role restrictions, policy versioning and replay diffs, tamper detection (it edits a
  row in Postgres and expects "Chain BROKEN", then restores it), cursor paging.
  Requires the stack running and Edge or Chrome (`E2E_BROWSER_CHANNEL=chrome` to switch).
  Test against the built console with `E2E_BASE_URL=http://localhost:8081 npm run e2e`.
  Keys default to the `.env.example` values; override with `E2E_ADMIN_KEY`, `E2E_DEV_KEY`, `E2E_APPROVER_KEY`,
  `E2E_AUDITOR_KEY`, and the Postgres container with `E2E_DB_CONTAINER`. Tests create uniquely named agents/policies and
  do not clean them up.

## Known limitations

* Light theme, desktop layout only, by decision (an internal ops console on a desk monitor).
* Which *running* sessions are frozen is only exposed by `/v1/admin/overview`, so the session **list** marks frozen
  sessions for admin/auditor/approver only; the session **detail** page always knows (it derives it from the event stream).
* Policy Studio, Audit and Overview are unavailable to the `developer` role (the API returns 403); the console says so
  instead of showing errors.
* `/metrics` is Prometheus text and unauthenticated, exactly as on the harness; the console links to it but does not parse it.
* API response types are hand-written (the API returns plain dicts, so `openapi.json` has no response schemas) and there is
  no runtime response validation; the e2e suite is what catches drift.
* No ESLint configuration yet; `tsc --strict` (with `noUncheckedIndexedAccess`) is the static gate.
* Port 5173 is often taken (another container on this machine used it), so the dev server defaults to 5180.

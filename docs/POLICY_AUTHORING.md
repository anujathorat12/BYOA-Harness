# Policy authoring contract

Policies are YAML (or JSON) documents. They are validated strictly: **unknown keys are errors**, because a
silently ignored typo in a security policy is a vulnerability. Try one without storing it:
`POST /v1/policies/validate`, and test a hypothetical action with `POST /v1/policies/evaluate`.

```yaml
id: enterprise-it                  # [a-zA-Z0-9._-], max 64
description: free text
scope: { agents: [it-ops-agent] }  # optional guard: refuse to attach to any other agent
budgets: { tokens: 20000, amount: 25000 }   # optional hard cutoffs
limits:  { max_actions: 50 }                # optional; counts every ATTEMPT, including denied ones
rules:
  - id: allow-read-logs            # unique within the policy; this is what the audit log records
    decision: allow                # allow | deny | require-approval
    match:
      type: data.read              # glob on the action type
      resource: "prod.logs*"       # glob on the canonical resource
      when:                        # optional; ALL conditions must hold
        - { field: params.limit, op: lte, value: 100 }
    reason: shown to the agent and stored in the audit log
```

`version:` may appear in a document for readability but is ignored: **the store assigns immutable versions**
(`POST /v1/policies` with changed content creates v2; identical content is a no-op).

## Actions (what rules match)

An action is built by the **harness**, never by the agent: `{type, resource, params, cost}`.

| Tool | type | resource | notable params / cost |
|---|---|---|---|
| `data.read` | `data.read` | dataset | `limit` |
| `data.export` | `data.export` | destination | `dataset` |
| `ticket.create` | `ticket.create` | `ticketing` | `title`, `priority` |
| `production.modify` / `.delete` | `production.modify` / `.delete` | service | `change` |
| `payment.transfer` | `payment.transfer` | recipient | `amount`, `currency`; cost.amount = amount |
| `http.get` | `network.request` | host | `method`, `scheme`, `port`, `path` |
| `llm.complete` | `llm.complete` | `llm` | `prompt`, `max_tokens`; cost.tokens = worst-case estimate |

Types and resources are canonicalised before matching: Unicode NFKC, lower-case, `\` → `/`, `..` collapsed
(escaping the root is rejected), trailing dots stripped, control characters rejected. Write patterns in lower case.

## Conditions

Fields: `type`, `resource`, `params.*`, `cost.tokens`, `cost.amount`, `agent.id`, `session.id`,
`session.action_count`, `spend.tokens`, `spend.amount`, `spend.tokens_after`, `spend.amount_after`.
Operators: `eq ne gt gte lt lte in not_in glob prefix contains exists`. No regex (ReDoS) and no code.

## Evaluation semantics

1. **Default deny** — no matching rule means deny (`rule_id: default-deny`).
2. Every matching rule is collected; **deny > require-approval > allow**, regardless of order.
3. **Uncertainty is resolved strictly.** If a rule's condition cannot be evaluated (missing field, wrong type),
   a `deny`/`require-approval` rule still fires and an `allow` rule does not. So sending `"5000"` where a number
   is expected can never turn an approval into an allow.
4. `limits` and `budgets` are checked first and produce synthetic rule ids: `limit:max_actions`,
   `budget:tokens`, `budget:amount`. The cutoff is hard: an action that would exceed the budget is denied.
5. Harness-level refusals also appear in the audit log with a `harness:` rule id:
   `harness:unknown-tool`, `harness:invalid-arguments`, `harness:malformed-call`, `harness:action-cap`,
   `harness:engine-error`, `harness:inflight-cap`. `no-policy` means the agent has nothing attached.

## Scope and composition

* **Per agent:** an admin attaches policies with `POST /v1/agents/{id}/policies` (`version` optional = follow latest,
  resolved and **pinned when a session starts**).
* **Per session:** a task submission may list extra `policies`. The session is governed by **all** attached
  policies; the strictest decision wins and every policy must allow. Session policies can therefore only **narrow**.
* An agent with **no admin-attached policy runs deny-all** — a session policy can never be the only grant.

## Auditing which rule and version decided

Every `action.decided` row records `policy_id`, `policy_version`, `rule_id`, `effect`, the canonical action and
the evaluation context. `POST /v1/policies/simulate` replays those rows against a candidate policy (inline
documents or stored versions) and reports what would change, without running any agent.

## Authoring tips

* Prefer narrow `allow` rules plus a few explicit `deny` rules for things you must never permit; deny always wins.
* Put thresholds in `when:` on `params.*`, and add a matching `require-approval` rule above the allow threshold
  (see `examples/policies/financial-ops.yaml`).
* Use `simulate` before rolling out a new version; use `evaluate` for one-off questions.

"""Policy Decision Point. Pure functions: no I/O, no clock, no network.

Semantics (documented in docs/POLICY_AUTHORING.md):
  * default deny
  * every matching rule is collected; deny > require-approval > allow
  * uncertainty resolves to the stricter reading: a rule whose conditions cannot
    be evaluated (missing field, type mismatch) still fires if it is deny /
    require-approval, and does not fire if it is allow
  * several attached policies: strictest wins and every policy must allow
"""
from __future__ import annotations

import fnmatch
from typing import Any

from .model import ALLOW, DENY, STRICTNESS, Action, Condition, Decision, EvalContext, Policy, Rule

_MISSING = object()
_NUMERIC_OPS = {"gt", "gte", "lt", "lte"}


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _namespace(action: Action, ctx: EvalContext) -> dict[str, Any]:
    return {
        "type": action.type,
        "resource": action.resource,
        "params": action.params,
        "cost": {"tokens": action.cost.tokens, "amount": action.cost.amount},
        "agent": {"id": ctx.agent_id},
        "session": {"id": ctx.session_id, "action_count": ctx.action_count},
        "spend": {
            "tokens": ctx.spent_tokens,
            "amount": ctx.spent_amount,
            "tokens_after": ctx.spent_tokens + action.cost.tokens,
            "amount_after": ctx.spent_amount + action.cost.amount,
        },
    }


def _lookup(ns: dict[str, Any], path: str) -> Any:
    cur: Any = ns
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return _MISSING
    return cur


def _eval_condition(c: Condition, ns: dict[str, Any]) -> bool | None:
    """True / False, or None when the condition cannot be evaluated."""
    actual = _lookup(ns, c.field)
    if c.op == "exists":
        return (actual is not _MISSING) == bool(c.value)
    if actual is _MISSING:
        return None
    op, expected = c.op, c.value
    if op in _NUMERIC_OPS:
        if not (_is_num(actual) and _is_num(expected)):
            return None
        return {"gt": actual > expected, "gte": actual >= expected,
                "lt": actual < expected, "lte": actual <= expected}[op]
    if op in ("eq", "ne"):
        if _is_num(actual) != _is_num(expected) or isinstance(actual, str) != isinstance(expected, str):
            return None
        return (actual == expected) == (op == "eq")
    if op in ("in", "not_in"):
        if not isinstance(expected, (list, tuple)):
            return None
        found = actual in expected
        return found if op == "in" else not found
    if op in ("glob", "prefix", "contains"):
        if not isinstance(actual, str) or not isinstance(expected, str):
            return None
        a, e = actual.lower(), expected.lower()
        if op == "glob":
            return fnmatch.fnmatchcase(a, e)
        return a.startswith(e) if op == "prefix" else e in a
    return None  # unknown op is rejected by the loader; defensive


def _rule_fires(rule: Rule, action: Action, ns: dict[str, Any]) -> bool:
    if not fnmatch.fnmatchcase(action.type, rule.type):
        return False
    if not fnmatch.fnmatchcase(action.resource, rule.resource):
        return False
    unknown = False
    for cond in rule.when:
        r = _eval_condition(cond, ns)
        if r is False:
            return False
        if r is None:
            unknown = True
    # Uncertain conditions: fail closed. Restrictive rules fire, permissive ones don't.
    return not unknown or rule.decision != ALLOW


def _limits(policy: Policy, action: Action, ctx: EvalContext) -> Decision | None:
    def hit(rule_id: str, reason: str) -> Decision:
        return Decision(DENY, rule_id, policy.id, policy.version, reason)

    if policy.max_actions is not None and ctx.action_count + 1 > policy.max_actions:
        return hit("limit:max_actions", f"session exceeded {policy.max_actions} actions")
    if (policy.budget_tokens is not None and action.cost.tokens > 0
            and ctx.spent_tokens + action.cost.tokens > policy.budget_tokens):
        return hit("budget:tokens", f"token budget {policy.budget_tokens} would be exceeded")
    if (policy.budget_amount is not None and action.cost.amount > 0
            and ctx.spent_amount + action.cost.amount > policy.budget_amount):
        return hit("budget:amount", f"spend budget {policy.budget_amount} would be exceeded")
    return None


def evaluate(policy: Policy, action: Action, ctx: EvalContext) -> Decision:
    limited = _limits(policy, action, ctx)
    if limited:
        return limited
    ns = _namespace(action, ctx)
    fired = [r for r in policy.rules if _rule_fires(r, action, ns)]
    if not fired:
        return Decision(DENY, "default-deny", policy.id, policy.version, "no rule allows this action")
    winner = max(fired, key=lambda r: STRICTNESS[r.decision])  # first of equal strictness wins
    return Decision(winner.decision, winner.id, policy.id, policy.version, winner.reason,
                    tuple(r.id for r in fired))


def evaluate_all(policies: list[Policy], action: Action, ctx: EvalContext) -> Decision:
    """Strictest decision across all attached policies; none attached => deny."""
    if not policies:
        return Decision(DENY, "no-policy", "", 0, "agent has no policy attached (default deny)")
    decisions = [evaluate(p, action, ctx) for p in policies]
    return max(decisions, key=lambda d: STRICTNESS[d.effect])

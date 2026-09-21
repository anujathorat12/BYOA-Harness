"""Policy engine tests. No agent, no sandbox, no DB: 'does this policy allow this action'."""
from pathlib import Path

import pytest

from byoa_harness.policy import (
    Action,
    CanonicalizationError,
    Cost,
    EvalContext,
    HistoricalAction,
    PolicyError,
    canonical_resource,
    evaluate,
    evaluate_all,
    parse_policy,
    simulate,
)

EX = Path(__file__).resolve().parents[2] / "examples" / "policies"
CTX = EvalContext(agent_id="a1", session_id="s1")


def pol(name):
    return parse_policy((EX / f"{name}.yaml").read_text()).with_version(1)


def act(type, resource, params=None, cost=None):
    return Action.build(type, resource, params, cost)


# ---- basic allow / deny / approval, per sector, same engine --------------------------------------
@pytest.mark.parametrize("policy,action,effect,rule", [
    ("enterprise-it", act("data.read", "prod.logs"), "allow", "allow-read-logs"),
    ("enterprise-it", act("production.modify", "svc/api"), "require-approval", "prod-change-needs-approval"),
    ("enterprise-it", act("production.delete", "svc/api"), "deny", "never-delete-prod"),
    ("enterprise-it", act("data.read", "hr.salaries"), "deny", "default-deny"),
    ("financial-ops", act("payment.transfer", "acct-1", {"amount": 500}), "allow", "small-transfer-allowed"),
    ("financial-ops", act("payment.transfer", "acct-1", {"amount": 5000}), "require-approval",
     "high-value-transfer-needs-approval"),
    ("financial-ops", act("data.read", "finance.accounts.master"), "deny", "deny-account-master-data"),
    ("healthcare-data", act("data.read", "health.records.permitted"), "allow", "allow-permitted-dataset"),
    ("healthcare-data", act("data.read", "health.records.restricted.psych"), "deny", "deny-restricted-records"),
    ("healthcare-data", act("data.export", "s3://partner"), "require-approval", "export-needs-approval"),
])
def test_sector_policies(policy, action, effect, rule):
    d = evaluate(pol(policy), action, CTX)
    assert (d.effect, d.rule_id) == (effect, rule)
    assert d.policy_id == policy and d.policy_version == 1


# ---- conflict resolution ------------------------------------------------------------------------
def test_deny_overrides_allow_regardless_of_order():
    a = "id: p\nrules:\n - {id: r-allow, decision: allow, match: {type: x}}\n - {id: r-deny, decision: deny, match: {type: x}}\n"
    b = "id: p\nrules:\n - {id: r-deny, decision: deny, match: {type: x}}\n - {id: r-allow, decision: allow, match: {type: x}}\n"
    for doc in (a, b):
        d = evaluate(parse_policy(doc), act("x", "r"), CTX)
        assert (d.effect, d.rule_id) == ("deny", "r-deny")
        assert set(d.matched_rules) == {"r-allow", "r-deny"}


def test_approval_beats_allow_but_loses_to_deny():
    doc = ("id: p\nrules:\n - {id: a, decision: allow, match: {type: x}}\n"
           " - {id: b, decision: require-approval, match: {type: x}}\n")
    assert evaluate(parse_policy(doc), act("x", "r"), CTX).effect == "require-approval"


def test_empty_policy_and_no_policy_deny_everything():
    assert evaluate(parse_policy("id: empty\nrules: []"), act("x", "r"), CTX).rule_id == "default-deny"
    assert evaluate_all([], act("x", "r"), CTX).rule_id == "no-policy"


# ---- composition: agent policy + session policy ------------------------------------------------
def test_multiple_policies_strictest_wins_and_all_must_allow():
    agent_p = pol("enterprise-it")
    session_p = parse_policy("id: narrow\nrules:\n - {id: only-tickets, decision: allow, match: {type: ticket.create}}")
    assert evaluate_all([agent_p, session_p], act("ticket.create", "t"), CTX).effect == "allow"
    d = evaluate_all([agent_p, session_p], act("data.read", "prod.logs"), CTX)
    assert d.effect == "deny" and d.policy_id == "narrow"  # session policy can only narrow


# ---- conditions ---------------------------------------------------------------------------------
def test_conditions_and_operators():
    p = parse_policy("""
id: c
rules:
  - id: r1
    decision: allow
    match:
      type: net
      when:
        - {field: params.method, op: in, value: [GET, HEAD]}
        - {field: params.path, op: prefix, value: /public}
        - {field: cost.amount, op: lt, value: 5}
""")
    ok = act("net", "h", {"method": "GET", "path": "/public/x"})
    assert evaluate(p, ok, CTX).effect == "allow"
    assert evaluate(p, act("net", "h", {"method": "POST", "path": "/public/x"}), CTX).effect == "deny"


# ---- adversarial: type confusion must not bypass restrictive rules ------------------------------
@pytest.mark.parametrize("amount", ["5000", "5e3", None, [5000], {"n": 5000}, True])
def test_type_confusion_cannot_bypass_approval_rule(amount):
    # 'small-transfer-allowed' requires a numeric amount; the approval rule must still fire on garbage.
    d = evaluate(pol("financial-ops"), act("payment.transfer", "acct", {"amount": amount}), CTX)
    assert d.effect == "require-approval"


def test_missing_field_fails_closed_for_restrictive_and_open_for_permissive():
    d = evaluate(pol("financial-ops"), act("payment.transfer", "acct", {}), CTX)
    assert d.effect == "require-approval"  # allow rule can't be proven -> doesn't fire


# ---- adversarial: resource canonicalization ----------------------------------------------------
@pytest.mark.parametrize("raw", ["PROD.LOGS", " prod.logs ", "prod.logs.", "ＰＲＯＤ.ｌｏｇｓ"])
def test_resource_variants_canonicalize_to_same_resource(raw):
    assert evaluate(pol("enterprise-it"), act("data.read", raw), CTX).rule_id == "allow-read-logs"


@pytest.mark.parametrize("raw", ["../etc/passwd", "a/../../b", "", "   ", "a\x00b", "a\nb", ".."])
def test_hostile_resources_rejected(raw):
    with pytest.raises(CanonicalizationError):
        canonical_resource(raw)


def test_path_dotdot_collapses_before_matching():
    p = parse_policy("id: p\nrules:\n - {id: r, decision: allow, match: {type: fs.read, resource: '/data/public/*'}}")
    assert evaluate(p, act("fs.read", "/data/public/../secret/x"), CTX).effect == "deny"
    assert evaluate(p, act("fs.read", "/data/public//x"), CTX).effect == "allow"


def test_action_type_case_cannot_evade_rules():
    assert evaluate(pol("enterprise-it"), act("PRODUCTION.DELETE", "x"), CTX).rule_id == "never-delete-prod"


@pytest.mark.parametrize("params", [{"x": float("nan")}, {"x": object()}, {1: "a"}])
def test_uncanonicalizable_params_rejected(params):
    with pytest.raises(CanonicalizationError):
        act("t", "r", params)


def test_digest_is_stable_and_sensitive():
    a = act("t", "r", {"b": 1, "a": 2})
    b = act("t", "r", {"a": 2, "b": 1})
    assert a.digest() == b.digest()
    assert a.digest() != act("t", "r", {"a": 2, "b": 2}).digest()


# ---- budgets and limits -------------------------------------------------------------------------
def test_token_budget_hard_cutoff():
    p = pol("financial-ops")
    a = act("llm.complete", "model", {}, Cost(tokens=1000))
    assert evaluate(p, a, EvalContext("a", spent_tokens=18000)).effect == "allow"
    d = evaluate(p, a, EvalContext("a", spent_tokens=19500))
    assert (d.effect, d.rule_id) == ("deny", "budget:tokens")


def test_spend_budget_counts_cumulative_amount():
    a = act("payment.transfer", "x", {"amount": 900}, Cost(amount=900))
    d = evaluate(pol("financial-ops"), a, EvalContext("a", spent_amount=24500))
    assert d.rule_id == "budget:amount"


def test_max_actions_limit():
    d = evaluate(pol("enterprise-it"), act("data.read", "prod.logs"), EvalContext("a", action_count=50))
    assert d.rule_id == "limit:max_actions"


# ---- loader strictness --------------------------------------------------------------------------
@pytest.mark.parametrize("doc,frag", [
    ("id: p\nrules:\n - {id: r, desicion: allow}", "Extra inputs"),
    ("id: p\nrules:\n - {id: r, decision: maybe}", "decision"),
    ("id: p\nrules:\n - {id: r, decision: allow}\n - {id: r, decision: deny}", "unique"),
    ("id: p\nrules:\n - {id: r, decision: allow, match: {when: [{field: a, op: regex, value: x}]}}", "op"),
    ("id: p\nrules:\n - {id: r, decision: allow, match: {when: [{field: a, op: in, value: x}]}}", "list"),
    ("id: p\ndefaults: {decision: allow}\nrules: []", "decision"),
    ("- not a mapping", "mapping"),
    ("id: [", "YAML"),
])
def test_loader_rejects_bad_documents(doc, frag):
    with pytest.raises(PolicyError, match=frag):
        parse_policy(doc)


def test_content_hash_ignores_version_label_only():
    a = parse_policy("id: p\nversion: 1\nrules: []")
    b = parse_policy("id: p\nversion: 9\nrules: []")
    c = parse_policy("id: p\nrules: [{id: r, decision: deny}]")
    assert a.content_hash == b.content_hash != c.content_hash


def test_policy_wrapper_key_accepted():
    assert parse_policy("policy:\n  id: p\n  rules: []").id == "p"


# ---- dry-run simulation -------------------------------------------------------------------------
def test_simulation_reports_what_new_policy_would_do():
    history = [
        HistoricalAction("e1", act("production.modify", "svc"), CTX, "require-approval", "prod-change-needs-approval"),
        HistoricalAction("e2", act("data.read", "prod.logs"), CTX, "allow", "allow-read-logs"),
    ]
    stricter = parse_policy("id: strict\nrules:\n - {id: r, decision: allow, match: {type: data.read}}")
    out = simulate([stricter.with_version(2)], history)
    assert out["total"] == 2 and out["changed"] == 1
    assert out["would"] == {"allow": 1, "deny": 1, "require-approval": 0}
    assert out["results"][0]["simulated"]["policy"] == "strict@2"

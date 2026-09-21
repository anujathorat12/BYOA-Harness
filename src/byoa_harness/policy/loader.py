"""Parse and validate policy documents (YAML or JSON). Strict: unknown keys are errors,
because a silently ignored typo in a security policy is a vulnerability."""
from __future__ import annotations

import json
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .canonical import canonical_json, sha256_hex
from .model import Condition, Policy, Rule

_ID = r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$"
MAX_RULES = 500
Op = Literal["eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "glob", "prefix", "contains", "exists"]


class PolicyError(ValueError):
    pass


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Cond(_Strict):
    field: str = Field(min_length=1, max_length=128)
    op: Op
    value: Any = None


class _Match(_Strict):
    type: str = "*"
    resource: str = "*"
    when: list[_Cond] = []


class _Rule(_Strict):
    id: str = Field(pattern=_ID)
    decision: Literal["allow", "deny", "require-approval"]
    match: _Match = _Match()
    reason: str = Field(default="", max_length=500)


class _Scope(_Strict):
    agents: list[str] = []


class _Budgets(_Strict):
    tokens: int | None = Field(default=None, ge=0)
    amount: float | None = Field(default=None, ge=0)


class _Limits(_Strict):
    max_actions: int | None = Field(default=None, ge=1)


class _Defaults(_Strict):
    decision: Literal["deny"] = "deny"  # only default-deny is supported


class _Doc(_Strict):
    id: str = Field(pattern=_ID)
    version: Any = None  # accepted for readability; the store assigns real versions
    description: str = Field(default="", max_length=1000)
    scope: _Scope = _Scope()
    defaults: _Defaults = _Defaults()
    budgets: _Budgets = _Budgets()
    limits: _Limits = _Limits()
    rules: list[_Rule] = Field(max_length=MAX_RULES)

    @field_validator("rules")
    @classmethod
    def _unique_ids(cls, rules: list[_Rule]) -> list[_Rule]:
        ids = [r.id for r in rules]
        if len(ids) != len(set(ids)):
            raise ValueError("rule ids must be unique")
        return rules


def parse_policy(source: str | dict[str, Any]) -> Policy:
    if isinstance(source, str):
        if len(source) > 512_000:
            raise PolicyError("policy document too large")
        try:
            data = yaml.safe_load(source)
        except yaml.YAMLError as e:
            raise PolicyError(f"invalid YAML: {e}") from e
    else:
        data = source
    if not isinstance(data, dict):
        raise PolicyError("policy document must be a mapping")
    if set(data) == {"policy"} and isinstance(data["policy"], dict):
        data = data["policy"]
    try:
        doc = _Doc.model_validate(data)
    except ValidationError as e:
        raise PolicyError("; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors())) from e
    for r in doc.rules:
        for c in r.match.when:
            if c.op in ("in", "not_in") and not isinstance(c.value, list):
                raise PolicyError(f"rule {r.id}: '{c.op}' needs a list value")
            if c.op in ("glob", "prefix", "contains") and not isinstance(c.value, str):
                raise PolicyError(f"rule {r.id}: '{c.op}' needs a string value")
    rules = tuple(
        Rule(r.id, r.decision, r.match.type.lower(), r.match.resource.lower(),
             tuple(Condition(c.field, c.op, c.value) for c in r.match.when), r.reason)
        for r in doc.rules
    )
    canonical = canonical_json(json.loads(doc.model_dump_json(exclude={"version"})))
    return Policy(doc.id, rules, doc.description, 0, doc.budgets.tokens, doc.budgets.amount,
                  doc.limits.max_actions, tuple(doc.scope.agents), sha256_hex(canonical))

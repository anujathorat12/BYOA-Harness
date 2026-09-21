"""Plain data types shared by the engine, loader and simulator. No I/O."""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .canonical import canonical_json, canonical_resource, sha256_hex

ALLOW = "allow"
DENY = "deny"
REQUIRE_APPROVAL = "require-approval"
# Strictness order: higher wins when several rules/policies disagree.
STRICTNESS = {ALLOW: 0, REQUIRE_APPROVAL: 1, DENY: 2}


@dataclass(frozen=True)
class Cost:
    tokens: int = 0
    amount: float = 0.0


@dataclass(frozen=True)
class Action:
    """A canonical, immutable action. Built by the harness, never by the agent."""

    type: str
    resource: str
    params: dict[str, Any] = field(default_factory=dict)
    cost: Cost = field(default_factory=Cost)

    @staticmethod
    def build(type: str, resource: str, params: dict[str, Any] | None = None,
              cost: Cost | None = None) -> Action:
        canonical_json(params or {})  # validates JSON-ability / depth / NaN
        return Action(type.strip().lower(), canonical_resource(resource), dict(params or {}),
                      cost or Cost())

    def digest(self) -> str:
        return sha256_hex(canonical_json(self.to_dict()))

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "resource": self.resource, "params": self.params,
                "cost": {"tokens": self.cost.tokens, "amount": self.cost.amount}}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Action:
        c = d.get("cost") or {}
        return Action(d["type"], d["resource"], d.get("params") or {},
                      Cost(int(c.get("tokens", 0)), float(c.get("amount", 0.0))))


@dataclass(frozen=True)
class EvalContext:
    agent_id: str
    session_id: str = ""
    spent_tokens: int = 0
    spent_amount: float = 0.0
    action_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {"agent_id": self.agent_id, "session_id": self.session_id,
                "spent_tokens": self.spent_tokens, "spent_amount": self.spent_amount,
                "action_count": self.action_count}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> EvalContext:
        return EvalContext(d["agent_id"], d.get("session_id", ""), int(d.get("spent_tokens", 0)),
                           float(d.get("spent_amount", 0.0)), int(d.get("action_count", 0)))


@dataclass(frozen=True)
class Condition:
    field: str
    op: str
    value: Any = None


@dataclass(frozen=True)
class Rule:
    id: str
    decision: str
    type: str = "*"
    resource: str = "*"
    when: tuple[Condition, ...] = ()
    reason: str = ""


@dataclass(frozen=True)
class Policy:
    id: str
    rules: tuple[Rule, ...]
    description: str = ""
    version: int = 0  # assigned by the store; 0 = unsaved/inline
    budget_tokens: int | None = None
    budget_amount: float | None = None
    max_actions: int | None = None
    scope_agents: tuple[str, ...] = ()
    content_hash: str = ""

    def with_version(self, version: int) -> Policy:
        return replace(self, version=version)


@dataclass(frozen=True)
class Decision:
    effect: str
    rule_id: str  # rule that fired, or "default-deny" / "budget:*" / "limit:*" / "harness:*"
    policy_id: str
    policy_version: int
    reason: str = ""
    matched_rules: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"effect": self.effect, "rule_id": self.rule_id, "policy_id": self.policy_id,
                "policy_version": self.policy_version, "reason": self.reason,
                "matched_rules": list(self.matched_rules)}

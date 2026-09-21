"""Dry-run: replay recorded actions against candidate policies without running any agent."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .engine import evaluate_all
from .model import Action, EvalContext, Policy


@dataclass(frozen=True)
class HistoricalAction:
    ref: str  # audit event id
    action: Action
    context: EvalContext
    original_effect: str
    original_rule: str


def simulate(policies: list[Policy], history: list[HistoricalAction]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    changed = 0
    counts = {"allow": 0, "deny": 0, "require-approval": 0}
    for h in history:
        d = evaluate_all(policies, h.action, h.context)
        counts[d.effect] += 1
        diff = d.effect != h.original_effect
        changed += diff
        rows.append({"ref": h.ref, "type": h.action.type, "resource": h.action.resource,
                     "original": {"effect": h.original_effect, "rule_id": h.original_rule},
                     "simulated": {"effect": d.effect, "rule_id": d.rule_id,
                                   "policy": f"{d.policy_id}@{d.policy_version}"},
                     "changed": diff})
    return {"total": len(rows), "changed": changed, "would": counts, "results": rows}

"""Package-shape example: enterprise IT operations agent.

Allowed: read logs, create a ticket.  Escalated: production change (needs a human).  Denied: destructive op.
"""
from byoa_sdk import ToolDenied


def run(ctx):
    logs = ctx.call("data.read", dataset="prod.logs")
    errors = [r for r in logs["records"] if r["level"] == "ERROR"]
    ctx.progress(f"found {len(errors)} error records")
    ticket = ctx.call("ticket.create", title=f"{len(errors)} DB pool errors in prod", priority="high")
    result = {"errors": len(errors), "ticket": ticket["ticket"]}

    try:  # borderline action: the harness pauses this agent until a human decides
        ctx.progress("requesting production change (approval required)")
        ctx.call("production.modify", service="api", change="db_pool_size=50")
        result["change"] = "applied"
    except ToolDenied as e:
        result["change"] = f"not applied ({e.code})"

    try:  # forbidden action: never reaches the resource
        ctx.call("production.delete", service="payments-db")
        result["delete"] = "EXECUTED"  # must never happen
    except ToolDenied as e:
        result["delete"] = f"blocked by rule {e.rule_id}"
    return result

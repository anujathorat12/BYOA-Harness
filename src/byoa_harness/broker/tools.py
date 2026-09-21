"""Tools = the ONLY things an agent can cause to happen.

A tool definition owns three things the agent must never control:
  * how raw arguments become a canonical Action (type + resource + cost)  -> `build_action`
  * what actually executes                                                  -> `execute`
  * `execute` receives the *evaluated* Action, never the raw arguments.

Connectors here are reference implementations backed by in-memory simulators so the platform can be
exercised end to end without customer systems. Real deployments add Tool subclasses (see docs/TOOLS.md).
"""
from __future__ import annotations

import math
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..policy import Action, Cost
from .egress import EgressError, parse_url, resolve_public
from .llm import LlmProvider, estimate_tokens

MAX_HTTP_BYTES = 256 * 1024


class ToolArgError(ValueError):
    """Arguments are malformed. Recorded as a denial (rule harness:invalid-arguments)."""


@dataclass
class ToolResult:
    output: Any
    tokens: int = 0
    amount: float = 0.0


@dataclass
class Backends:
    """In-memory protected resources for the reference connectors."""

    tickets: list[dict[str, Any]] = field(default_factory=list)
    prod_changes: list[dict[str, Any]] = field(default_factory=list)
    prod_deleted: list[str] = field(default_factory=list)
    ledger: list[dict[str, Any]] = field(default_factory=list)
    exports: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    datasets: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: {
        "prod.logs": [{"ts": f"2026-09-20T10:0{i}:00Z", "level": lvl, "msg": m} for i, (lvl, m) in enumerate([
            ("INFO", "deploy started"), ("WARN", "latency p99 above 800ms"), ("ERROR", "db connection pool exhausted"),
            ("ERROR", "db connection pool exhausted"), ("INFO", "autoscaler +2 replicas")])],
        "finance.transactions": [
            {"id": "t1", "amount": 120.5, "merchant": "acme", "flag": False},
            {"id": "t2", "amount": 9800.0, "merchant": "globex", "flag": True},
            {"id": "t3", "amount": 42.0, "merchant": "initech", "flag": False}],
        "finance.accounts.master": [{"account": "A-1", "owner": "REDACTED-IN-DEMO", "iban": "XX00 0000"}],
        "health.records.permitted": [{"patient": "P-100", "note": "routine checkup", "consented": True},
                                     {"patient": "P-101", "note": "flu vaccination", "consented": True}],
        "health.records.restricted.psych": [{"patient": "P-100", "note": "SENSITIVE-DEMO"}],
    })


@dataclass
class ToolContext:
    backends: Backends
    llm: LlmProvider
    egress_allow_private: bool = False


class Tool(ABC):
    name: str
    action_type: str

    @abstractmethod
    def build_action(self, args: dict[str, Any]) -> Action: ...

    @abstractmethod
    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult: ...


def _require(args: dict[str, Any], key: str, typ: type | tuple[type, ...], *, maxlen: int = 256) -> Any:
    if key not in args:
        raise ToolArgError(f"missing argument '{key}'")
    v = args[key]
    if isinstance(v, bool) or not isinstance(v, typ):
        raise ToolArgError(f"argument '{key}' has the wrong type")
    if isinstance(v, str) and (not v.strip() or len(v) > maxlen):
        raise ToolArgError(f"argument '{key}' must be a non-empty string of at most {maxlen} chars")
    return v


def _only(args: dict[str, Any], allowed: set[str]) -> None:
    extra = set(args) - allowed
    if extra:
        raise ToolArgError(f"unexpected arguments: {sorted(extra)}")


class DataRead(Tool):
    name, action_type = "data.read", "data.read"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"dataset", "limit"})
        dataset = _require(args, "dataset", str)
        limit = args.get("limit", 100)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise ToolArgError("limit must be an integer 1..1000")
        return Action.build(self.action_type, dataset, {"limit": limit})

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        rows = ctx.backends.datasets.get(action.resource)
        if rows is None:
            raise LookupError("dataset not found")
        return ToolResult({"dataset": action.resource, "records": rows[: action.params["limit"]]})


class DataExport(Tool):
    name, action_type = "data.export", "data.export"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"dataset", "destination"})
        return Action.build(self.action_type, _require(args, "destination", str),
                            {"dataset": _require(args, "dataset", str).lower()})

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        with ctx.backends.lock:
            ctx.backends.exports.append({"dataset": action.params["dataset"], "destination": action.resource})
        return ToolResult({"exported": True, "destination": action.resource})


class TicketCreate(Tool):
    name, action_type = "ticket.create", "ticket.create"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"title", "priority"})
        prio = args.get("priority", "normal")
        if prio not in ("low", "normal", "high"):
            raise ToolArgError("priority must be low|normal|high")
        return Action.build(self.action_type, "ticketing", {"title": _require(args, "title", str, maxlen=200),
                                                            "priority": prio})

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        with ctx.backends.lock:
            tid = f"TCK-{len(ctx.backends.tickets) + 1}"
            ctx.backends.tickets.append({"id": tid, **action.params})
        return ToolResult({"ticket": tid})


class ProductionModify(Tool):
    name, action_type = "production.modify", "production.modify"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"service", "change"})
        return Action.build(self.action_type, _require(args, "service", str),
                            {"change": _require(args, "change", str, maxlen=500)})

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        with ctx.backends.lock:
            ctx.backends.prod_changes.append({"service": action.resource, **action.params})
        return ToolResult({"applied": True, "service": action.resource})


class ProductionDelete(Tool):
    name, action_type = "production.delete", "production.delete"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"service"})
        return Action.build(self.action_type, _require(args, "service", str), {})

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        with ctx.backends.lock:
            ctx.backends.prod_deleted.append(action.resource)
        return ToolResult({"deleted": action.resource})


class PaymentTransfer(Tool):
    name, action_type = "payment.transfer", "payment.transfer"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"to", "amount", "currency"})
        amount = _require(args, "amount", (int, float))
        if not math.isfinite(amount) or amount <= 0 or amount > 1e9:
            raise ToolArgError("amount must be a positive finite number")
        cur = args.get("currency", "USD")
        if cur not in ("USD", "EUR", "GBP", "INR"):
            raise ToolArgError("unsupported currency")
        return Action.build(self.action_type, _require(args, "to", str),
                            {"amount": amount, "currency": cur}, Cost(amount=float(amount)))

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        with ctx.backends.lock:
            ctx.backends.ledger.append({"to": action.resource, **action.params})
        return ToolResult({"transferred": action.params["amount"], "to": action.resource},
                          amount=float(action.params["amount"]))


class HttpGet(Tool):
    name, action_type = "http.get", "network.request"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"url"})
        try:
            scheme, host, port, path = parse_url(_require(args, "url", str, maxlen=2048))
        except EgressError as e:
            raise ToolArgError(str(e)) from e
        return Action.build(self.action_type, host, {"method": "GET", "scheme": scheme, "port": port, "path": path})

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        p = action.params
        addrs = await resolve_public(action.resource, p["port"], ctx.egress_allow_private)
        # Connect to the exact address that was validated (closes the DNS-rebinding window); keep the
        # original name for the Host header and TLS SNI/certificate verification.
        ip = f"[{addrs[0]}]" if ":" in addrs[0] else addrs[0]
        url = f"{p['scheme']}://{ip}:{p['port']}{p['path']}"
        headers = {"Host": action.resource if p["port"] in (80, 443) else f"{action.resource}:{p['port']}"}
        ext = {"sni_hostname": action.resource} if p["scheme"] == "https" else {}
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client,                 client.stream("GET", url, headers=headers, extensions=ext) as r:
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > MAX_HTTP_BYTES:
                    body = body[:MAX_HTTP_BYTES]
                    break
        return ToolResult({"status": r.status_code, "body": body.decode("utf-8", "replace")})


class LlmComplete(Tool):
    name, action_type = "llm.complete", "llm.complete"

    def build_action(self, args: dict[str, Any]) -> Action:
        _only(args, {"prompt", "max_tokens"})
        prompt = _require(args, "prompt", str, maxlen=32_000)
        mt = args.get("max_tokens", 256)
        if isinstance(mt, bool) or not isinstance(mt, int) or not 1 <= mt <= 2048:
            raise ToolArgError("max_tokens must be an integer 1..2048")
        # Cost is the worst case, so the budget check is conservative; actual usage is reconciled afterwards.
        return Action.build(self.action_type, "llm", {"prompt": prompt, "max_tokens": mt},
                            Cost(tokens=estimate_tokens(prompt) + mt))

    async def execute(self, action: Action, ctx: ToolContext) -> ToolResult:
        res = await ctx.llm.complete(action.params["prompt"], action.params["max_tokens"])
        return ToolResult({"text": res.text}, tokens=res.tokens)


def default_tools() -> dict[str, Tool]:
    tools = [DataRead(), DataExport(), TicketCreate(), ProductionModify(), ProductionDelete(),
             PaymentTransfer(), HttpGet(), LlmComplete()]
    return {t.name: t for t in tools}

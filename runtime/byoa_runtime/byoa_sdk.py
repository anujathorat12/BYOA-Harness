"""Agent-side SDK (Protocol v1). Also usable as a reference for writing a client in any language.

Wire protocol: newline-delimited JSON over the process's stdin/stdout. Nothing else is reachable
from inside the sandbox - there is no network and no filesystem access to protected resources.

harness -> agent
  {"type":"init","protocol":1,"session_id":..,"agent_id":..,"shape":..,"task":{..},"package"|"spec":{..}}
  {"type":"response","id":"1","ok":true,"result":{..}}
  {"type":"response","id":"1","ok":false,"error":{"code":..,"message":..,"rule_id":..}}
agent -> harness
  {"type":"call","id":"1","tool":"data.read","args":{..}}
  {"type":"progress","message":".."}
  {"type":"result","ok":true,"output":{..}}      # or {"ok":false,"error":".."}
"""
from __future__ import annotations

import json
from typing import Any, TextIO


class ToolError(Exception):
    def __init__(self, code: str, message: str, rule_id: str | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.rule_id = code, message, rule_id


class ToolDenied(ToolError):
    """The harness refused the action (policy, approval denied, invalid arguments...)."""


DENIED_CODES = {"policy_denied", "approval_denied", "approval_expired", "invalid_arguments", "unknown_tool",
                "invalid_call"}


class Channel:
    def __init__(self, rfile: TextIO, wfile: TextIO) -> None:
        self._r, self._w = rfile, wfile

    def send(self, msg: dict[str, Any]) -> None:
        self._w.write(json.dumps(msg, separators=(",", ":")) + "\n")
        self._w.flush()

    def recv(self) -> dict[str, Any]:
        line = self._r.readline()
        if not line:
            raise EOFError("harness closed the channel")
        return json.loads(line)


class Context:
    def __init__(self, channel: Channel, init: dict[str, Any]) -> None:
        self._ch = channel
        self._n = 0
        self.session_id: str = init["session_id"]
        self.agent_id: str = init["agent_id"]
        self.task: dict[str, Any] = init["task"]

    def call(self, tool: str, **args: Any) -> Any:
        """Ask the harness to perform an action. Blocks until it is allowed and done, or raises."""
        self._n += 1
        cid = str(self._n)
        self._ch.send({"type": "call", "id": cid, "tool": tool, "args": args})
        while True:
            resp = self._ch.recv()
            if resp.get("type") == "response" and resp.get("id") == cid:
                break
        if resp["ok"]:
            return resp["result"]
        e = resp["error"]
        cls = ToolDenied if e["code"] in DENIED_CODES else ToolError
        raise cls(e["code"], e["message"], e.get("rule_id"))

    def progress(self, message: str) -> None:
        self._ch.send({"type": "progress", "message": str(message)[:500]})

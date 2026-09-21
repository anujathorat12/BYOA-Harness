"""Interpreter for the declarative agent shape. Steps are data; the interpreter only ever issues
harness calls, so a config-driven agent is governed by exactly the same policy path as code.

spec:
  steps:
    - id: logs                     # result is stored in state under this id
      call: data.read              # any harness tool
      args: {dataset: prod.logs}
      on_denied: continue          # continue | fail (default fail)
    - id: summary
      llm: "Summarise: ${logs.records}"      # sugar for call: llm.complete
    - return: {summary: "${summary.text}"}
Templating: "${a.b.c}" looks up state (task is under 'task'); a string that is exactly one
placeholder keeps its native type, otherwise values are stringified.
"""
from __future__ import annotations

import json
import re
from typing import Any

from byoa_sdk import Context, ToolError

_PLACEHOLDER = re.compile(r"\$\{([a-zA-Z0-9_.\-]+)\}")


def _lookup(state: dict[str, Any], path: str) -> Any:
    cur: Any = state
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            raise KeyError(f"unknown reference '{path}'")
    return cur


def render(value: Any, state: dict[str, Any]) -> Any:
    if isinstance(value, str):
        m = _PLACEHOLDER.fullmatch(value)
        if m:
            return _lookup(state, m.group(1))
        return _PLACEHOLDER.sub(lambda mm: _to_text(_lookup(state, mm.group(1))), value)
    if isinstance(value, list):
        return [render(v, state) for v in value]
    if isinstance(value, dict):
        return {k: render(v, state) for k, v in value.items()}
    return value


def _to_text(v: Any) -> str:
    return v if isinstance(v, str) else json.dumps(v, sort_keys=True)


def run(spec: dict[str, Any], ctx: Context) -> Any:
    state: dict[str, Any] = {"task": ctx.task}
    for i, step in enumerate(spec["steps"]):
        if "return" in step:
            return render(step["return"], state)
        sid = step.get("id", f"step{i}")
        if "llm" in step:
            tool, args = "llm.complete", {"prompt": render(step["llm"], state)}
            if "max_tokens" in step:
                args["max_tokens"] = step["max_tokens"]
        else:
            tool, args = step["call"], render(step.get("args", {}), state)
        ctx.progress(f"step {sid}: {tool}")
        try:
            state[sid] = ctx.call(tool, **args)
        except ToolError as e:
            if step.get("on_denied") == "continue":
                state[sid] = {"denied": True, "code": e.code, "rule_id": e.rule_id, "message": e.message}
                ctx.progress(f"step {sid} refused ({e.code}, rule {e.rule_id}); continuing")
            else:
                raise
    return state

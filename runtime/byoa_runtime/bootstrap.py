"""Sandbox entrypoint: reads the init message, dispatches on agent shape, reports the result."""
import os
import sys

# The protocol channel is a private duplicate of fd 1. Anything the agent prints goes to stderr, so
# stray output can neither corrupt nor forge protocol messages.
_proto_out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import importlib  # noqa: E402
import json  # noqa: E402
import traceback  # noqa: E402

import declarative  # noqa: E402
from byoa_sdk import Channel, Context  # noqa: E402

AGENT_DIR = "/tmp/agent"


def _safe_name(name: str) -> str:
    if name.startswith("/") or ".." in name.split("/") or "\\" in name or "\x00" in name:
        raise ValueError(f"illegal file name {name!r}")
    return name


def run_package(pkg: dict, ctx: Context):
    os.makedirs(AGENT_DIR, exist_ok=True)
    for name, source in pkg["files"].items():
        path = os.path.join(AGENT_DIR, _safe_name(name))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(source)
    sys.path.insert(0, AGENT_DIR)
    module_name, _, func = pkg["entrypoint"].partition(":")
    return getattr(importlib.import_module(module_name), func or "run")(ctx)


def main() -> None:
    ch = Channel(sys.stdin, _proto_out)
    init = ch.recv()
    if init.get("type") != "init" or init.get("protocol") != 1:
        raise SystemExit("bad init message")
    ctx = Context(ch, init)
    try:
        shape = init["shape"]
        if shape == "package":
            out = run_package(init["package"], ctx)
        elif shape == "declarative":
            out = declarative.run(init["spec"], ctx)
        else:
            raise ValueError(f"unsupported shape {shape!r}")
        json.dumps(out)  # must be serialisable
        ch.send({"type": "result", "ok": True, "output": out})
    except BaseException as e:  # noqa: BLE001 - report every failure to the harness
        traceback.print_exc()
        ch.send({"type": "result", "ok": False, "error": f"{type(e).__name__}: {e}"[:500]})


if __name__ == "__main__":
    main()

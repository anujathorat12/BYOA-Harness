# Bring-your-own-agent contract

An agent is anything that can be registered under a **shape** and speaks the harness protocol. The harness core
(sandbox, broker, policy, audit) never inspects agent internals, so shapes are pluggable.

## Registration — `POST /v1/agents` (role: developer)

```jsonc
{ "id": "it-ops-agent",                 // ^[a-z0-9][a-z0-9-]{1,62}$ ; re-registering creates version N+1
  "shape": "package" | "declarative",
  "description": "...",
  "package": {...},                     // shape=package
  "spec": {...},                        // shape=declarative
  "resources": { "memory_mb": 128, "cpus": 0.25, "timeout_s": 30 } }   // optional; may only LOWER platform limits
```
Versions are immutable. An id belongs to the developer who first registered it. **A new agent runs deny-all until an
admin attaches a policy** — registering an agent grants it no capability.

### Shape 1 — `package` (code)

```json
"package": { "entrypoint": "main:run", "files": { "main.py": "def run(ctx): ..." } }
```
Up to 32 Python files, 512 KB total, standard library only (the sandbox has no network). The entrypoint is
`module:function(ctx)`; its JSON-serialisable return value becomes the session result.

```python
from byoa_sdk import ToolDenied, ToolError     # available inside the sandbox

def run(ctx):
    ctx.task                                    # the submitted task object
    rows = ctx.call("data.read", dataset="prod.logs")   # blocks until allowed and done; raises if refused
    ctx.progress("looked at logs")              # streamed to SSE subscribers
    try:
        ctx.call("production.modify", service="api", change="x")   # may pause for approval
    except ToolDenied as e:                     # e.code, e.rule_id, e.message
        ...
    return {"ok": True}
```

### Shape 2 — `declarative` (config, no code)

```yaml
spec:
  steps:
    - id: txns                      # result stored under this id
      call: data.read               # any harness tool
      args: { dataset: finance.transactions }
      on_denied: continue           # continue | fail (default)
    - id: summary
      llm: "Summarise: ${txns.records}"      # sugar for llm.complete
    - return: { summary: "${summary.text}" } # ${task.x} reads the task; exactly-one-placeholder keeps native type
```
1–100 steps, each exactly one of `call`, `llm`, `return`. Validated at registration.

## Wire protocol (v1) — for any language

The sandbox has **stdin/stdout only**. Newline-delimited JSON, one message per line, max 1 MiB.

```
harness → agent   {"type":"init","protocol":1,"session_id","agent_id","shape","task",("package"|"spec")}
harness → agent   {"type":"response","id":"1","ok":true,"result":{...}}
                  {"type":"response","id":"1","ok":false,"error":{"code","message","rule_id"?}}
agent → harness   {"type":"call","id":"1","tool":"data.read","args":{...}}     // ids are opaque; pipelining is allowed (max 16 in flight)
agent → harness   {"type":"progress","message":"..."}                          // capped per session
agent → harness   {"type":"result","ok":true,"output":{...}}                   // or {"ok":false,"error":"..."}
```
Error codes: `policy_denied`, `approval_denied`, `approval_expired`, `invalid_arguments`, `unknown_tool`,
`invalid_call`, `too_many_inflight`, `tool_error`, `audit_unavailable`.

**Anything else is a protocol violation and terminates the session.** There is no message type for "decision",
"identity", or "allow"; the agent's identity is the pipe it arrives on, not a field it can set.

## Lifecycle and limits an agent must expect

* May be **frozen** (cgroup freezer) while an approval is pending; that time does not count against `timeout_s`.
* Killed at `timeout_s` of active runtime, on OOM, on protocol violation, on cancel, or if the audit log is unavailable.
* Runs as uid 10001, read-only root, 32 MB `/tmp` (noexec), 64 pids, no network, no capabilities.
* The result must be JSON-serialisable.

## Adding a third shape (e.g. bring-your-own image)

Implement `ShapeAdapter` in `runtime/shapes.py`: `validate(manifest)` (return the normalised manifest),
`init_payload(manifest)` (extra init keys), and optionally `image()`/`limits()`. Register it in `SHAPES`. No change
to the broker, policy engine, audit or API is needed — that is the test that the harness is a platform.
An image shape must come from an allow-listed registry and keeps the same isolation flags.

## Adding a tool (connector)

Subclass `Tool` in `broker/tools.py` with `build_action(args)` (validate strictly; reject unknown args; produce the
canonical `Action` including any `Cost`) and `execute(action, ctx)` (must use **only** the evaluated action, never
raw args), then add it to `default_tools()`. Credentials for the target system live in harness config, never in a sandbox.

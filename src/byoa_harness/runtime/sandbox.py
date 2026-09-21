"""Container sandbox driven through the `docker` CLI.

Why the CLI and a stdin/stdout pipe: it behaves identically on Linux, macOS and Docker Desktop for
Windows (bind-mounted unix sockets do not cross the VM boundary), and the complete isolation flag set
is visible in one function, `Sandbox.docker_args`, which takes NO agent-controlled input except the
session id (harness generated) and numeric limits already clamped by the harness.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("sandbox")
DOCKER = os.environ.get("DOCKER_BIN", "docker")
STDERR_CAP = 16 * 1024


class SandboxError(RuntimeError):
    pass


class ProtocolViolation(RuntimeError):
    pass


@dataclass(frozen=True)
class Limits:
    memory_mb: int = 256
    cpus: float = 0.5
    pids: int = 64
    tmpfs_mb: int = 32
    timeout_s: int = 120


async def docker(*args: str, timeout: float = 20, stdin: bytes | None = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        DOCKER, *args, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        raise SandboxError(f"docker {args[0]} timed out") from None
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


async def docker_available() -> bool:
    try:
        rc, _, _ = await docker("version", "--format", "{{.Server.Version}}", timeout=10)
        return rc == 0
    except (OSError, SandboxError):
        return False


async def reap_orphans() -> int:
    """Remove every container this harness ever labelled (called at startup after a crash/restart)."""
    rc, out, _ = await docker("ps", "-aq", "--filter", "label=byoa.managed=1")
    ids = out.split()
    if rc == 0 and ids:
        await docker("rm", "-f", *ids, timeout=60)
    return len(ids)


class Sandbox:
    """One container per session. Lifecycle: start -> send/readline -> pause/resume -> exit_info -> destroy."""

    def __init__(self, session_id: str, image: str, limits: Limits, max_line: int) -> None:
        self.session_id, self.image, self.limits, self.max_line = session_id, image, limits, max_line
        self.name = f"byoa-{session_id}"
        self._proc: asyncio.subprocess.Process | None = None
        self._stderr = bytearray()
        self._stderr_task: asyncio.Task[None] | None = None
        self._write_lock = asyncio.Lock()

    # The isolation contract. Reviewed as a unit; covered by tests/adversarial/test_sandbox.py.
    def docker_args(self) -> list[str]:
        lim = self.limits
        return [
            "run", "-i", "--name", self.name,
            "--label", "byoa.managed=1", "--label", f"byoa.session={self.session_id}",
            "--network", "none",                       # no network stack at all
            "--read-only",                             # immutable root filesystem
            "--tmpfs", f"/tmp:rw,noexec,nosuid,nodev,size={lim.tmpfs_mb}m",
            "--cap-drop", "ALL",                       # no capabilities
            "--security-opt", "no-new-privileges",     # no setuid escalation
            "--user", "10001:10001",                   # non-root
            "--pids-limit", str(lim.pids),             # fork-bomb cap
            "--memory", f"{lim.memory_mb}m", "--memory-swap", f"{lim.memory_mb}m",  # hard cap, no swap
            "--cpus", str(lim.cpus),
            "--ulimit", "nofile=256:256", "--ulimit", "fsize=16777216", "--ulimit", "core=0",
            "--shm-size", "8m", "--ipc", "none",
            "--log-driver", "none",                    # output only via the pipe, not the daemon log
            "--init", "--hostname", "sandbox",
            self.image,
        ]

    async def start(self) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            DOCKER, *self.docker_args(), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=self.max_line + 1)
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        while chunk := await self._proc.stderr.read(4096):
            if len(self._stderr) < STDERR_CAP:  # keep the head; ignore a flood
                self._stderr += chunk[: STDERR_CAP - len(self._stderr)]

    @property
    def stderr_tail(self) -> str:
        return self._stderr.decode(errors="replace")

    async def send(self, msg: dict[str, Any]) -> None:
        assert self._proc and self._proc.stdin
        async with self._write_lock:
            try:
                self._proc.stdin.write((json.dumps(msg, separators=(",", ":")) + "\n").encode())
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                raise SandboxError("agent closed its input") from None

    async def readline(self) -> bytes | None:
        """Next protocol line, None on EOF. An over-long line is a protocol violation, not a buffer."""
        assert self._proc and self._proc.stdout
        try:
            line = await self._proc.stdout.readline()
        except (ValueError, asyncio.LimitOverrunError):
            raise ProtocolViolation(f"message exceeds {self.max_line} bytes") from None
        return line or None

    async def close_stdin(self) -> None:
        if self._proc and self._proc.stdin:
            with contextlib.suppress(Exception):
                self._proc.stdin.close()

    async def pause(self) -> None:
        rc, _, err = await docker("pause", self.name)
        if rc != 0:
            log.warning("docker pause failed", extra={"session_id": self.session_id, "err": err[:200]})

    async def resume(self) -> None:
        rc, _, err = await docker("unpause", self.name)
        if rc != 0:
            log.warning("docker unpause failed", extra={"session_id": self.session_id, "err": err[:200]})

    async def wait_exit(self, timeout: float) -> int | None:
        assert self._proc
        try:
            return await asyncio.wait_for(self._proc.wait(), timeout)
        except TimeoutError:
            return None

    async def exit_info(self) -> dict[str, Any]:
        rc, out, _ = await docker("inspect", "--format", "{{json .State}}", self.name)
        if rc != 0:
            return {}
        try:
            s = json.loads(out)
            return {"exit_code": s.get("ExitCode"), "oom_killed": bool(s.get("OOMKilled"))}
        except ValueError:
            return {}

    async def stats(self) -> dict[str, Any]:
        rc, out, _ = await docker("stats", "--no-stream", "--format", "{{json .}}", self.name, timeout=15)
        if rc != 0 or not out.strip():
            return {}
        try:
            s = json.loads(out)
            return {"cpu": s.get("CPUPerc"), "memory": s.get("MemUsage"), "pids": s.get("PIDs")}
        except ValueError:
            return {}

    async def destroy(self) -> None:
        """Kill and remove the container, then reap the client process. Idempotent."""
        with contextlib.suppress(Exception):
            await docker("rm", "-f", self.name, timeout=30)
        if self._proc and self._proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._proc.kill()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._proc.wait(), 5)
        if self._stderr_task:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._stderr_task

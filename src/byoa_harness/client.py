"""Small Python client for the harness REST API (the 'SDK' half of the task-submission contract)."""
from __future__ import annotations

import time
from collections.abc import Iterator
from typing import Any

import httpx


class HarnessError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status


class HarnessClient:
    def __init__(self, base_url: str, api_key: str = "", timeout: float = 30) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._c = httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=timeout)

    def _req(self, method: str, path: str, **kw: Any) -> Any:
        r = self._c.request(method, path, **kw)
        if r.status_code >= 400:
            try:
                msg = r.json()["error"]["message"]
            except Exception:
                msg = r.text[:200]
            raise HarnessError(r.status_code, msg)
        return r.json()

    # agents & policies
    def register_agent(self, **registration: Any) -> dict:
        return self._req("POST", "/v1/agents", json=registration)

    def put_policy(self, document: str) -> dict:
        return self._req("POST", "/v1/policies", json={"document": document})

    def attach_policy(self, agent_id: str, policy_id: str, version: int | None = None) -> dict:
        return self._req("POST", f"/v1/agents/{agent_id}/policies", json={"policy_id": policy_id, "version": version})

    # tasks
    def submit(self, agent_id: str, task: dict | None = None, policies: list[dict] | None = None) -> dict:
        return self._req("POST", f"/v1/agents/{agent_id}/sessions", json={"task": task or {}, "policies": policies or []})

    def session(self, sid: str) -> dict:
        return self._req("GET", f"/v1/sessions/{sid}")

    def wait(self, sid: str, timeout: float = 120, poll: float = 0.5) -> dict:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            s = self.session(sid)
            if s["status"] in ("succeeded", "failed", "cancelled"):
                return s
            time.sleep(poll)
        raise TimeoutError(f"session {sid} still running after {timeout}s")

    def events(self, sid: str) -> Iterator[dict]:
        """Stream the session's audit events (SSE) until it ends."""
        import json
        with self._c.stream("GET", f"/v1/sessions/{sid}/events", timeout=None) as r:
            kind = ""
            for line in r.iter_lines():
                if line.startswith("event:"):
                    kind = line[6:].strip()
                elif line.startswith("data:"):
                    data = json.loads(line[5:])
                    yield {"event": kind, **data}
                    if kind == "end":
                        return

    # approvals & audit
    def pending_approvals(self) -> list[dict]:
        return self._req("GET", "/v1/approvals", params={"status": "pending"})

    def approve(self, approval_id: str, comment: str = "") -> dict:
        return self._req("POST", f"/v1/approvals/{approval_id}/approve", json={"comment": comment})

    def deny(self, approval_id: str, comment: str = "") -> dict:
        return self._req("POST", f"/v1/approvals/{approval_id}/deny", json={"comment": comment})

    def audit(self, **filters: Any) -> dict:
        return self._req("GET", "/v1/audit", params={k: v for k, v in filters.items() if v is not None})

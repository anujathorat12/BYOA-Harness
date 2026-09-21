"""Shared fixtures. Real-sandbox tests are marked `docker` and skip when the daemon or image is missing."""
import asyncio
import subprocess
from pathlib import Path

import pytest

from byoa_harness import store as st
from byoa_harness.approvals import ApprovalService
from byoa_harness.broker.broker import Broker
from byoa_harness.broker.llm import MockLlm
from byoa_harness.broker.tools import Backends, ToolContext, default_tools
from byoa_harness.config import Settings
from byoa_harness.policy import parse_policy
from byoa_harness.runtime.manager import SessionManager
from byoa_harness.runtime.shapes import SHAPES

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
IMAGE = "byoa-runtime:latest"


def _docker_ready() -> bool:
    try:
        return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, timeout=15).returncode == 0
    except Exception:
        return False


DOCKER_READY = _docker_ready()


def pytest_collection_modifyitems(config, items):
    if DOCKER_READY:
        return
    skip = pytest.mark.skip(reason=f"docker daemon or image {IMAGE} not available (build: docker build -t {IMAGE} runtime)")
    for item in items:
        if "docker" in item.keywords:
            item.add_marker(skip)


class Harness:
    """A fully wired harness without the HTTP layer, for sandbox/manager-level tests."""

    def __init__(self, tmp_path, **overrides):
        base = dict(session_timeout_s=20, approval_timeout_s=10, max_concurrent_sessions=8)
        base.update(overrides)
        self.settings = Settings(**base)
        self.store = st.Store(f"sqlite:///{tmp_path / 'h.db'}")
        self.store.init_schema()
        self.backends = Backends()
        self.approvals = ApprovalService(self.store, self.settings)
        self.broker = Broker(self.store, self.settings, default_tools(), ToolContext(self.backends, MockLlm()),
                             self.approvals)
        self.manager = SessionManager(self.store, self.settings, self.broker, self.approvals)

    def add_policy(self, doc: str, by="admin") -> str:
        p = parse_policy(doc)
        self.store.create_policy_version(p.id, doc, p.content_hash, by)
        return p.id

    def add_example_policy(self, name: str) -> str:
        return self.add_policy((EXAMPLES / "policies" / f"{name}.yaml").read_text())

    def add_agent(self, agent_id: str, manifest: dict, policy_id: str | None = None, owner="dev") -> None:
        manifest = SHAPES[manifest["shape"]].validate(manifest, self.settings)
        self.store.create_agent_version(agent_id, owner, manifest["shape"], manifest)
        if policy_id:
            self.store.attach_policy(agent_id, policy_id, None, "admin")

    def package_agent(self, agent_id: str, source: str, policy_id: str | None = None, **resources) -> None:
        m = {"shape": "package", "package": {"entrypoint": "main:run", "files": {"main.py": source}}}
        if resources:
            m["resources"] = resources
        self.add_agent(agent_id, m, policy_id)

    async def run(self, agent_id: str, task=None, by="alice", timeout=60, session_refs=None) -> dict:
        s = await self.manager.submit(agent_id, task or {}, by, session_refs or [])
        return await self.wait(s["id"], timeout)

    async def wait(self, sid: str, timeout=60) -> dict:
        async def poll():
            while True:
                row = self.store.get_session(sid)
                if row["status"] not in ("queued", "running"):
                    return row
                await asyncio.sleep(0.1)
        return await asyncio.wait_for(poll(), timeout)


@pytest.fixture
def harness(tmp_path):
    return Harness(tmp_path)


@pytest.fixture
def make_harness(tmp_path):
    return lambda **kw: Harness(tmp_path, **kw)

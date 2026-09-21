import httpx
import pytest

from byoa_harness.api.app import create_app
from byoa_harness.config import Settings

from .helpers import KEYS


@pytest.fixture
async def api(tmp_path):
    """The real ASGI app (real routing, auth, validation, persistence) over an in-process client."""
    settings = Settings(env="test", database_url=f"sqlite:///{tmp_path / 'api.db'}", api_keys=dict(KEYS),
                        session_timeout_s=30, approval_timeout_s=20)
    app = create_app(settings)
    await app.state.manager.startup()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        client.app = app
        yield client
    await app.state.manager.shutdown()

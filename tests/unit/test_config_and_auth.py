"""Secure-by-default configuration and API-key comparison."""
import httpx
import pytest

from byoa_harness.api.app import _authenticate, create_app
from byoa_harness.config import Principal, Settings

KEYS = {"key-one-aaaaaaaa": Principal("one", frozenset({"admin"})), "key-two-bbbbbbbb": Principal("two", frozenset({"developer"}))}


def test_default_environment_is_not_dev(monkeypatch):
    monkeypatch.delenv("HARNESS_ENV", raising=False)
    monkeypatch.delenv("HARNESS_API_KEYS", raising=False)
    assert Settings.from_env().env == "production"
    assert Settings().env == "production"


def test_refuses_to_start_unauthenticated_unless_dev_is_explicit(monkeypatch):
    monkeypatch.delenv("HARNESS_API_KEYS", raising=False)
    with pytest.raises(RuntimeError, match="HARNESS_API_KEYS"):
        Settings.from_env().validate()
    with pytest.raises(RuntimeError):
        create_app(Settings(database_url="sqlite://"))
    monkeypatch.setenv("HARNESS_ENV", "dev")
    Settings.from_env().validate()  # explicitly asked for: allowed


def test_api_keys_are_parsed_from_the_environment(monkeypatch):
    monkeypatch.setenv("HARNESS_API_KEYS", '{"t1": {"name": "alice", "roles": ["developer", "approver"]}}')
    p = Settings.from_env().api_keys["t1"]
    assert p.name == "alice" and p.roles == {"developer", "approver"}


def test_groq_requires_a_key():
    with pytest.raises(RuntimeError, match="GROQ_API_KEY"):
        Settings(env="dev", llm_provider="groq").validate()


@pytest.mark.parametrize("token,expected", [
    ("key-one-aaaaaaaa", "one"), ("key-two-bbbbbbbb", "two"),
    ("", None), ("key-one-aaaaaaa", None), ("key-one-aaaaaaaaa", None), ("KEY-ONE-AAAAAAAA", None), ("nope", None),
    ("key-one-aaaaaaaa ", None), ("é" * 8, None),
])
def test_authenticate_matches_only_the_exact_key(token, expected):
    got = _authenticate(KEYS, token)
    assert (got.name if got else None) == expected


def test_authenticate_with_no_keys_matches_nothing():
    assert _authenticate({}, "anything") is None


def test_an_empty_token_never_authenticates_even_if_an_empty_key_was_misconfigured():
    assert _authenticate({"": Principal("oops", frozenset({"admin"}))}, "") is None


@pytest.mark.parametrize("bad", ["", "short", "1234567"])
def test_empty_or_short_keys_are_rejected_at_startup(bad):
    # e.g. docker compose substituting "" for an unset ${ADMIN_KEY}
    with pytest.raises(RuntimeError, match="at least 8 characters"):
        Settings(env="production", api_keys={bad: Principal("x", frozenset({"admin"}))}).validate()


async def test_unauthenticated_mode_is_only_reachable_in_dev(tmp_path):
    """Dev: no key needed and the caller is the local admin. Any other env with no keys refuses every request."""
    dev = create_app(Settings(env="dev", database_url=f"sqlite:///{tmp_path / 'd.db'}"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=dev), base_url="http://t") as c:
        assert (await c.get("/v1/whoami")).json()["name"] == "dev-admin"

    prod = create_app(Settings(env="production", database_url=f"sqlite:///{tmp_path / 'p.db'}", api_keys=KEYS))
    prod.state.settings.api_keys.clear()  # simulate a process that somehow lost its keys after startup
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=prod), base_url="http://t") as c:
        r = await c.get("/v1/whoami")
        assert r.status_code == 401 and "not configured" in r.json()["error"]["message"]


async def test_startup_warns_loudly_when_the_llm_is_the_offline_mock(tmp_path, capsys):
    # setup_logging() owns the root handlers and writes JSON to stdout, so stdout is where the app's logs are observable.
    app = create_app(Settings(env="dev", database_url=f"sqlite:///{tmp_path / 'm.db'}", llm_provider="mock"))
    async with app.router.lifespan_context(app):
        pass
    assert "LLM_PROVIDER=mock" in capsys.readouterr().out

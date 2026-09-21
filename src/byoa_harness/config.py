"""All configuration comes from environment variables (12-factor)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

MIN_API_KEY_LENGTH = 8


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


@dataclass(frozen=True)
class Principal:
    name: str
    roles: frozenset[str]


@dataclass(frozen=True)
class Settings:
    # Anything other than "dev" requires HARNESS_API_KEYS. "dev" (unauthenticated admin) must be asked for explicitly.
    env: str = "production"
    database_url: str = "sqlite:///./harness.db"
    log_level: str = "INFO"
    api_keys: dict[str, Principal] = field(default_factory=dict)

    # sandbox
    sandbox_image: str = "byoa-runtime:latest"
    max_concurrent_sessions: int = 8
    max_queued_sessions: int = 100
    sandbox_memory_mb: int = 256
    sandbox_cpus: float = 0.5
    sandbox_pids: int = 64
    sandbox_tmpfs_mb: int = 32
    session_timeout_s: int = 120
    max_message_bytes: int = 1_048_576
    max_actions_per_session: int = 500
    max_progress_events: int = 200
    max_package_bytes: int = 512_000

    # approvals
    approval_timeout_s: int = 900
    separation_of_duties: bool = True

    # llm / egress
    llm_provider: str = "mock"  # mock | groq
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-20b"
    egress_allow_private: bool = False
    extra_ca_bundle: str = ""  # PEM file with additional trusted roots (e.g. a TLS-inspecting corporate proxy)

    @staticmethod
    def from_env() -> Settings:
        keys: dict[str, Principal] = {}
        raw = os.environ.get("HARNESS_API_KEYS", "")
        if raw:
            for token, meta in json.loads(raw).items():
                keys[token] = Principal(meta["name"], frozenset(meta["roles"]))
        return Settings(
            env=os.environ.get("HARNESS_ENV", "production"),
            database_url=os.environ.get("DATABASE_URL", "sqlite:///./harness.db"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            api_keys=keys,
            sandbox_image=os.environ.get("SANDBOX_IMAGE", "byoa-runtime:latest"),
            max_concurrent_sessions=_int("MAX_CONCURRENT_SESSIONS", 8),
            max_queued_sessions=_int("MAX_QUEUED_SESSIONS", 100),
            sandbox_memory_mb=_int("SANDBOX_MEMORY_MB", 256),
            sandbox_cpus=_float("SANDBOX_CPUS", 0.5),
            sandbox_pids=_int("SANDBOX_PIDS", 64),
            sandbox_tmpfs_mb=_int("SANDBOX_TMPFS_MB", 32),
            session_timeout_s=_int("SESSION_TIMEOUT_S", 120),
            max_message_bytes=_int("MAX_MESSAGE_BYTES", 1_048_576),
            max_actions_per_session=_int("MAX_ACTIONS_PER_SESSION", 500),
            approval_timeout_s=_int("APPROVAL_TIMEOUT_S", 900),
            separation_of_duties=os.environ.get("SEPARATION_OF_DUTIES", "1") == "1",
            llm_provider=os.environ.get("LLM_PROVIDER", "mock"),
            groq_api_key=os.environ.get("GROQ_API_KEY", ""),
            groq_model=os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b"),
            egress_allow_private=os.environ.get("EGRESS_ALLOW_PRIVATE", "0") == "1",
            extra_ca_bundle=os.environ.get("EXTRA_CA_BUNDLE", ""),
        )

    def validate(self) -> None:
        if self.env != "dev" and not self.api_keys:
            raise RuntimeError("HARNESS_API_KEYS must be set outside dev (refusing to start unauthenticated)")
        # An unset variable in a templated environment (e.g. docker compose) becomes "", which must never be a valid key.
        if any(len(key) < MIN_API_KEY_LENGTH for key in self.api_keys):
            raise RuntimeError(f"every API key must be at least {MIN_API_KEY_LENGTH} characters (is a key variable unset?)")
        if self.llm_provider == "groq" and not self.groq_api_key:
            raise RuntimeError("LLM_PROVIDER=groq requires GROQ_API_KEY")

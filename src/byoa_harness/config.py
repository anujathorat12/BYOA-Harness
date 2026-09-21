"""All configuration comes from environment variables (12-factor)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


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
    env: str = "dev"
    database_url: str = "sqlite:///./harness.db"
    log_level: str = "INFO"
    api_keys: dict[str, Principal] = field(default_factory=dict)

    # sandbox
    sandbox_image: str = "byoa-runtime:latest"
    sandbox_enabled: bool = True
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
    groq_model: str = "llama-3.3-70b-versatile"
    egress_allow_private: bool = False

    @staticmethod
    def from_env() -> Settings:
        keys: dict[str, Principal] = {}
        raw = os.environ.get("HARNESS_API_KEYS", "")
        if raw:
            for token, meta in json.loads(raw).items():
                keys[token] = Principal(meta["name"], frozenset(meta["roles"]))
        return Settings(
            env=os.environ.get("HARNESS_ENV", "dev"),
            database_url=os.environ.get("DATABASE_URL", "sqlite:///./harness.db"),
            log_level=os.environ.get("LOG_LEVEL", "INFO"),
            api_keys=keys,
            sandbox_image=os.environ.get("SANDBOX_IMAGE", "byoa-runtime:latest"),
            sandbox_enabled=os.environ.get("SANDBOX_ENABLED", "1") == "1",
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
            groq_model=os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
            egress_allow_private=os.environ.get("EGRESS_ALLOW_PRIVATE", "0") == "1",
        )

    def validate(self) -> None:
        if self.env != "dev" and not self.api_keys:
            raise RuntimeError("HARNESS_API_KEYS must be set outside dev (refusing to start unauthenticated)")
        if self.llm_provider == "groq" and not self.groq_api_key:
            raise RuntimeError("LLM_PROVIDER=groq requires GROQ_API_KEY")

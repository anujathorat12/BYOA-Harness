"""Shared constants for API-level tests: one identity per role, keyed by a test-only token."""
from byoa_harness.config import Principal

KEYS = {
    "test-key-admin": Principal("root", frozenset({"admin"})),
    "test-key-dev": Principal("alice", frozenset({"developer"})),
    "test-key-dev2": Principal("mallory", frozenset({"developer"})),
    "test-key-appr": Principal("bob", frozenset({"approver"})),
    "test-key-aud": Principal("audrey", frozenset({"auditor"})),
}

TOKEN = {"admin": "test-key-admin", "dev": "test-key-dev", "dev2": "test-key-dev2", "appr": "test-key-appr",
         "aud": "test-key-aud"}


def hdr(role: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN[role]}"}

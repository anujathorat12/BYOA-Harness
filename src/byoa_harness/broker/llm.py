"""LLM provider proxy. API keys live here, in the harness - never inside a sandbox."""
from __future__ import annotations

import ssl
from dataclasses import dataclass
from typing import Protocol

import httpx


@dataclass
class LlmResult:
    text: str
    tokens: int


class LlmProvider(Protocol):
    name: str

    async def complete(self, prompt: str, max_tokens: int) -> LlmResult: ...


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class MockLlm:
    """Deterministic offline provider used by tests and by default."""

    name = "mock"

    async def complete(self, prompt: str, max_tokens: int) -> LlmResult:
        text = f"[mock-llm] {prompt[:160]}"
        return LlmResult(text, estimate_tokens(prompt) + estimate_tokens(text))


def build_ssl_context(extra_ca_bundle: str = "") -> ssl.SSLContext:
    """Default trust store plus an optional extra CA file. Verification is never disabled."""
    ctx = ssl.create_default_context()
    if extra_ca_bundle:
        ctx.load_verify_locations(cafile=extra_ca_bundle)
    return ctx


class GroqLlm:
    name = "groq"

    def __init__(self, api_key: str, model: str, extra_ca_bundle: str = "") -> None:
        self._key, self._model = api_key, model
        self._ssl = build_ssl_context(extra_ca_bundle)

    def _payload(self, prompt: str, max_tokens: int) -> dict:
        body: dict = {"model": self._model, "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": prompt}]}
        if "gpt-oss" in self._model:  # reasoning models otherwise spend the whole budget "thinking"
            body["reasoning_effort"] = "low"
        return body

    async def complete(self, prompt: str, max_tokens: int) -> LlmResult:
        async with httpx.AsyncClient(timeout=30, verify=self._ssl) as client:
            r = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._key}"},
                json=self._payload(prompt, max_tokens),
            )
            r.raise_for_status()
            data = r.json()
        return LlmResult(data["choices"][0]["message"].get("content") or "",
                         int(data.get("usage", {}).get("total_tokens", 0)) or estimate_tokens(prompt))


def make_provider(kind: str, api_key: str, model: str, extra_ca_bundle: str = "") -> LlmProvider:
    if kind == "groq":
        return GroqLlm(api_key, model, extra_ca_bundle)
    return MockLlm()

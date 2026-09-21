"""LLM provider proxy. API keys live here, in the harness - never inside a sandbox."""
from __future__ import annotations

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


class GroqLlm:
    name = "groq"

    def __init__(self, api_key: str, model: str) -> None:
        self._key, self._model = api_key, model

    async def complete(self, prompt: str, max_tokens: int) -> LlmResult:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._key}"},
                json={"model": self._model, "max_tokens": max_tokens,
                      "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            data = r.json()
        return LlmResult(data["choices"][0]["message"]["content"],
                         int(data.get("usage", {}).get("total_tokens", 0)) or estimate_tokens(prompt))


def make_provider(kind: str, api_key: str, model: str) -> LlmProvider:
    if kind == "groq":
        return GroqLlm(api_key, model)
    return MockLlm()

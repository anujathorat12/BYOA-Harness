"""Agent shapes = the BYOA extension point.

A shape adapter answers two questions: "is this manifest valid?" and "what init message and
image does a session of this agent get?". The harness core (sandbox, broker, policy, audit) never
looks inside a manifest, so adding a shape (e.g. a bring-your-own-image container speaking the same
protocol) means adding one adapter and registering it in SHAPES.
"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..config import Settings
from .sandbox import Limits


class ManifestError(ValueError):
    pass


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ResourceRequest(_Strict):
    """Agents may ask for LESS than the platform default; they can never raise the ceiling."""

    memory_mb: int | None = Field(default=None, ge=16, le=4096)
    cpus: float | None = Field(default=None, gt=0, le=4)
    timeout_s: int | None = Field(default=None, ge=1, le=3600)


class ShapeAdapter(ABC):
    name: str

    @abstractmethod
    def validate(self, manifest: dict[str, Any], settings: Settings) -> dict[str, Any]:
        """Return the normalised manifest to store, or raise ManifestError."""

    @abstractmethod
    def init_payload(self, manifest: dict[str, Any]) -> dict[str, Any]:
        """Shape-specific keys merged into the init message."""

    def image(self, settings: Settings) -> str:
        return settings.sandbox_image

    def limits(self, manifest: dict[str, Any], settings: Settings) -> Limits:
        req = ResourceRequest.model_validate(manifest.get("resources") or {})
        return Limits(
            memory_mb=min(req.memory_mb or settings.sandbox_memory_mb, settings.sandbox_memory_mb),
            cpus=min(req.cpus or settings.sandbox_cpus, settings.sandbox_cpus),
            pids=settings.sandbox_pids, tmpfs_mb=settings.sandbox_tmpfs_mb,
            timeout_s=min(req.timeout_s or settings.session_timeout_s, settings.session_timeout_s))


_FILE = re.compile(r"^[a-zA-Z0-9_][a-zA-Z0-9_./-]{0,127}$")


class _Package(_Strict):
    entrypoint: str = Field(pattern=r"^[a-zA-Z_][a-zA-Z0-9_.]*(:[a-zA-Z_][a-zA-Z0-9_]*)?$")
    files: dict[str, str] = Field(min_length=1, max_length=32)

    @field_validator("files")
    @classmethod
    def _names(cls, files: dict[str, str]) -> dict[str, str]:
        for n in files:
            if not _FILE.match(n) or ".." in n.split("/") or n.endswith("/"):
                raise ValueError(f"illegal file name {n!r}")
        return files


class _Manifest(_Strict):
    shape: Literal["package", "declarative"]
    description: str = Field(default="", max_length=500)
    resources: ResourceRequest = ResourceRequest()


class PackageShape(ShapeAdapter):
    """Code agent: a bundle of Python source files plus an entrypoint `module:function(ctx)`."""

    name = "package"

    class M(_Manifest):
        shape: Literal["package"]
        package: _Package

    def validate(self, manifest: dict[str, Any], settings: Settings) -> dict[str, Any]:
        try:
            m = self.M.model_validate(manifest)
        except ValidationError as e:
            raise ManifestError("; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors())) from e
        if sum(len(s.encode()) for s in m.package.files.values()) > settings.max_package_bytes:
            raise ManifestError(f"package exceeds {settings.max_package_bytes} bytes")
        mod = m.package.entrypoint.partition(":")[0].replace(".", "/")
        if f"{mod}.py" not in m.package.files and f"{mod}/__init__.py" not in m.package.files:
            raise ManifestError("entrypoint module is not present in package files")
        return m.model_dump()

    def init_payload(self, manifest: dict[str, Any]) -> dict[str, Any]:
        return {"package": manifest["package"]}


class _Step(_Strict):
    id: str | None = Field(default=None, pattern=r"^[a-zA-Z][a-zA-Z0-9_-]{0,31}$")
    call: str | None = Field(default=None, max_length=64)
    llm: str | None = Field(default=None, max_length=32_000)
    args: dict[str, Any] = {}
    max_tokens: int | None = Field(default=None, ge=1, le=2048)
    on_denied: Literal["fail", "continue"] = "fail"
    ret: Any = Field(default=None, alias="return")
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class DeclarativeShape(ShapeAdapter):
    """Config-driven agent: an ordered list of harness calls/LLM steps. No code runs in it."""

    name = "declarative"

    class M(_Manifest):
        shape: Literal["declarative"]
        spec: dict[str, Any]

    def validate(self, manifest: dict[str, Any], settings: Settings) -> dict[str, Any]:
        try:
            m = self.M.model_validate(manifest)
            steps_raw = m.spec.get("steps")
            if set(m.spec) - {"steps"} or not isinstance(steps_raw, list) or not 1 <= len(steps_raw) <= 100:
                raise ManifestError("spec must contain only 'steps': a list of 1..100 steps")
            ids: set[str] = set()
            for raw in steps_raw:
                s = _Step.model_validate(raw)
                kinds = sum(x is not None for x in (s.call, s.llm)) + ("return" in raw)
                if kinds != 1:
                    raise ManifestError("each step needs exactly one of: call, llm, return")
                if s.id:
                    if s.id in ids:
                        raise ManifestError(f"duplicate step id {s.id!r}")
                    ids.add(s.id)
        except ValidationError as e:
            raise ManifestError("; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors())) from e
        if len(str(m.spec)) > settings.max_package_bytes:
            raise ManifestError("spec too large")
        return m.model_dump()

    def init_payload(self, manifest: dict[str, Any]) -> dict[str, Any]:
        return {"spec": manifest["spec"]}


SHAPES: dict[str, ShapeAdapter] = {s.name: s for s in (PackageShape(), DeclarativeShape())}

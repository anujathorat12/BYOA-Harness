"""Canonicalization: the one place where agent-supplied strings become comparable.

Both the policy engine and the tool executor consume the *canonical* form, so
what is evaluated is exactly what is executed.
"""
from __future__ import annotations

import hashlib
import json
import math
import posixpath
import unicodedata
from typing import Any


class CanonicalizationError(ValueError):
    """Input cannot be safely canonicalized. Callers must treat this as DENY."""


def canonical_resource(value: str) -> str:
    if not isinstance(value, str):
        raise CanonicalizationError("resource must be a string")
    v = unicodedata.normalize("NFKC", value).strip().lower().replace("\\", "/")
    if not v:
        raise CanonicalizationError("resource is empty")
    if any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise CanonicalizationError("resource contains control characters")
    if "/" in v:
        norm = posixpath.normpath(v)
        if norm == ".." or norm.startswith("../") or "/../" in norm:
            raise CanonicalizationError("path escapes its root")
        v = norm
        if v.startswith("//"):  # normpath keeps exactly two leading slashes
            v = "/" + v.lstrip("/")
    v = v.rstrip(".")  # trailing dot on hostnames / dotted names
    if not v or v == "/":
        if v == "/":
            return v
        raise CanonicalizationError("resource is empty after normalisation")
    return v


def _check_json(value: Any, depth: int = 0) -> None:
    if depth > 16:
        raise CanonicalizationError("params nested too deeply")
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        raise CanonicalizationError("NaN/Infinity not allowed")
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise CanonicalizationError("param keys must be strings")
            _check_json(v, depth + 1)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _check_json(v, depth + 1)
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise CanonicalizationError(f"unsupported param type {type(value).__name__}")


def canonical_json(value: Any) -> str:
    _check_json(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

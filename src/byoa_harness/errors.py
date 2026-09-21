"""Domain errors that carry the HTTP status they should be reported with.

Raised by domain code (session submission, approvals) and translated exactly once, in the API layer.
"""
from __future__ import annotations


class DomainError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message

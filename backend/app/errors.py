from __future__ import annotations


class ApiError(Exception):
    """Expected API failure with a stable machine-readable code."""

    def __init__(self, *, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message

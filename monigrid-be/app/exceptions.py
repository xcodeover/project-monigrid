"""Domain-specific exceptions for the monitoring backend."""
from __future__ import annotations


class SqlFileNotFoundError(Exception):
    """Raised when a .sql file referenced by sql_id cannot be found."""

    def __init__(self, sql_id: str, sql_path: str) -> None:
        # Keep the message English so log aggregators / non-Korean operators
        # can read it without character-set surprises. The FE shows its own
        # localised message based on the response code.
        super().__init__(f"SQL file not found: {sql_id}.sql")
        self.sql_id = sql_id
        self.sql_path = sql_path


class QueryExecutionTimeoutError(Exception):
    """Raised when a query exceeds the configured timeout."""

    def __init__(self, api_id: str, timeout_sec: float) -> None:
        super().__init__(f"Database Query timeout (apiId={api_id}, timeoutSec={timeout_sec})")
        self.api_id = api_id
        self.timeout_sec = timeout_sec


class CachedEndpointError(Exception):
    """Raised when a cached endpoint has no valid in-memory payload."""

    def __init__(
        self,
        api_id: str,
        message: str,
        detail: str | None = None,
        *,
        is_timeout: bool = False,
    ) -> None:
        super().__init__(message)
        self.api_id = api_id
        self.message = message
        self.detail = detail
        self.is_timeout = is_timeout

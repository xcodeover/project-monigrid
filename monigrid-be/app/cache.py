"""In-memory TTL cache and endpoint cache entry model."""
from __future__ import annotations

from dataclasses import dataclass
from time import time
from typing import Any


class QueryCache:
    """Simple TTL-based in-memory cache."""

    def __init__(self, ttl_sec: int = 300) -> None:
        self.cache: dict[str, tuple[Any, float]] = {}
        self.ttl_sec = ttl_sec

    def get(self, key: str) -> Any | None:
        if key not in self.cache:
            return None
        value, timestamp = self.cache[key]
        if time() - timestamp > self.ttl_sec:
            del self.cache[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self.cache[key] = (value, time())

    def clear(self) -> None:
        self.cache.clear()


@dataclass
class EndpointCacheEntry:
    api_id: str
    path: str
    connection_id: str
    data: Any | None
    updated_at: str | None
    last_refresh_started_at: str | None
    last_duration_sec: float | None
    error_message: str | None
    error_detail: str | None
    is_timeout: bool
    source: str

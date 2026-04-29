"""In-memory TTL cache and endpoint cache entry model."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from time import time
from typing import Any


class QueryCache:
    """Thread-safe TTL-based in-memory cache.

    The previous implementation read-then-deleted without a lock, so two
    Flask worker threads racing on the same expired key could trigger a
    KeyError on the second `del`. The lock is uncontended for normal
    workloads (one round-trip per call) so the cost is negligible.
    """

    def __init__(self, ttl_sec: int = 300) -> None:
        self.cache: dict[str, tuple[Any, float]] = {}
        self.ttl_sec = ttl_sec
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self.cache.get(key)
            if entry is None:
                return None
            value, timestamp = entry
            if time() - timestamp > self.ttl_sec:
                # pop() is idempotent; another thread may have already
                # deleted the entry between the read and the write.
                self.cache.pop(key, None)
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self.cache[key] = (value, time())

    def clear(self) -> None:
        with self._lock:
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

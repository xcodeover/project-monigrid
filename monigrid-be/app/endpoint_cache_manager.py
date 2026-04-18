"""Endpoint cache manager.

Extracted from `MonitoringBackend` (SRP). Owns the endpoint-result
cache, the per-endpoint background refresh scheduler threads, and the
on-demand cache lookup path used by request handlers.

Dependencies on the rest of the system are inverted (DIP):
    - `query_runner(endpoint, client_ip) -> data`        — JDBC layer
    - `connection_resetter(connection_id) -> None`       — pool layer
    - `executor_provider() -> ThreadPoolExecutor`        — async layer
    - `config_provider() -> AppConfig`                   — config layer

This service has no awareness of MonitoringBackend, route handlers, or
the JDBC implementation — it just orchestrates "(re)load → store →
serve" for endpoint result data.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Callable

from .cache import EndpointCacheEntry
from .config import ApiEndpointConfig, AppConfig
from .exceptions import CachedEndpointError, QueryExecutionTimeoutError


QueryRunner = Callable[[ApiEndpointConfig, str], Any]
ConnectionResetter = Callable[[str], None]


class EndpointCacheManager:
    """Caches endpoint query results and refreshes them on a schedule."""

    def __init__(
        self,
        *,
        config_provider: Callable[[], AppConfig],
        executor_provider: Callable[[], ThreadPoolExecutor],
        query_runner: QueryRunner,
        connection_resetter: ConnectionResetter,
        logger: logging.Logger,
    ) -> None:
        self._config_provider = config_provider
        self._executor_provider = executor_provider
        self._query_runner = query_runner
        self._connection_resetter = connection_resetter
        self._logger = logger

        self._cache: dict[str, EndpointCacheEntry] = {}
        self._cache_lock = threading.RLock()
        self._stop_event = threading.Event()
        self._threads: list[threading.Thread] = []

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def start(self) -> None:
        """Run an initial warm-up + start one refresh thread per enabled endpoint.

        Safe to call repeatedly; pairs with `stop()`.
        """
        self._stop_event.clear()
        self._threads = []

        config = self._config_provider()
        enabled_endpoints = [ep for ep in config.apis.values() if ep.enabled]

        if enabled_endpoints:
            self._logger.info(
                "Starting initial cache warm-up for %d endpoints...",
                len(enabled_endpoints),
            )
            executor = self._executor_provider()
            futures = {
                executor.submit(
                    self.refresh_endpoint_cache,
                    ep,
                    source="startup",
                    client_ip="scheduler",
                ): ep.api_id
                for ep in enabled_endpoints
            }
            for future in futures:
                try:
                    future.result(timeout=60)
                except Exception as exc:
                    api_id = futures[future]
                    self._logger.error(
                        "Initial cache warm-up failed apiId=%s: %s", api_id, exc,
                    )
            self._logger.info("Initial cache warm-up completed.")

        for endpoint in enabled_endpoints:
            thread = threading.Thread(
                target=self._refresh_loop,
                args=(endpoint.api_id,),
                name=f"cache-refresh-{endpoint.api_id}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        """Signal scheduler threads to exit and join them (best-effort)."""
        self._stop_event.set()
        for thread in self._threads:
            thread.join(timeout=1.5)
        self._threads = []

    def clear(self) -> None:
        """Drop all cached entries (called from MonitoringBackend.reload)."""
        with self._cache_lock:
            self._cache.clear()

    # ── Background refresh loop ───────────────────────────────────────────

    def _refresh_loop(self, api_id: str) -> None:
        """Periodic refresh — initial warm-up is done in start()."""
        endpoint = self._config_provider().apis.get(api_id)
        if endpoint is None or not endpoint.enabled:
            return
        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug(
                "Scheduler thread started apiId=%s intervalSec=%s",
                api_id, endpoint.refresh_interval_sec,
            )
        while not self._stop_event.wait(endpoint.refresh_interval_sec):
            if self._logger.isEnabledFor(logging.DEBUG):
                self._logger.debug("Scheduler tick apiId=%s", api_id)
            self.refresh_endpoint_cache(endpoint, source="scheduler", client_ip="scheduler")
        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug("Scheduler thread exited apiId=%s", api_id)

    # ── Cache writes ──────────────────────────────────────────────────────

    def _store_success(
        self,
        endpoint: ApiEndpointConfig,
        data: Any,
        *,
        source: str,
        started_at: str,
        duration_sec: float,
    ) -> EndpointCacheEntry:
        entry = EndpointCacheEntry(
            api_id=endpoint.api_id,
            path=endpoint.rest_api_path,
            connection_id=endpoint.connection_id,
            data=data,
            updated_at=datetime.now(timezone.utc).isoformat(),
            last_refresh_started_at=started_at,
            last_duration_sec=duration_sec,
            error_message=None,
            error_detail=None,
            is_timeout=False,
            source=source,
        )
        with self._cache_lock:
            self._cache[endpoint.api_id] = entry
        return entry

    def _store_error(
        self,
        endpoint: ApiEndpointConfig,
        *,
        source: str,
        started_at: str,
        duration_sec: float,
        message: str,
        detail: str | None,
        is_timeout: bool,
    ) -> EndpointCacheEntry:
        entry = EndpointCacheEntry(
            api_id=endpoint.api_id,
            path=endpoint.rest_api_path,
            connection_id=endpoint.connection_id,
            data=None,
            updated_at=None,
            last_refresh_started_at=started_at,
            last_duration_sec=duration_sec,
            error_message=message,
            error_detail=detail,
            is_timeout=is_timeout,
            source=source,
        )
        with self._cache_lock:
            self._cache[endpoint.api_id] = entry
        return entry

    # ── Public API ────────────────────────────────────────────────────────

    def get_cached_endpoint_entry(self, api_id: str) -> EndpointCacheEntry | None:
        with self._cache_lock:
            return self._cache.get(api_id)

    def snapshot_entries(self) -> dict[str, EndpointCacheEntry]:
        """Return a shallow copy of the cache so callers can iterate without
        holding the internal lock."""
        with self._cache_lock:
            return dict(self._cache)

    def refresh_endpoint_cache(
        self,
        endpoint: ApiEndpointConfig,
        *,
        source: str,
        client_ip: str,
        reset_connection: bool = False,
    ) -> EndpointCacheEntry:
        started_at = datetime.now(timezone.utc).isoformat()
        started_timer = perf_counter()

        if reset_connection:
            self._connection_resetter(endpoint.connection_id)

        try:
            data = self._query_runner(endpoint, client_ip)
            duration_sec = perf_counter() - started_timer
            entry = self._store_success(
                endpoint, data, source=source, started_at=started_at, duration_sec=duration_sec,
            )
            if isinstance(data, list):
                result_summary = f"rows={len(data)}"
            elif isinstance(data, dict) and "updated" in data:
                result_summary = f"updated={data['updated']}"
            else:
                result_summary = "ok"
            slow_threshold = self._config_provider().logging.slow_query_threshold_sec
            is_slow = duration_sec >= slow_threshold
            log_fn = self._logger.warning if is_slow else self._logger.info
            # Scheduler-initiated refreshes identify a query by its sqlId (the
            # persisted SQL script), omit the source/clientIp fields (always
            # "scheduler"), and use concise, professional phrasing. Manual or
            # SQL-update-triggered refreshes keep the richer contextual fields
            # so operators can trace who triggered what.
            if source == "scheduler":
                log_fn(
                    "Scheduled cache refresh succeeded sqlId=%s path=%s %s durationSec=%.3f",
                    endpoint.sql_id, endpoint.rest_api_path, result_summary, duration_sec,
                )
            else:
                log_fn(
                    "Cache refreshed apiId=%s path=%s source=%s %s durationSec=%.3f clientIp=%s",
                    endpoint.api_id, endpoint.rest_api_path, source, result_summary, duration_sec, client_ip,
                )
            return entry
        except QueryExecutionTimeoutError as error:
            duration_sec = perf_counter() - started_timer
            entry = self._store_error(
                endpoint, source=source, started_at=started_at, duration_sec=duration_sec,
                message="Database Query timeout", detail=str(error), is_timeout=True,
            )
            self._logger.warning(
                "Endpoint cache refresh timeout apiId=%s path=%s source=%s durationSec=%.3f timeoutSec=%.3f",
                endpoint.api_id, endpoint.rest_api_path, source, duration_sec, endpoint.query_timeout_sec,
            )
            return entry
        except Exception as error:
            duration_sec = perf_counter() - started_timer
            entry = self._store_error(
                endpoint, source=source, started_at=started_at, duration_sec=duration_sec,
                message="Internal Server Error", detail=str(error), is_timeout=False,
            )
            self._logger.error(
                "Endpoint cache refresh failed apiId=%s path=%s source=%s durationSec=%.3f detail=%s",
                endpoint.api_id, endpoint.rest_api_path, source, duration_sec, error,
            )
            return entry

    def refresh_all_endpoint_caches(
        self, *, source: str, client_ip: str, reset_connection: bool = False,
    ) -> list[EndpointCacheEntry]:
        return [
            self.refresh_endpoint_cache(
                endpoint, source=source, client_ip=client_ip, reset_connection=reset_connection,
            )
            for endpoint in self._config_provider().apis.values()
            if endpoint.enabled
        ]

    def get_cached_endpoint_response(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        entry = self.get_cached_endpoint_entry(endpoint.api_id)
        if entry and entry.data is not None:
            if self._logger.isEnabledFor(logging.DEBUG):
                row_count = len(entry.data) if isinstance(entry.data, list) else 1
                self._logger.debug(
                    "Cache HIT apiId=%s path=%s rowCount=%d updatedAt=%s source=%s clientIp=%s",
                    endpoint.api_id, endpoint.rest_api_path, row_count,
                    entry.updated_at, entry.source, client_ip,
                )
            return entry.data

        if entry and entry.error_message:
            if self._logger.isEnabledFor(logging.DEBUG):
                self._logger.debug(
                    "Cache HIT (error) apiId=%s message=%s isTimeout=%s clientIp=%s",
                    endpoint.api_id, entry.error_message, entry.is_timeout, client_ip,
                )
            raise CachedEndpointError(
                endpoint.api_id, entry.error_message, detail=entry.error_detail, is_timeout=entry.is_timeout,
            )

        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug(
                "Cache MISS apiId=%s path=%s — refreshing on-demand clientIp=%s",
                endpoint.api_id, endpoint.rest_api_path, client_ip,
            )
        refreshed_entry = self.refresh_endpoint_cache(endpoint, source="on-demand", client_ip=client_ip)
        if refreshed_entry.data is not None:
            return refreshed_entry.data

        raise CachedEndpointError(
            endpoint.api_id,
            refreshed_entry.error_message or "Internal Server Error",
            detail=refreshed_entry.error_detail,
            is_timeout=refreshed_entry.is_timeout,
        )

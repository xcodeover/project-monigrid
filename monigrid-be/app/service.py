"""MonitoringBackend: thin façade over the focused sub-services.

All non-trivial work is delegated to sibling modules — this class only
owns the executor + connection pool lifecycle and wires the sub-services
together via constructor injection. Route handlers continue to call the
same public methods on `MonitoringBackend`, so they don't need to know
which sub-service does the work:

    - `EndpointCacheManager` → app/endpoint_cache_manager.py
    - `JdbcQueryExecutor`    → app/jdbc_executor.py
    - `SqlEditorService`     → app/sql_editor_service.py
    - `DbHealthService`      → app/db_health_service.py
    - `LogReader`            → app/log_reader.py
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable
from urllib.parse import urlparse

from .cache import EndpointCacheEntry
from .config import ApiEndpointConfig, AppConfig
from .db import DBConnectionPool, ensure_jvm_started, jvm_classpath_missing
from .db_health_service import DbHealthService
from .endpoint_cache_manager import EndpointCacheManager
from .jdbc_executor import JdbcQueryExecutor
from .log_reader import LogReader
from .logging_setup import _startup_log, configure_logging
from .monitor_collector_manager import MonitorCollectorManager, MonitorSnapshot
from .settings_store import SettingsStore, SqlRepository
from .sql_editor_service import SqlEditorService
from .utils import get_env


# NOTE: _normalize_db_type and _DIAGNOSTIC_SQL were moved to db_health_service.py


class MonitoringBackend:
    """
    Core service class: executes JDBC queries, manages endpoint caches,
    and orchestrates background refresh threads.

    Follows SRP – business logic only; routing is handled in routes.py.
    """

    def __init__(
        self,
        *,
        settings_store: SettingsStore,
        config_reloader: Callable[[], AppConfig],
        logger: logging.Logger,
        initial_config: AppConfig,
    ) -> None:
        self.settings_store = settings_store
        self._config_reloader = config_reloader
        self.logger = logger
        self.config = initial_config
        # Phase 5B: serializes reload() / apply_partial_config_reload /
        # apply_monitor_targets_partial. Without this, two admins saving
        # at the same moment would race on db_pools / config swap.
        self._reload_lock = threading.Lock()
        # I-2: track jars that were already missing at boot. Reload only
        # warns for *newly* missing jars (e.g., admin added a connection
        # pointing at a jar not on the JVM classpath).
        self._known_missing_jars: set[str] = set()
        # Two pools so JDBC work isn't held hostage by IO-bound monitor
        # probes (SSH handshakes, HTTP health checks, ICMP/TCP probes) that
        # can each pin a worker for hundreds of ms. The monitor pool is
        # half-sized — its consumers are bursty (startup batch) but most
        # work runs in dedicated per-target refresh threads, so a smaller
        # pool just keeps the startup parallelism reasonable.
        self.jdbc_executor = ThreadPoolExecutor(
            max_workers=self.config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        self.monitor_executor = ThreadPoolExecutor(
            max_workers=max(2, self.config.thread_pool_size // 2),
            thread_name_prefix="monitor-worker",
        )
        self.db_pools: dict[str, DBConnectionPool] = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in self.config.connections
        }
        # ── Sub-services (façade pattern) ──────────────────────────────
        # Use lambdas so the sub-services always observe the *current*
        # executor / db_pools / config — both `jdbc_executor` /
        # `monitor_executor` and `db_pools` are reassigned during reload().
        self._sql_repository = SqlRepository(settings_store)
        self._db_health = DbHealthService(
            config_provider=lambda: self.config,
            executor_provider=lambda: self.jdbc_executor,
            pool_provider=lambda conn_id: self.db_pools[conn_id],
            logger=self.logger,
        )
        self._jdbc = JdbcQueryExecutor(
            sql_repository=self._sql_repository,
            config_provider=lambda: self.config,
            executor_provider=lambda: self.jdbc_executor,
            pool_provider=lambda conn_id: self.db_pools[conn_id],
            logger=self.logger,
        )
        self._cache_manager = EndpointCacheManager(
            config_provider=lambda: self.config,
            executor_provider=lambda: self.jdbc_executor,
            query_runner=self._jdbc.run_query,
            connection_resetter=self.reset_connections,
            logger=self.logger,
        )
        self._sql_editor = SqlEditorService(
            sql_repository=self._sql_repository,
            config_provider=lambda: self.config,
            on_sql_updated=lambda endpoint, client_ip: self._cache_manager.refresh_endpoint_cache(
                endpoint, source="sql-update", client_ip=client_ip, reset_connection=True,
            ),
            logger=self.logger,
        )
        self._log_reader = LogReader(self.config.logging, self.logger)
        self._monitor_collector = MonitorCollectorManager(
            target_loader=self.settings_store.list_monitor_targets,
            executor_provider=lambda: self.monitor_executor,
            logger=self.logger,
        )

        # Pre-start JVM once before any JDBC work begins, with all JDBC jars on classpath
        if self.config.connections:
            all_jars = list(dict.fromkeys(
                jar
                for conn in self.config.connections.values()
                for jar in conn.jdbc_jars
            ))
            try:
                ensure_jvm_started(classpath=all_jars)
            except Exception as exc:
                self.logger.error("JVM pre-start failed (will retry on first query): %s", exc)
        self._cache_manager.start()
        self._monitor_collector.start()
        enabled_apis = [ep for ep in self.config.apis.values() if ep.enabled]
        _startup_log(
            self.logger,
            "Backend initialized host=%s port=%s threadPoolSize=%s loadedApiCount=%s",
            self.config.host,
            self.config.port,
            self.config.thread_pool_size,
            len(enabled_apis),
        )
        for ep in enabled_apis:
            _startup_log(self.logger, "Hosted API id=%s path=%s", ep.api_id, ep.rest_api_path)

        # I-2: announce loaded JDBC drivers once at boot. Subsequent
        # reload() calls only WARN about *newly* missing jars.
        self._log_loaded_jdbc_drivers()

    # ── Cache management (delegated to EndpointCacheManager) ──────────────

    def _stop_background_refreshers(self) -> None:
        # Kept for monigrid_be.py shutdown hook (still calls this name).
        self._cache_manager.stop()
        self._monitor_collector.stop()

    # ── JVM classpath logging (I-2) ───────────────────────────────────────

    def _log_loaded_jdbc_drivers(self) -> None:
        all_jars = list(dict.fromkeys(
            jar
            for conn in self.config.connections.values()
            for jar in conn.jdbc_jars
        ))
        self.logger.info("Loaded JDBC drivers: %d jars", len(all_jars))
        initial_missing = set(jvm_classpath_missing(all_jars))
        if initial_missing:
            self.logger.info(
                "JDBC jars not on classpath at boot (will be ignored on reload): %s",
                sorted(initial_missing),
            )
            self._known_missing_jars |= initial_missing

    def _check_classpath_for_reload(self, new_config: AppConfig) -> None:
        new_jars = list(dict.fromkeys(
            jar
            for conn in new_config.connections.values()
            for jar in conn.jdbc_jars
        ))
        current_missing = set(jvm_classpath_missing(new_jars))
        newly_missing = current_missing - self._known_missing_jars
        if newly_missing:
            self.logger.warning(
                "JDBC jars not on classpath — queries against the new connections "
                "will fail until BE restart. newly_missing=%s",
                sorted(newly_missing),
            )
            self._known_missing_jars |= newly_missing

    # ── Monitor collector (server-resource / network targets) ─────────────

    def list_monitor_targets(self) -> list[dict[str, Any]]:
        return self.settings_store.list_monitor_targets()

    def get_monitor_target(self, target_id: str) -> dict[str, Any] | None:
        return self.settings_store.get_monitor_target(target_id)

    def upsert_monitor_target(self, item: dict[str, Any]) -> dict[str, Any]:
        stored = self.settings_store.upsert_monitor_target(item)
        # New / updated targets need the collector to re-schedule.
        self._monitor_collector.reload()
        return stored

    def delete_monitor_target(self, target_id: str) -> None:
        self.settings_store.delete_monitor_target(target_id)
        # Surgical cleanup before the full reload — keeps the in-memory
        # snapshot consistent even if reload() is later short-circuited.
        self._monitor_collector.forget_target(target_id)
        self._monitor_collector.reload()

    def apply_monitor_targets_batch(
        self,
        *,
        creates: list[dict],
        updates: list[dict],
        deletes: list[str],
    ) -> dict:
        """Apply monitor target changes in a single transaction. Triggers
        monitor_collector reload exactly once on success.
        """
        result = self.settings_store.apply_monitor_targets_batch(
            creates=creates, updates=updates, deletes=deletes,
        )
        if result.get("success"):
            # 1회 reload (개별 endpoint 마다 reload 하던 것과 대비 — 이슈 #2 참고)
            self._monitor_collector.reload()
        return result

    def get_monitor_snapshot(self, target_id: str) -> MonitorSnapshot | None:
        return self._monitor_collector.get_snapshot(target_id)

    def snapshot_monitor_entries(self) -> dict[str, MonitorSnapshot]:
        return self._monitor_collector.snapshot_entries()

    def refresh_monitor_target(self, target_id: str) -> MonitorSnapshot | None:
        return self._monitor_collector.refresh_target(target_id)

    # ── Per-user preferences (widget layouts, thresholds, column order) ───

    def get_user_preferences(self, username: str) -> dict[str, Any]:
        return self.settings_store.get_user_preferences(username) or {}

    def save_user_preferences(
        self, username: str, value: dict[str, Any],
    ) -> dict[str, Any]:
        return self.settings_store.save_user_preferences(username, value)

    # ── Users (admin-managed directory) ──────────────────────────────────

    def list_users(self) -> list[dict[str, Any]]:
        return self.settings_store.list_users()

    def get_user(self, username: str) -> dict[str, Any] | None:
        return self.settings_store.get_user(username)

    def create_user(self, **kwargs: Any) -> dict[str, Any]:
        return self.settings_store.create_user(**kwargs)

    def update_user(self, username: str, **kwargs: Any) -> dict[str, Any]:
        return self.settings_store.update_user(username, **kwargs)

    def delete_user(self, username: str) -> None:
        self.settings_store.delete_user(username)
        # Drop that user's saved UI prefs too so a recreated account starts clean.
        self.settings_store.delete_user_preferences(username)

    def has_admin_user(self) -> bool:
        return self.settings_store.count_admin_users() > 0

    def get_user_credentials(self, username: str) -> tuple[str, str, bool] | None:
        """Return (password_hash, role, enabled) for the username, or None."""
        return self.settings_store._get_user_hash(username)

    def get_cached_endpoint_entry(self, api_id: str) -> EndpointCacheEntry | None:
        return self._cache_manager.get_cached_endpoint_entry(api_id)

    def snapshot_cache_entries(self) -> dict[str, EndpointCacheEntry]:
        return self._cache_manager.snapshot_entries()

    def refresh_endpoint_cache(
        self,
        endpoint: ApiEndpointConfig,
        *,
        source: str,
        client_ip: str,
        reset_connection: bool = False,
    ) -> EndpointCacheEntry:
        return self._cache_manager.refresh_endpoint_cache(
            endpoint, source=source, client_ip=client_ip, reset_connection=reset_connection,
        )

    def refresh_all_endpoint_caches(
        self, *, source: str, client_ip: str, reset_connection: bool = False,
    ) -> list[EndpointCacheEntry]:
        return self._cache_manager.refresh_all_endpoint_caches(
            source=source, client_ip=client_ip, reset_connection=reset_connection,
        )

    def get_cached_endpoint_response(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        return self._cache_manager.get_cached_endpoint_response(endpoint, client_ip)

    # ── Query execution (delegated to JdbcQueryExecutor) ──────────────────

    def run_query(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        return self._jdbc.run_query(endpoint, client_ip)

    # ── SQL editor (delegated to SqlEditorService) ────────────────────────

    def list_endpoints(self) -> list[dict[str, Any]]:
        return [
            {
                "id": ep.api_id,
                "title": ep.title,
                "endpoint": ep.rest_api_path,
                "enabled": ep.enabled,
                "dbType": self.config.connections[ep.connection_id].db_type,
                "connectionId": ep.connection_id,
            }
            for ep in self.config.apis.values()
            if ep.enabled
        ]

    def list_sql_editable_endpoints(self) -> list[dict[str, Any]]:
        return self._sql_editor.list_sql_editable_endpoints()

    def get_editable_endpoint(self, api_id: str) -> ApiEndpointConfig:
        return self._sql_editor.get_editable_endpoint(api_id)

    def get_sql_for_api(self, api_id: str) -> dict[str, Any]:
        return self._sql_editor.get_sql_for_api(api_id)

    def update_sql_for_api(self, api_id: str, sql: str, actor: str, client_ip: str) -> dict[str, Any]:
        return self._sql_editor.update_sql_for_api(api_id, sql, actor, client_ip)

    def get_sql_validation_rules(self) -> dict[str, Any]:
        return self._sql_editor.get_sql_validation_rules()

    def list_sql_files(self) -> list[dict[str, Any]]:
        return self._sql_editor.list_sql_files()

    def create_sql_file(
        self, sql_id: str, sql: str, actor: str, client_ip: str, *, overwrite: bool = True,
    ) -> dict[str, Any]:
        return self._sql_editor.create_sql_file(
            sql_id, sql, actor, client_ip, overwrite=overwrite,
        )

    # ── DB health diagnostics (delegated to DbHealthService) ──────────────

    def list_db_connections(self) -> list[dict[str, Any]]:
        return self._db_health.list_db_connections()

    def get_db_health_data(
        self, connection_id: str, category: str, timeout_sec: float = 10.0,
    ) -> dict[str, Any]:
        return self._db_health.get_db_health_data(connection_id, category, timeout_sec)

    # ── Routing helpers ───────────────────────────────────────────────────

    def get_endpoint_by_path(self, request_path: str) -> ApiEndpointConfig | None:
        from .config import normalize_path
        return self.config.endpoints_by_path.get(normalize_path(request_path))

    def resolve_endpoint_reference(
        self, *, api_id: str | None = None, endpoint_value: str | None = None,
    ) -> ApiEndpointConfig | None:
        if api_id:
            endpoint = self.config.apis.get(str(api_id))
            if endpoint and endpoint.enabled:
                return endpoint
        if endpoint_value:
            raw_value = str(endpoint_value).strip()
            parsed_path = urlparse(raw_value).path if raw_value.startswith(("http://", "https://")) else raw_value
            return self.get_endpoint_by_path(parsed_path)
        return None

    # ── Log access (delegated to LogReader) ───────────────────────────────

    def get_logs(
        self,
        start_date_str: str | None = None,
        end_date_str: str | None = None,
        max_lines: int = 1000,
        cursor: str | None = None,
        follow_latest: bool = False,
    ) -> tuple[list[str], str | None, str, str]:
        return self._log_reader.get_logs(
            start_date_str, end_date_str, max_lines, cursor, follow_latest,
        )

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def reset_connections(self, connection_id: str | None = None) -> None:
        target_ids = [connection_id] if connection_id else list(self.db_pools.keys())
        for conn_id in target_ids:
            pool = self.db_pools.get(conn_id)
            if pool is None:
                continue
            pool.close_all()
            self.db_pools[conn_id] = DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))

    def _close_all_pools(self) -> None:
        for pool in self.db_pools.values():
            pool.close_all()

    # ── Phase 5B: partial reload ──────────────────────────────────────────

    def _apply_config_diff(self, diff, new_config: AppConfig) -> dict:
        """Mutate in-memory state to match diff. Called under _reload_lock.
        Returns dict with applied/skipped/errors arrays. Best-effort —
        per-resource try/except, no rollback.
        """
        applied: list[dict] = []
        skipped: list[dict] = []
        errors: list[dict] = []

        # ── Connections ─────────────────────────────────────────────────
        for cid in diff.connections.removed:
            try:
                pool = self.db_pools.pop(cid, None)
                if pool is not None:
                    pool.close_all()
                applied.append({"resource": "connection", "id": cid, "action": "pool_closed"})
            except Exception as exc:
                errors.append({"resource": "connection", "id": cid,
                               "action": "pool_close", "error": str(exc)})

        for cid in diff.connections.added:
            try:
                self.db_pools[cid] = DBConnectionPool(
                    max_size=int(get_env("DB_POOL_SIZE", "5"))
                )
                applied.append({"resource": "connection", "id": cid, "action": "pool_created"})
            except Exception as exc:
                errors.append({"resource": "connection", "id": cid,
                               "action": "pool_create", "error": str(exc)})

        for cid in diff.connections.changed:
            try:
                self.reset_connections(cid)
                applied.append({"resource": "connection", "id": cid, "action": "pool_reset"})
            except Exception as exc:
                errors.append({"resource": "connection", "id": cid,
                               "action": "pool_reset", "error": str(exc)})

        # ── APIs ────────────────────────────────────────────────────────
        for aid in diff.apis.removed:
            try:
                self._cache_manager.invalidate(aid)
                applied.append({"resource": "api", "id": aid,
                                "action": "removed_with_cache_clear"})
            except Exception as exc:
                errors.append({"resource": "api", "id": aid,
                               "action": "remove", "error": str(exc)})

        for aid in diff.apis.added:
            applied.append({"resource": "api", "id": aid, "action": "added"})

        for aid in diff.apis.changed_data:
            try:
                self._cache_manager.invalidate(aid)
                applied.append({"resource": "api", "id": aid,
                                "action": "data_changed_with_cache_invalidate"})
            except Exception as exc:
                errors.append({"resource": "api", "id": aid,
                               "action": "data_change", "error": str(exc)})

        for aid in diff.apis.changed_routing:
            try:
                self._cache_manager.invalidate(aid)
                applied.append({"resource": "api", "id": aid,
                                "action": "routing_changed_with_cache_invalidate"})
            except Exception as exc:
                errors.append({"resource": "api", "id": aid,
                               "action": "routing_change", "error": str(exc)})

        for aid in diff.apis.changed_schedule:
            applied.append({"resource": "api", "id": aid, "action": "schedule_changed"})

        for aid in diff.apis.changed_metadata:
            applied.append({"resource": "api", "id": aid, "action": "metadata_changed"})

        # ── Globals ─────────────────────────────────────────────────────
        if diff.globals.logging_changed:
            try:
                configure_logging(new_config.logging)
                self._log_reader.update_logging_config(new_config.logging)
                applied.append({"resource": "global", "field": "logging", "action": "applied"})
            except Exception as exc:
                errors.append({"resource": "global", "field": "logging",
                               "error": str(exc)})

        if diff.globals.auth_changed:
            applied.append({"resource": "global", "field": "auth",
                            "action": "metadata_only"})

        if diff.globals.rate_limits_changed:
            applied.append({"resource": "global", "field": "rate_limits",
                            "action": "metadata_only"})
            self.logger.warning(
                "rate_limits change saved to settings DB but Flask-Limiter captures "
                "values at decorator time — change applied on next BE restart"
            )

        for field_name in diff.globals.immutable_changed:
            skipped.append({"resource": "global", "field": field_name,
                            "reason": "requires_restart"})
            self.logger.warning(
                "Field '%s' change saved to settings DB but requires BE restart to take effect",
                field_name,
            )

        for field_name in diff.globals.runtime_metadata_changed:
            applied.append({"resource": "global", "field": field_name,
                            "action": "metadata_only"})

        if diff.globals.sql_validation_changed:
            applied.append({"resource": "global", "field": "sql_validation",
                            "action": "metadata_only"})

        return {"applied": applied, "skipped": skipped, "errors": errors}

    def reload(self) -> None:
        """Nuclear reload — recreates all executors / pools / cache / monitor
        threads. Phase 5B kept this as an explicit escape hatch (e.g. admin
        wants a fresh state). Most config save / monitor target save flows
        now use apply_partial_config_reload / apply_monitor_targets_partial.
        """
        with self._reload_lock:
            self._reload_unlocked()

    def _reload_unlocked(self) -> None:
        new_config = self._config_reloader()

        # JPype only honours the classpath given at startJVM time. If the
        # operator added a connection pointing at a jar that wasn't loaded
        # on this process's start, every query against that connection
        # will throw ClassNotFoundException until the BE is restarted.
        # I-2: WARN only for newly-missing jars; already-known missing jars
        # stay silent to avoid alert fatigue.
        self._check_classpath_for_reload(new_config)

        old_jdbc_executor = self.jdbc_executor
        old_monitor_executor = self.monitor_executor
        # 구 풀을 별도 변수로 보관해야 한다. 그렇지 않으면 self.db_pools 가
        # 새 dict 로 재할당된 뒤 구 풀들의 close 시점이 모호해지고, 최악의
        # 경우 in-flight 잡이 닫힌 커넥션을 참조하는 race 가 생긴다.
        old_pools = self.db_pools

        self._stop_background_refreshers()

        # 1) 새 executor + 새 풀을 모두 미리 준비한다.
        new_jdbc_executor = ThreadPoolExecutor(
            max_workers=new_config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        new_monitor_executor = ThreadPoolExecutor(
            max_workers=max(2, new_config.thread_pool_size // 2),
            thread_name_prefix="monitor-worker",
        )
        new_pools = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in new_config.connections
        }

        # 2) Atomic swap: 새 요청은 이 시점부터 새 executor + 새 풀을 본다.
        #    sub-services 는 lambda provider 를 통해 self.jdbc_executor /
        #    self.monitor_executor / self.db_pools 를 매번 lookup 하므로
        #    swap 직후 자동 반영된다.
        self.jdbc_executor = new_jdbc_executor
        self.monitor_executor = new_monitor_executor
        self.db_pools = new_pools

        # 3) 구 executor 를 gracefully drain.
        #    wait=True 로 기다려야 한다: in-flight _execute_jdbc 잡은 자신이 시작
        #    시점에 잡아둔 구 풀의 connection 으로 finally 정리(return/discard)
        #    까지 마쳐야 한다. 이 단계가 끝나기 전에 구 풀을 닫으면 close 된
        #    커넥션을 또 close 하는 race 가 생긴다.
        for executor in (old_jdbc_executor, old_monitor_executor):
            try:
                executor.shutdown(wait=True, cancel_futures=True)
            except TypeError:
                # Python 3.8 호환 (cancel_futures 는 3.9+)
                executor.shutdown(wait=True)

        # 4) 이제 in-flight 잡이 없음이 보장되므로 구 풀을 안전하게 닫는다.
        for pool in old_pools.values():
            pool.close_all()

        configure_logging(new_config.logging)
        self.logger = logging.getLogger("monitoring_backend")
        self.config = new_config
        self._cache_manager.clear()
        # LogReader holds a snapshot of logging-config (directory / file_prefix);
        # DbHealthService / JdbcQueryExecutor / EndpointCacheManager read
        # config/executor/pools via providers so they need no refresh.
        self._log_reader.update_logging_config(new_config.logging)
        self._cache_manager.start()
        # Monitor targets are owned by the settings DB, not AppConfig, so
        # a config reload doesn't change which targets are active — but
        # the collector threads were stopped by _stop_background_refreshers
        # above, so we need to restart them.
        self._monitor_collector.reload()

        enabled_apis = [ep for ep in new_config.apis.values() if ep.enabled]
        _startup_log(
            self.logger,
            "Config reloaded host=%s port=%s threadPoolSize=%s loadedApiCount=%s",
            new_config.host, new_config.port, new_config.thread_pool_size, len(enabled_apis),
        )
        for ep in enabled_apis:
            _startup_log(self.logger, "Hosted API id=%s path=%s", ep.api_id, ep.rest_api_path)

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
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable
from urllib.parse import urlparse

from .cache import EndpointCacheEntry
from .config import ApiEndpointConfig, AppConfig
from .db import DBConnectionPool, ensure_jvm_started
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
        self.executor = ThreadPoolExecutor(
            max_workers=self.config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        self.db_pools: dict[str, DBConnectionPool] = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in self.config.connections
        }
        # ── Sub-services (façade pattern) ──────────────────────────────
        # Use lambdas so the sub-services always observe the *current*
        # executor / db_pools / config — both `executor` and `db_pools`
        # are reassigned during reload().
        self._sql_repository = SqlRepository(settings_store)
        self._db_health = DbHealthService(
            config_provider=lambda: self.config,
            executor_provider=lambda: self.executor,
            pool_provider=lambda conn_id: self.db_pools[conn_id],
            logger=self.logger,
        )
        self._jdbc = JdbcQueryExecutor(
            sql_repository=self._sql_repository,
            config_provider=lambda: self.config,
            executor_provider=lambda: self.executor,
            pool_provider=lambda conn_id: self.db_pools[conn_id],
            logger=self.logger,
        )
        self._cache_manager = EndpointCacheManager(
            config_provider=lambda: self.config,
            executor_provider=lambda: self.executor,
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
            executor_provider=lambda: self.executor,
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

    # ── Cache management (delegated to EndpointCacheManager) ──────────────

    def _stop_background_refreshers(self) -> None:
        # Kept for monigrid_be.py shutdown hook (still calls this name).
        self._cache_manager.stop()
        self._monitor_collector.stop()

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
        self._monitor_collector.reload()

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

    def reload(self) -> None:
        new_config = self._config_reloader()
        old_executor = self.executor
        # 구 풀을 별도 변수로 보관해야 한다. 그렇지 않으면 self.db_pools 가
        # 새 dict 로 재할당된 뒤 구 풀들의 close 시점이 모호해지고, 최악의
        # 경우 in-flight 잡이 닫힌 커넥션을 참조하는 race 가 생긴다.
        old_pools = self.db_pools

        self._stop_background_refreshers()

        # 1) 새 executor + 새 풀을 모두 미리 준비한다.
        new_executor = ThreadPoolExecutor(
            max_workers=new_config.thread_pool_size,
            thread_name_prefix="jdbc-worker",
        )
        new_pools = {
            conn_id: DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
            for conn_id in new_config.connections
        }

        # 2) Atomic swap: 새 요청은 이 시점부터 새 executor + 새 풀을 본다.
        #    sub-services 는 lambda provider 를 통해 self.executor / self.db_pools
        #    를 매번 lookup 하므로 swap 직후 자동 반영된다.
        self.executor = new_executor
        self.db_pools = new_pools

        # 3) 구 executor 를 gracefully drain.
        #    wait=True 로 기다려야 한다: in-flight _execute_jdbc 잡은 자신이 시작
        #    시점에 잡아둔 구 풀의 connection 으로 finally 정리(return/discard)
        #    까지 마쳐야 한다. 이 단계가 끝나기 전에 구 풀을 닫으면 close 된
        #    커넥션을 또 close 하는 race 가 생긴다.
        try:
            old_executor.shutdown(wait=True, cancel_futures=True)
        except TypeError:
            # Python 3.8 호환 (cancel_futures 는 3.9+)
            old_executor.shutdown(wait=True)

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

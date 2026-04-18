"""JDBC query execution service.

Extracted from `MonitoringBackend._execute_jdbc` (SRP). Owns the SQL
load → JDBC submit → cursor lifecycle → connection-pool return path, plus
the per-process SQL change tracker (`sql_signatures`).

`MonitoringBackend.executor` and `db_pools` are reassigned during
`reload()`, so providers (callables) are used instead of direct refs to
guarantee the executor always observes the current state.

SQL bodies are loaded via a `SqlRepository` (settings DB). A-A nodes
share the same DB so one node's edit is immediately visible to the other
on its next query.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from time import perf_counter
from typing import Any, Callable

from .config import ApiEndpointConfig, AppConfig
from .db import DBConnectionPool
from .exceptions import QueryExecutionTimeoutError, SqlFileNotFoundError
from .settings_store import SqlRepository
from .utils import to_jsonable


class JdbcQueryExecutor:
    """Submits SQL workloads to a thread-pool and normalises rows to JSON."""

    def __init__(
        self,
        *,
        sql_repository: SqlRepository,
        config_provider: Callable[[], AppConfig],
        executor_provider: Callable[[], ThreadPoolExecutor],
        pool_provider: Callable[[str], DBConnectionPool],
        logger: logging.Logger,
    ) -> None:
        self._sql_repository = sql_repository
        self._config_provider = config_provider
        self._executor_provider = executor_provider
        self._pool_provider = pool_provider
        self._logger = logger
        self._sql_signatures: dict[str, str] = {}
        self._sql_sig_lock = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────

    def run_query(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        future = self._executor_provider().submit(self._execute_jdbc, endpoint, client_ip)
        try:
            return future.result(timeout=endpoint.query_timeout_sec)
        except FutureTimeoutError as error:
            future.cancel()
            raise QueryExecutionTimeoutError(endpoint.api_id, endpoint.query_timeout_sec) from error

    # ── Internals ─────────────────────────────────────────────────────────

    def _execute_jdbc(self, endpoint: ApiEndpointConfig, client_ip: str) -> Any:
        config = self._config_provider()
        conn_cfg = config.connections[endpoint.connection_id]
        pool = self._pool_provider(endpoint.connection_id)
        jdbc_conn = pool.get_connection(conn_cfg)
        cursor = None
        start_time = perf_counter()
        should_return_connection = True

        try:
            sql = self._sql_repository.get(endpoint.sql_id)
            if sql is None:
                self._logger.warning(
                    "SQL not found in settings DB sqlId=%s apiId=%s",
                    endpoint.sql_id, endpoint.api_id,
                )
                raise SqlFileNotFoundError(endpoint.sql_id, f"monigrid_sql_queries/{endpoint.sql_id}")
            self._track_sql_change(endpoint, sql)
            if self._logger.isEnabledFor(logging.DEBUG):
                sql_preview = " ".join(sql.split())[:200]
                self._logger.debug(
                    "JDBC execute begin apiId=%s sqlId=%s connectionId=%s sqlPreview=%r",
                    endpoint.api_id, endpoint.sql_id, endpoint.connection_id, sql_preview,
                )
            cursor = jdbc_conn.cursor()
            cursor.execute(sql)

            if cursor.description is None:
                jdbc_conn.commit()
                if self._logger.isEnabledFor(logging.DEBUG):
                    self._logger.debug(
                        "JDBC execute end (DML) apiId=%s rowCount=%s durationSec=%.3f",
                        endpoint.api_id, cursor.rowcount, perf_counter() - start_time,
                    )
                return {"updated": cursor.rowcount}

            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            result = [
                {col: to_jsonable(val) for col, val in zip(columns, row)}
                for row in rows
            ]
            if self._logger.isEnabledFor(logging.DEBUG):
                self._logger.debug(
                    "JDBC execute end (SELECT) apiId=%s columns=%s rowCount=%d durationSec=%.3f",
                    endpoint.api_id, columns, len(result), perf_counter() - start_time,
                )
            return result
        except Exception:
            elapsed = perf_counter() - start_time
            should_return_connection = False
            self._logger.exception(
                "Query execution failed apiId=%s path=%s connectionId=%s durationSec=%.3f clientIp=%s",
                endpoint.api_id, endpoint.rest_api_path, endpoint.connection_id, elapsed, client_ip,
            )
            raise
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    should_return_connection = False
            if should_return_connection:
                pool.return_connection(jdbc_conn)
            else:
                pool.discard_connection(jdbc_conn)

    def _track_sql_change(self, endpoint: ApiEndpointConfig, sql: str) -> None:
        with self._sql_sig_lock:
            previous_sql = self._sql_signatures.get(endpoint.sql_id)
            self._sql_signatures[endpoint.sql_id] = sql
        if previous_sql is None or previous_sql == sql:
            return
        self._logger.info(
            "SQL changed detected apiId=%s sqlId=%s previousSql=%r newSql=%r",
            endpoint.api_id, endpoint.sql_id, previous_sql, sql,
        )

"""JDBC query execution service.

Extracted from `MonitoringBackend._execute_jdbc` (SRP). Owns the SQL-file
load → JDBC submit → cursor lifecycle → connection-pool return path, plus
the per-process SQL-file change tracker (`sql_file_signatures`).

`MonitoringBackend.executor` and `db_pools` are reassigned during
`reload()`, so providers (callables) are used instead of direct refs to
guarantee the executor always observes the current state.
"""
from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from time import perf_counter
from typing import Any, Callable

from .config import ApiEndpointConfig, AppConfig
from .db import DBConnectionPool
from .exceptions import QueryExecutionTimeoutError
from .sql_validator import load_sql_file
from .utils import to_jsonable


class JdbcQueryExecutor:
    """Submits SQL workloads to a thread-pool and normalises rows to JSON."""

    def __init__(
        self,
        *,
        sql_dir: str,
        config_provider: Callable[[], AppConfig],
        executor_provider: Callable[[], ThreadPoolExecutor],
        pool_provider: Callable[[str], DBConnectionPool],
        logger: logging.Logger,
    ) -> None:
        self._sql_dir = sql_dir
        self._config_provider = config_provider
        self._executor_provider = executor_provider
        self._pool_provider = pool_provider
        self._logger = logger
        self._sql_file_signatures: dict[str, str] = {}
        self._sql_file_lock = threading.Lock()

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
            sql = load_sql_file(endpoint.sql_id, self._sql_dir, self._logger)
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
        sql_path = os.path.join(self._sql_dir, f"{endpoint.sql_id}.sql")
        with self._sql_file_lock:
            previous_sql = self._sql_file_signatures.get(endpoint.sql_id)
            self._sql_file_signatures[endpoint.sql_id] = sql
        if previous_sql is None or previous_sql == sql:
            return
        self._logger.info(
            "SQL changed detected apiId=%s sqlId=%s path=%s previousSql=%r newSql=%r",
            endpoint.api_id, endpoint.sql_id, sql_path, previous_sql, sql,
        )

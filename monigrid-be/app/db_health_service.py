"""DB health diagnostics service.

Extracted from `MonitoringBackend.get_db_health_data` (SRP). Owns the
diagnostic-SQL catalogue and the direct-execution helper used to run
ad-hoc diagnostic queries against any configured connection.

Because `MonitoringBackend.executor` and `db_pools` are *replaced* during
`reload()`, we accept callables (`executor_provider`, `pool_provider`,
`config_provider`) so the service always observes the current state
without needing to be re-instantiated on reload.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Callable

from .config import AppConfig
from .db import DBConnectionPool
from .utils import to_jsonable


# ── DB-type normalisation ──────────────────────────────────────────────────────

def _normalize_db_type(db_type: str) -> str:
    lower = (db_type or "").lower()
    if "oracle" in lower:
        return "oracle"
    if "mariadb" in lower or "mysql" in lower:
        return "mariadb"
    if "mssql" in lower or "sqlserver" in lower or "sql server" in lower:
        return "mssql"
    return lower


# ── Diagnostic SQL (indexed by (db_type_key, category)) ───────────────────────

_DIAGNOSTIC_SQL: dict[tuple[str, str], str] = {

    # ── Oracle ────────────────────────────────────────────────────────────────

    ("oracle", "slow_queries"): """
SELECT ROUND(elapsed_time / GREATEST(executions, 1) / 1000000, 3) AS avg_elapsed_sec,
       executions,
       ROUND(elapsed_time / 1000000, 2)                           AS total_elapsed_sec,
       sql_id,
       SUBSTR(sql_text, 1, 120)                                   AS sql_text
FROM   V$SQL
WHERE  executions > 0
  AND  elapsed_time / GREATEST(executions, 1) > 500000
ORDER BY elapsed_time / GREATEST(executions, 1) DESC
FETCH FIRST 20 ROWS ONLY
""".strip(),

    ("oracle", "tablespace"): """
SELECT m.tablespace_name,
       ROUND(m.used_space      * t.block_size / 1073741824, 2) AS used_gb,
       ROUND(m.tablespace_size * t.block_size / 1073741824, 2) AS total_gb,
       ROUND(m.used_percent, 1)                                AS used_pct,
       t.status
FROM   DBA_TABLESPACE_USAGE_METRICS m
JOIN   DBA_TABLESPACES t ON t.tablespace_name = m.tablespace_name
ORDER BY m.used_percent DESC
""".strip(),

    ("oracle", "locks"): """
SELECT s.sid,
       NVL(s.username, '(background)')                                       AS username,
       s.status,
       DECODE(l.lmode,
              0,'None', 1,'Null', 2,'Row-S (SS)', 3,'Row-X (SX)',
              4,'Share', 5,'S/Row-X (SSX)', 6,'Exclusive', l.lmode)          AS lock_mode,
       DECODE(l.request,
              0,'—', 1,'Null', 2,'Row-S', 3,'Row-X',
              4,'Share', 5,'S/Row-X', 6,'Exclusive', l.request)              AS lock_request,
       NVL(o.object_name, '—')                                               AS object_name,
       NVL(o.object_type, '—')                                               AS object_type,
       l.block                                                                AS is_blocker
FROM   V$LOCK l
JOIN   V$SESSION s ON s.sid = l.sid
LEFT JOIN DBA_OBJECTS o ON o.object_id = l.id1 AND l.type = 'TM'
WHERE  l.type IN ('TM', 'TX')
  AND  (l.block = 1 OR l.request > 0)
ORDER BY l.block DESC, s.sid
""".strip(),

    # ── MariaDB / MySQL ───────────────────────────────────────────────────────

    ("mariadb", "slow_queries"): """
SELECT LEFT(DIGEST_TEXT, 120)                                       AS sql_text,
       SCHEMA_NAME                                                   AS schema_name,
       COUNT_STAR                                                     AS exec_count,
       ROUND(AVG_TIMER_WAIT      / 1000000000000, 3)                 AS avg_elapsed_sec,
       ROUND(SUM_TIMER_WAIT      / 1000000000000, 3)                 AS total_elapsed_sec,
       ROUND(AVG_ROWS_EXAMINED,  0)                                  AS avg_rows_examined
FROM   performance_schema.events_statements_summary_by_digest
WHERE  AVG_TIMER_WAIT / 1000000000000 > 1.0
ORDER BY AVG_TIMER_WAIT DESC
LIMIT  20
""".strip(),

    ("mariadb", "tablespace"): """
SELECT TABLE_SCHEMA                                                   AS schema_name,
       TABLE_NAME                                                     AS table_name,
       ENGINE,
       TABLE_ROWS                                                     AS row_count,
       ROUND((DATA_LENGTH + INDEX_LENGTH) / 1073741824, 4)           AS total_gb,
       ROUND(DATA_LENGTH  / 1073741824, 4)                           AS data_gb,
       ROUND(INDEX_LENGTH / 1073741824, 4)                           AS index_gb
FROM   information_schema.TABLES
WHERE  TABLE_SCHEMA NOT IN
         ('information_schema', 'performance_schema', 'mysql', 'sys')
  AND  TABLE_TYPE = 'BASE TABLE'
ORDER BY DATA_LENGTH + INDEX_LENGTH DESC
LIMIT  30
""".strip(),

    ("mariadb", "locks"): """
SELECT r.trx_id                                           AS waiting_trx,
       r.trx_mysql_thread_id                             AS waiting_thread,
       LEFT(IFNULL(r.trx_query, '—'), 80)               AS waiting_sql,
       b.trx_id                                          AS blocking_trx,
       b.trx_mysql_thread_id                             AS blocking_thread,
       LEFT(IFNULL(b.trx_query, '—'), 80)               AS blocking_sql
FROM   information_schema.INNODB_TRX        b
JOIN   information_schema.INNODB_LOCK_WAITS w
         ON  b.trx_id = w.blocking_trx_id
JOIN   information_schema.INNODB_TRX        r
         ON  r.trx_id = w.requesting_trx_id
""".strip(),

    # ── MSSQL ─────────────────────────────────────────────────────────────────

    ("mssql", "slow_queries"): """
SELECT TOP 20
    qs.execution_count,
    ROUND(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000000.0, 3) AS avg_elapsed_sec,
    ROUND(qs.total_elapsed_time / 1000000.0, 2)                                  AS total_elapsed_sec,
    LEFT(st.text, 120)                                                            AS sql_text
FROM sys.dm_exec_query_stats   qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
WHERE qs.total_elapsed_time / NULLIF(qs.execution_count, 0) > 1000000
ORDER BY qs.total_elapsed_time / NULLIF(qs.execution_count, 0) DESC
""".strip(),

    ("mssql", "tablespace"): """
SELECT
    f.name                                                                     AS file_name,
    f.type_desc,
    ROUND(f.size                                     * 8.0 / 1048576, 2)      AS total_gb,
    ROUND(FILEPROPERTY(f.name, 'SpaceUsed')          * 8.0 / 1048576, 2)      AS used_gb,
    ROUND((f.size - FILEPROPERTY(f.name, 'SpaceUsed')) * 8.0 / 1048576, 2)   AS free_gb,
    f.physical_name
FROM sys.database_files f
ORDER BY f.size DESC
""".strip(),

    ("mssql", "locks"): """
SELECT
    r.session_id,
    r.wait_type,
    ROUND(r.wait_time / 1000.0, 1)   AS wait_sec,
    r.status,
    r.command,
    LEFT(st.text, 120)               AS sql_text
FROM sys.dm_exec_requests      r
CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
WHERE r.wait_type IS NOT NULL
  AND r.wait_type NOT LIKE 'SLEEP%'
  AND r.wait_type NOT LIKE 'XE_%'
  AND r.wait_type NOT LIKE 'BROKER_%'
ORDER BY r.wait_time DESC
""".strip(),
}


class DbHealthService:
    """Runs diagnostic queries (slow_queries / tablespace / locks) per DB type."""

    def __init__(
        self,
        *,
        config_provider: Callable[[], AppConfig],
        executor_provider: Callable[[], ThreadPoolExecutor],
        pool_provider: Callable[[str], DBConnectionPool],
        logger: logging.Logger,
    ) -> None:
        self._config_provider = config_provider
        self._executor_provider = executor_provider
        self._pool_provider = pool_provider
        self._logger = logger

    # ── Public API ────────────────────────────────────────────────────────

    def list_db_connections(self) -> list[dict[str, Any]]:
        """Return metadata for all configured DB connections."""
        config = self._config_provider()
        return [
            {
                "connectionId": conn_id,
                "dbType": conn.db_type,
                "jdbcUrl": conn.jdbc_url,
            }
            for conn_id, conn in config.connections.items()
        ]

    def get_db_health_data(
        self, connection_id: str, category: str, timeout_sec: float = 10.0,
    ) -> dict[str, Any]:
        """Execute a diagnostic query for `category` on `connection_id`.

        category: 'slow_queries' | 'tablespace' | 'locks'
        Returns columns, rows, durationSec, and error (if any). Never raises.
        """
        config = self._config_provider()
        conn_cfg = config.connections.get(connection_id)
        if conn_cfg is None:
            return self._empty_result(
                connection_id, "unknown", category,
                error=f"connection '{connection_id}' not configured",
            )

        db_type_key = _normalize_db_type(conn_cfg.db_type)
        sql = _DIAGNOSTIC_SQL.get((db_type_key, category))
        if sql is None:
            return self._empty_result(
                connection_id, conn_cfg.db_type, category,
                error=f"'{conn_cfg.db_type}' 에서 '{category}' 진단은 지원하지 않습니다",
            )

        started = perf_counter()
        queried_at = datetime.now(timezone.utc).isoformat()
        try:
            future = self._executor_provider().submit(
                self._execute_sql_direct, connection_id, sql,
            )
            rows = future.result(timeout=timeout_sec)
            duration = perf_counter() - started
            columns = list(rows[0].keys()) if rows else []
            self._logger.debug(
                "DB health query success connectionId=%s category=%s rows=%d durationSec=%.3f",
                connection_id, category, len(rows), duration,
            )
            return {
                "connectionId": connection_id,
                "dbType": conn_cfg.db_type,
                "category": category,
                "columns": columns,
                "rows": rows,
                "rowCount": len(rows),
                "durationSec": round(duration, 3),
                "queriedAt": queried_at,
                "error": None,
            }
        except FutureTimeoutError:
            duration = perf_counter() - started
            self._logger.warning(
                "DB health query timeout connectionId=%s category=%s timeoutSec=%.1f",
                connection_id, category, timeout_sec,
            )
            return self._empty_result(
                connection_id, conn_cfg.db_type, category,
                error=f"쿼리 타임아웃 ({timeout_sec:.0f}s)",
                duration=duration, queried_at=queried_at,
            )
        except Exception as err:
            duration = perf_counter() - started
            self._logger.warning(
                "DB health query failed connectionId=%s category=%s durationSec=%.3f detail=%s",
                connection_id, category, duration, err,
            )
            return self._empty_result(
                connection_id, conn_cfg.db_type, category,
                error=str(err), duration=duration, queried_at=queried_at,
            )

    # ── Internal helpers ──────────────────────────────────────────────────

    def _execute_sql_direct(self, connection_id: str, sql: str) -> list[dict[str, Any]]:
        """Execute a raw SQL string on the given connection and return rows as list of dicts."""
        config = self._config_provider()
        conn_cfg = config.connections[connection_id]
        pool = self._pool_provider(connection_id)
        jdbc_conn = pool.get_connection(conn_cfg)
        cursor = None
        should_return = True
        try:
            cursor = jdbc_conn.cursor()
            cursor.execute(sql)
            if cursor.description is None:
                return []
            columns = [desc[0] for desc in cursor.description]
            rows = cursor.fetchall()
            return [
                {col: to_jsonable(val) for col, val in zip(columns, row)}
                for row in rows
            ]
        except Exception:
            should_return = False
            raise
        finally:
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    should_return = False
            if should_return:
                pool.return_connection(jdbc_conn)
            else:
                pool.discard_connection(jdbc_conn)

    @staticmethod
    def _empty_result(
        connection_id: str, db_type: str, category: str, *,
        error: str, duration: float = 0.0, queried_at: str | None = None,
    ) -> dict[str, Any]:
        return {
            "connectionId": connection_id,
            "dbType": db_type,
            "category": category,
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "durationSec": round(duration, 3),
            "queriedAt": queried_at or datetime.now(timezone.utc).isoformat(),
            "error": error,
        }

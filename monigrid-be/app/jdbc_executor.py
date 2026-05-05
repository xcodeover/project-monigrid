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

import hashlib
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
        # conn_holder[0] 은 워커 스레드가 채워주는 jdbc_conn 참조.
        # FutureTimeoutError 발생 시 여기서 connection 을 discard 하기 위해 사용.
        # setQueryTimeout 이 DB-측 cancel 을 유발하면 워커의 finally 가
        # discard 를 처리하지만, driver 가 미지원이어서 워커가 영구 blocking 되는
        # 경우에 대한 방어로 run_query 레벨에서도 discard 를 시도한다.
        # 단, 워커 finally 와 이중 close 가 발생할 수 있으므로 Exception 은 무시한다.
        conn_holder: list = []
        pool_holder: list = []
        future = self._executor_provider().submit(
            self._execute_jdbc, endpoint, client_ip, conn_holder, pool_holder
        )
        try:
            return future.result(timeout=endpoint.query_timeout_sec)
        except FutureTimeoutError as error:
            future.cancel()  # PENDING 상태만 cancel — 이미 RUNNING 이면 noop
            if conn_holder and pool_holder:
                try:
                    pool_holder[0].discard_connection(conn_holder[0])
                except Exception as exc:
                    self._logger.warning(
                        "FutureTimeout 후 connection discard 실패 apiId=%s: %s",
                        endpoint.api_id, exc,
                    )
            raise QueryExecutionTimeoutError(endpoint.api_id, endpoint.query_timeout_sec) from error

    # ── Internals ─────────────────────────────────────────────────────────

    def _execute_jdbc(
        self,
        endpoint: ApiEndpointConfig,
        client_ip: str,
        conn_holder: list,
        pool_holder: list,
    ) -> Any:
        config = self._config_provider()
        conn_cfg = config.connections[endpoint.connection_id]
        pool = self._pool_provider(endpoint.connection_id)
        jdbc_conn = pool.get_connection(conn_cfg)
        # run_query 가 FutureTimeoutError 발생 시 connection 을 discard 할 수
        # 있도록 참조를 공유한다. conn_holder 는 워커 스레드가 채우고,
        # run_query 의 timeout 분기가 읽는다.
        conn_holder.append(jdbc_conn)
        pool_holder.append(pool)
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
            # ── setQueryTimeout: DB 측에서 쿼리를 강제 cancel ─────────────
            # JDBC Statement.setQueryTimeout(int seconds) 은 Statement 를
            # prepare 한 이후, execute() 이전에 호출해야 한다.
            # JayDeBeApi 1.2.3 의 cursor.execute() 는 내부적으로
            #   self._prep = self._connection.jconn.prepareStatement(operation)
            #   is_rs = self._prep.execute()
            # 순서로 동작하므로 setQueryTimeout 을 주입하려면 prepareStatement 와
            # execute() 사이를 가로채야 한다. cursor.execute() 를 호출하면
            # _close_last() 가 cursor._prep 을 초기화해 버리므로, 아래와 같이
            # PreparedStatement 를 직접 생성해 timeout 을 설정한 뒤 실행한다.
            # cursor._rs / _meta / rowcount 는 직접 채워 주어 이후 fetchall(),
            # description 이 정상 동작하도록 한다.
            timeout_sec = int(endpoint.query_timeout_sec)  # JDBC 표준: 초 단위
            self._execute_with_query_timeout(cursor, jdbc_conn, sql, timeout_sec, endpoint.api_id)

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

    def _execute_with_query_timeout(
        self, cursor, jdbc_conn, sql: str, timeout_sec: int, api_id: str
    ) -> None:
        """cursor.execute(sql) 에 JDBC setQueryTimeout 을 주입한다.

        JayDeBeApi 1.2.3 의 cursor.execute() 는
          1) _close_last()
          2) _prep = jconn.prepareStatement(sql)
          3) _prep.execute()
          4) _rs / _meta / rowcount 설정
        순으로 동작한다. setQueryTimeout 은 (2)~(3) 사이에 호출해야 하므로
        cursor.execute() 를 직접 호출하는 대신 같은 단계를 직접 수행한다.

        driver 가 setQueryTimeout 을 지원하지 않으면 warning 후 계속 진행한다.
        cursor 의 내부 상태(_prep, _rs, _meta, rowcount)를 JayDeBeApi 와
        동일하게 채워 두므로 이후 cursor.description / fetchall() / close() 는
        정상 동작한다.
        """
        import jaydebeapi

        # 1) 이전 결과셋·PreparedStatement 닫기 (JayDeBeApi의 _close_last() 역할)
        cursor._close_last()

        # 2) PreparedStatement 준비
        jconn = getattr(jdbc_conn, "jconn", None)
        if jconn is None:
            # fallback: jconn 없으면 표준 경로로 실행 (timeout 미적용)
            self._logger.warning(
                "jconn 을 찾을 수 없어 setQueryTimeout 미적용 apiId=%s", api_id
            )
            cursor.execute(sql)
            return

        cursor._prep = jconn.prepareStatement(sql)

        # 3) setQueryTimeout (JDBC 표준: 초 단위)
        try:
            cursor._prep.setQueryTimeout(timeout_sec)
        except Exception as exc:
            self._logger.warning(
                "setQueryTimeout 실패 (driver 미지원 가능) apiId=%s timeoutSec=%d: %s",
                api_id, timeout_sec, exc,
            )
            # 실패해도 계속 진행 — timeout 없이 실행

        # 4) 실행 — _handle_sql_exception() 은 항상 re-raise 한다.
        is_rs = False
        try:
            is_rs = cursor._prep.execute()
        except Exception:
            jaydebeapi._handle_sql_exception()

        # 5) 결과 상태 설정 (JayDeBeApi cursor.execute() 의 후처리와 동일)
        if is_rs:
            cursor._rs = cursor._prep.getResultSet()
            cursor._meta = cursor._rs.getMetaData()
            cursor.rowcount = -1
        else:
            cursor.rowcount = cursor._prep.getUpdateCount()

    def _track_sql_change(self, endpoint: ApiEndpointConfig, sql: str) -> None:
        with self._sql_sig_lock:
            previous_sql = self._sql_signatures.get(endpoint.sql_id)
            self._sql_signatures[endpoint.sql_id] = sql
        if previous_sql is None or previous_sql == sql:
            return
        # Log the change without leaking the SQL body. Operators occasionally
        # paste credentials or PII into queries, and the audit log stream is
        # not the right place for that. Short hashes are enough to correlate
        # "this version" of a query across log lines.
        prev_hash = hashlib.sha256(previous_sql.encode("utf-8")).hexdigest()[:8]
        new_hash = hashlib.sha256(sql.encode("utf-8")).hexdigest()[:8]
        self._logger.info(
            "SQL changed detected apiId=%s sqlId=%s prevHash=%s newHash=%s prevLen=%d newLen=%d",
            endpoint.api_id, endpoint.sql_id, prev_hash, new_hash,
            len(previous_sql), len(sql),
        )

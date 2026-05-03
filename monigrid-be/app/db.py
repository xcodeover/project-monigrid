"""JDBC connection pool with safe JVM lifecycle management."""
from __future__ import annotations

import logging
import os
import threading
import time

try:
    import jaydebeapi
except ImportError:
    jaydebeapi = None

try:
    import jpype
except ImportError:
    jpype = None

_jvm_lock = threading.Lock()
_jvm_started = False
# Records which jar paths were on the JVM classpath at startJVM time. JPype
# can't extend a running JVM's classpath, so reload() compares its desired
# jars against this set to detect drivers that would silently 404 with
# `ClassNotFoundException` until the process restarts.
_jvm_classpath: set[str] = set()
_logger = logging.getLogger("monitoring_backend")

# Transient connect failures (DB restart, brief network blip) heal on their
# own within seconds — retry a few times with backoff before surrendering so
# scheduler ticks don't keep storing error entries while the DB is still
# coming back up. The total ceiling (~3.5s with defaults) is small enough
# that callers don't notice on the first request after recovery.
_CONNECT_RETRY_ATTEMPTS = int(os.environ.get("DB_CONNECT_RETRY_ATTEMPTS", "3"))
_CONNECT_RETRY_BACKOFF_SEC = float(os.environ.get("DB_CONNECT_RETRY_BACKOFF_SEC", "0.5"))
_CONNECT_VALIDATION_TIMEOUT_SEC = int(os.environ.get("DB_CONNECT_VALIDATION_TIMEOUT_SEC", "2"))


def ensure_jvm_started(
    jvm_args: list[str] | None = None,
    classpath: list[str] | None = None,
) -> None:
    """Start the JVM exactly once with memory/stability options.

    Safe to call from any thread — uses a lock to prevent double-start.
    If the JVM is already running (e.g. started by another library), this is a no-op.

    Parameters:
        classpath: JDBC driver jar paths to include in the JVM classpath.
    """
    global _jvm_started
    if _jvm_started:
        return
    if jpype is None:
        return

    with _jvm_lock:
        if _jvm_started:
            return
        if jpype.isJVMStarted():
            _jvm_started = True
            if classpath:
                _jvm_classpath.update(classpath)
            _logger.info("JVM already running (started externally), skipping jpype.startJVM")
            return

        default_args = [
            "-Xms128m",
            "-Xmx512m",
            "-Djava.awt.headless=true",
            "-XX:+UseG1GC",
            "-XX:+ExitOnOutOfMemoryError",
        ]
        merged_args = list(jvm_args) if jvm_args else default_args

        # Collect classpath from jar paths
        cp_entries = list(dict.fromkeys(classpath)) if classpath else []

        java_home = os.environ.get("JAVA_HOME")
        jvm_path = jpype.getDefaultJVMPath()
        _logger.info(
            "Starting JVM jvmPath=%s JAVA_HOME=%s args=%s classpath=%s",
            jvm_path, java_home or "(not set)", merged_args, cp_entries,
        )
        try:
            jpype.startJVM(
                jvm_path,
                *merged_args,
                classpath=cp_entries or None,
                convertStrings=True,
            )
            _jvm_started = True
            _jvm_classpath.update(cp_entries)
            _logger.info("JVM started successfully")
        except OSError as e:
            if "already started" in str(e).lower() or "JVM is already started" in str(e):
                _jvm_started = True
                _jvm_classpath.update(cp_entries)
                _logger.warning("JVM start raised OSError but JVM is running: %s", e)
            else:
                _logger.error("Failed to start JVM: %s", e)
                raise


def jvm_classpath_missing(jars: list[str]) -> list[str]:
    """Return the subset of `jars` that is NOT on the running JVM's classpath.

    Used by reload() to detect newly-added JDBC drivers that the running
    JVM cannot pick up — JPype starts the JVM exactly once and won't extend
    its classpath at runtime, so anything missing here will throw
    `ClassNotFoundException` on first use and require a process restart.
    """
    return [j for j in jars if j and j not in _jvm_classpath]


class DBConnectionPool:
    """Thread-safe JDBC connection pool with max-size limit."""

    def __init__(self, max_size: int = 5) -> None:
        self.max_size = max_size
        self.available: list = []
        self.lock = threading.Lock()

    def _create_connection(self, jdbc_config):
        ensure_jvm_started()
        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug(
                "JDBC connect attempt driverClass=%s jdbcUrl=%s",
                jdbc_config.jdbc_driver_class, jdbc_config.jdbc_url,
            )
        last_exc: Exception | None = None
        for attempt in range(1, _CONNECT_RETRY_ATTEMPTS + 1):
            try:
                conn = jaydebeapi.connect(
                    jdbc_config.jdbc_driver_class,
                    jdbc_config.jdbc_url,
                    jdbc_config.driver_args,
                    list(jdbc_config.jdbc_jars),
                )
                if _logger.isEnabledFor(logging.DEBUG):
                    _logger.debug(
                        "JDBC connect success driverClass=%s jdbcUrl=%s attempt=%d",
                        jdbc_config.jdbc_driver_class, jdbc_config.jdbc_url, attempt,
                    )
                return conn
            except Exception as exc:
                last_exc = exc
                if attempt < _CONNECT_RETRY_ATTEMPTS:
                    backoff = _CONNECT_RETRY_BACKOFF_SEC * attempt
                    _logger.warning(
                        "JDBC connect failed driverClass=%s jdbcUrl=%s attempt=%d/%d "
                        "retryIn=%.2fs error=%s",
                        jdbc_config.jdbc_driver_class, jdbc_config.jdbc_url,
                        attempt, _CONNECT_RETRY_ATTEMPTS, backoff, exc,
                    )
                    time.sleep(backoff)
                else:
                    _logger.error(
                        "JDBC connect exhausted retries driverClass=%s jdbcUrl=%s attempts=%d error=%s",
                        jdbc_config.jdbc_driver_class, jdbc_config.jdbc_url,
                        _CONNECT_RETRY_ATTEMPTS, exc,
                    )
        # Re-raise the last exception so the caller (cache refresh, on-demand
        # query) records it as an error entry; the next scheduler tick or
        # request will retry from scratch — no permanent dead state.
        assert last_exc is not None
        raise last_exc

    def _is_connection_open(self, conn) -> bool:
        """Return True iff the connection is still usable.

        Checks ``isClosed`` first (cheap, local) and then ``isValid`` if
        available — the latter actually round-trips to the server, which is
        what catches the "TCP looks open but the DB restarted" case where
        ``isClosed`` lies. Both probes are best-effort: any exception is
        treated as "not open" so the pool drops the suspect connection.
        """
        if conn is None:
            return False
        try:
            jconn = getattr(conn, "jconn", None)
            if jconn is None:
                return True
            if hasattr(jconn, "isClosed"):
                try:
                    if bool(jconn.isClosed()):
                        return False
                except Exception:
                    return False
            if hasattr(jconn, "isValid"):
                try:
                    return bool(jconn.isValid(_CONNECT_VALIDATION_TIMEOUT_SEC))
                except Exception:
                    # isValid is the more reliable probe; if it raises the
                    # connection is almost certainly broken.
                    return False
            return True
        except Exception:
            return False

    def _safe_close(self, conn) -> bool:
        """Close `conn`, return True if it closed cleanly.

        Callers may use the return value to decide whether to log loudly
        (resource possibly leaked) or stay quiet (clean shutdown). The
        previous implementation silently swallowed every error which made
        connection leaks invisible in production.
        """
        if conn is None:
            return True
        try:
            conn.close()
            return True
        except Exception as exc:
            _logger.error("JDBC connection close failed — possible leak: %s", exc)
            return False

    def get_connection(self, jdbc_config):
        with self.lock:
            while self.available:
                conn = self.available.pop()
                if self._is_connection_open(conn):
                    if _logger.isEnabledFor(logging.DEBUG):
                        _logger.debug(
                            "JDBC pool reuse jdbcUrl=%s availableAfter=%d",
                            jdbc_config.jdbc_url, len(self.available),
                        )
                    return conn
                # Dead connection — close it (logged on failure) and keep
                # draining the pool until we find a live one or run out.
                self._safe_close(conn)
        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug("JDBC pool miss — creating new connection jdbcUrl=%s", jdbc_config.jdbc_url)
        return self._create_connection(jdbc_config)

    def return_connection(self, conn) -> None:
        if conn is None:
            return
        if not self._is_connection_open(conn):
            self._safe_close(conn)
            if _logger.isEnabledFor(logging.DEBUG):
                _logger.debug("JDBC pool return discarded reason=connection_closed")
            return
        with self.lock:
            if len(self.available) < self.max_size:
                self.available.append(conn)
                if _logger.isEnabledFor(logging.DEBUG):
                    _logger.debug("JDBC pool return ok availableNow=%d maxSize=%d",
                                  len(self.available), self.max_size)
                return
        # Pool is full: drop this connection on the floor. _safe_close logs
        # if the close itself fails so leaks aren't silent any more.
        self._safe_close(conn)
        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug("JDBC pool return discarded reason=pool_full maxSize=%d", self.max_size)

    def discard_connection(self, conn) -> None:
        self._safe_close(conn)

    def close_all(self) -> None:
        with self.lock:
            connections = list(self.available)
            self.available.clear()
        failed = 0
        for conn in connections:
            if not self._safe_close(conn):
                failed += 1
        if failed:
            _logger.warning(
                "JDBC pool close_all: %d/%d connections failed to close cleanly",
                failed, len(connections),
            )

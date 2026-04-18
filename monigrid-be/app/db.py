"""JDBC connection pool with safe JVM lifecycle management."""
from __future__ import annotations

import logging
import os
import threading

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
_logger = logging.getLogger("monitoring_backend")


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
            _logger.info("JVM started successfully")
        except OSError as e:
            if "already started" in str(e).lower() or "JVM is already started" in str(e):
                _jvm_started = True
                _logger.warning("JVM start raised OSError but JVM is running: %s", e)
            else:
                _logger.error("Failed to start JVM: %s", e)
                raise


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
        conn = jaydebeapi.connect(
            jdbc_config.jdbc_driver_class,
            jdbc_config.jdbc_url,
            jdbc_config.driver_args,
            list(jdbc_config.jdbc_jars),
        )
        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug(
                "JDBC connect success driverClass=%s jdbcUrl=%s",
                jdbc_config.jdbc_driver_class, jdbc_config.jdbc_url,
            )
        return conn

    def _is_connection_open(self, conn) -> bool:
        if conn is None:
            return False
        try:
            jconn = getattr(conn, "jconn", None)
            if jconn is not None and hasattr(jconn, "isClosed"):
                return not bool(jconn.isClosed())
        except Exception:
            return False
        return True

    def _safe_close(self, conn) -> None:
        if conn is None:
            return
        try:
            conn.close()
        except Exception:
            pass

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
        self._safe_close(conn)
        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug("JDBC pool return discarded reason=pool_full maxSize=%d", self.max_size)

    def discard_connection(self, conn) -> None:
        self._safe_close(conn)

    def close_all(self) -> None:
        with self.lock:
            connections = list(self.available)
            self.available.clear()
        for conn in connections:
            self._safe_close(conn)

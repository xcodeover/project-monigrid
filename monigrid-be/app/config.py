"""Application configuration: dataclasses and config loader."""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

from .utils import get_env, parse_enabled


_LOG_LEVEL_MAP: dict[str, int] = {
    "INFO": logging.INFO,
    "WARN": logging.WARNING,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "DEBUG": logging.DEBUG,
}


@dataclass(frozen=True)
class ConnectionConfig:
    connection_id: str
    db_type: str
    jdbc_driver_class: str
    jdbc_url: str
    jdbc_jars: tuple[str, ...]
    driver_args: Any


@dataclass(frozen=True)
class ApiEndpointConfig:
    api_id: str
    title: str
    rest_api_path: str
    connection_id: str
    sql_id: str
    enabled: bool
    refresh_interval_sec: int
    query_timeout_sec: float


@dataclass(frozen=True)
class LoggingConfig:
    directory: str
    file_prefix: str
    retention_days: int
    slow_query_threshold_sec: float
    level: int


@dataclass(frozen=True)
class RateLimitConfig:
    """Per-endpoint rate-limit strings (Flask-Limiter format, e.g. "60/minute")."""
    global_default: str
    auth_login: str
    dynamic_endpoint: str
    health_check: str
    health_check_batch: str
    network_test: str
    network_test_batch: str
    server_resources: str
    server_resources_batch: str
    monitor_refresh: str
    monitor_targets_batch: str
    cache_refresh: str
    reload_config: str


_DEFAULT_RATE_LIMITS = RateLimitConfig(
    global_default="200/minute",
    auth_login="10/minute",
    dynamic_endpoint="120/minute",
    health_check="60/minute",
    health_check_batch="60/minute",
    network_test="60/minute",
    network_test_batch="60/minute",
    server_resources="60/minute",
    server_resources_batch="60/minute",
    monitor_refresh="10/minute",
    monitor_targets_batch="10/minute",
    cache_refresh="30/minute",
    reload_config="5/minute",
)


@dataclass(frozen=True)
class AppConfig:
    version: str
    dashboard_title: str
    host: str
    port: int
    thread_pool_size: int
    default_refresh_interval_sec: int
    default_query_timeout_sec: float
    auth_username: str
    auth_password: str
    sql_validation_typo_patterns: dict[str, tuple[str, ...]]
    rate_limits: RateLimitConfig
    logging: LoggingConfig
    connections: dict[str, ConnectionConfig]
    apis: dict[str, ApiEndpointConfig]
    endpoints_by_path: dict[str, ApiEndpointConfig]


def normalize_path(path: str) -> str:
    cleaned = (path or "").strip()
    if not cleaned:
        raise ValueError("rest_api_path is required")
    if not cleaned.startswith("/"):
        cleaned = f"/{cleaned}"
    if len(cleaned) > 1 and cleaned.endswith("/"):
        cleaned = cleaned[:-1]
    return cleaned


def parse_jar_paths(raw_value: Any) -> list[str]:
    if raw_value is None:
        return []
    if isinstance(raw_value, str):
        return [
            token.strip()
            for token in re.split(r"[;,\n]", raw_value)
            if token and token.strip()
        ]
    if isinstance(raw_value, (list, tuple, set)):
        return [
            str(item).strip()
            for item in raw_value
            if item is not None and str(item).strip()
        ]
    candidate = str(raw_value).strip()
    return [candidate] if candidate else []


def resolve_jars(base_dir: str, jar_paths: list[str]) -> tuple[str, ...]:
    result = []
    for path in jar_paths:
        absolute_path = (
            path
            if os.path.isabs(path)
            else os.path.normpath(os.path.join(base_dir, path))
        )
        result.append(absolute_path)
    return tuple(result)


def load_app_config(config_path: str) -> AppConfig:
    import json

    with open(config_path, "r", encoding="utf-8") as file:
        raw = json.load(file)
    base_dir = os.path.dirname(os.path.abspath(config_path))
    return build_app_config(raw, base_dir)


def build_app_config(raw: dict[str, Any], base_dir: str) -> AppConfig:
    """Shared core used by both file-based and DB-based config loading.

    `base_dir` is used to resolve relative JDBC jar paths. For the DB path,
    pass the directory that holds drivers/ (typically the backend root).
    """
    from .__version__ import __version__ as _BUILD_VERSION
    from .sql_validator import normalize_typo_patterns

    server = raw.get("server", {})
    auth_section = raw.get("auth", {})
    sql_validation_section = raw.get("sql_validation", {})
    logging_section = raw.get("logging", {})
    rate_limits_section = raw.get("rate_limits", {})
    raw_connections = raw.get("connections", [])
    raw_apis = raw.get("apis", [])
    global_jdbc_jars = resolve_jars(
        base_dir,
        parse_jar_paths(raw.get("global_jdbc_jars")),
    )

    if not raw_connections:
        raise ValueError("connections must contain at least one item")
    if not raw_apis:
        raise ValueError("apis must contain at least one item")

    raw_level = str(
        logging_section.get("loglevel", logging_section.get("level", "INFO"))
    ).upper().strip()
    resolved_level = _LOG_LEVEL_MAP.get(raw_level, logging.INFO)
    sql_validation_typo_patterns = normalize_typo_patterns(
        sql_validation_section.get("typo_patterns")
    )

    logging_config = LoggingConfig(
        directory=os.path.normpath(
            os.path.join(base_dir, str(logging_section.get("directory", "logs")))
        ),
        file_prefix=str(logging_section.get("file_prefix", "monitoring_backend")),
        retention_days=max(1, int(logging_section.get("retention_days", 7))),
        slow_query_threshold_sec=max(
            0.0,
            float(logging_section.get("slow_query_threshold_sec", 10)),
        ),
        level=resolved_level,
    )

    connections: dict[str, ConnectionConfig] = {}
    for item in raw_connections:
        connection_id = str(item["id"])
        if connection_id in connections:
            raise ValueError(f"duplicate connection id: {connection_id}")

        driver_args = item.get("driver_args")
        if driver_args is None:
            username = item.get("username")
            password = item.get("password")
            driver_args = [username or "", password or ""] if (username or password) else []

        connection_jars = resolve_jars(
            base_dir,
            parse_jar_paths(item.get("jdbc_jars")),
        )
        merged_jars = tuple(dict.fromkeys([*global_jdbc_jars, *connection_jars]))

        connections[connection_id] = ConnectionConfig(
            connection_id=connection_id,
            db_type=str(item.get("db_type", "unknown")),
            jdbc_driver_class=str(item["jdbc_driver_class"]),
            jdbc_url=str(item["jdbc_url"]),
            jdbc_jars=merged_jars,
            driver_args=driver_args,
        )

    apis: dict[str, ApiEndpointConfig] = {}
    endpoints_by_path: dict[str, ApiEndpointConfig] = {}
    for item in raw_apis:
        api_id = str(item["id"])
        rest_api_path = normalize_path(str(item["rest_api_path"]))
        connection_id = str(item["connection_id"])
        enabled = parse_enabled(item.get("enabled", True))

        if api_id in apis:
            raise ValueError(f"duplicate api id: {api_id}")
        if enabled and rest_api_path in endpoints_by_path:
            raise ValueError(f"duplicate rest_api_path: {rest_api_path}")
        if connection_id not in connections:
            raise ValueError(
                f"api '{api_id}' references unknown connection '{connection_id}'"
            )

        endpoint = ApiEndpointConfig(
            api_id=api_id,
            title=str(item.get("title", api_id)),
            rest_api_path=rest_api_path,
            connection_id=connection_id,
            sql_id=str(item["sql_id"]),
            enabled=enabled,
            refresh_interval_sec=max(
                1,
                int(item.get("refresh_interval_sec", server.get("refresh_interval_sec", 5))),
            ),
            query_timeout_sec=max(
                1.0,
                float(item.get("query_timeout_sec", server.get("query_timeout_sec", 10))),
            ),
        )
        apis[api_id] = endpoint
        if enabled:
            endpoints_by_path[rest_api_path] = endpoint

    def _rl(key: str) -> str:
        """Read a single rate-limit value, falling back to the compiled default."""
        val = str(rate_limits_section.get(key, "")).strip()
        return val or getattr(_DEFAULT_RATE_LIMITS, key)

    rate_limits = RateLimitConfig(
        global_default=_rl("global_default"),
        auth_login=_rl("auth_login"),
        dynamic_endpoint=_rl("dynamic_endpoint"),
        health_check=_rl("health_check"),
        health_check_batch=_rl("health_check_batch"),
        network_test=_rl("network_test"),
        network_test_batch=_rl("network_test_batch"),
        server_resources=_rl("server_resources"),
        server_resources_batch=_rl("server_resources_batch"),
        monitor_refresh=_rl("monitor_refresh"),
        monitor_targets_batch=_rl("monitor_targets_batch"),
        cache_refresh=_rl("cache_refresh"),
        reload_config=_rl("reload_config"),
    )

    # Prefer version from config.json (user-editable), but fall back to the
    # build-time constant so a deployed config.json missing this field does
    # NOT display as "0.0.0" in the frontend footer.
    config_version = str(raw.get("version") or "").strip() or _BUILD_VERSION

    # dashboard_title: empty string → FE falls back to VITE_APP_TITLE
    dashboard_title = str(raw.get("dashboard_title") or "").strip()

    return AppConfig(
        version=config_version,
        dashboard_title=dashboard_title,
        host=str(server.get("host", "0.0.0.0")),
        port=int(server.get("port", 5000)),
        thread_pool_size=max(1, int(server.get("thread_pool_size", 8))),
        default_refresh_interval_sec=max(1, int(server.get("refresh_interval_sec", 5))),
        default_query_timeout_sec=max(1.0, float(server.get("query_timeout_sec", 10))),
        auth_username=str(auth_section.get("username", "admin")).strip() or "admin",
        auth_password=str(auth_section.get("password", "admin")).strip() or "admin",
        sql_validation_typo_patterns=sql_validation_typo_patterns,
        rate_limits=rate_limits,
        logging=logging_config,
        connections=connections,
        apis=apis,
        endpoints_by_path=endpoints_by_path,
    )

"""SQL editor service.

Reads/writes per-endpoint SQL queries and ad-hoc SQL entries through a
`SqlRepository` (settings DB). Cache refresh after a write is delegated
to a constructor-injected callback so this service has no dependency on
the cache layer (DIP).
"""
from __future__ import annotations

import logging
import re
from typing import Any, Callable

from .config import ApiEndpointConfig, AppConfig
from .exceptions import SqlFileNotFoundError
from .settings_store import SqlRepository
from .sql_validator import validate_select_only_sql

# sqlId 허용 패턴 — path traversal/특수문자 차단.
# 알파벳, 숫자, 언더스코어, 하이픈만 허용. 길이 1~64.
_SQL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


# Callback signature: (endpoint, client_ip) → None
OnSqlUpdated = Callable[[ApiEndpointConfig, str], None]


class SqlEditorService:
    """Reads, validates, and persists SQL entries in the settings DB."""

    def __init__(
        self,
        *,
        sql_repository: SqlRepository,
        config_provider: Callable[[], AppConfig],
        on_sql_updated: OnSqlUpdated,
        logger: logging.Logger,
    ) -> None:
        self._sql_repository = sql_repository
        self._config_provider = config_provider
        self._on_sql_updated = on_sql_updated
        self._logger = logger

    # ── Endpoint listings ─────────────────────────────────────────────────

    def list_sql_editable_endpoints(self) -> list[dict[str, Any]]:
        cfg = self._config_provider()
        return [
            {
                "id": ep.api_id,
                "title": ep.title,
                "restApiPath": ep.rest_api_path,
                "sqlId": ep.sql_id,
                "connectionId": ep.connection_id,
                # `dbType` lets the UI skip dialect-specific lints (e.g. FROM
                # requirement) that don't apply to MariaDB/MSSQL.
                "dbType": (
                    cfg.connections[ep.connection_id].db_type
                    if ep.connection_id in cfg.connections
                    else ""
                ),
            }
            for ep in cfg.apis.values()
            if ep.enabled
        ]

    def get_editable_endpoint(self, api_id: str) -> ApiEndpointConfig:
        endpoint = self._config_provider().apis.get(api_id)
        if endpoint is None or not endpoint.enabled:
            raise KeyError(api_id)
        return endpoint

    # ── Read / write SQL ──────────────────────────────────────────────────

    def get_sql_for_api(self, api_id: str) -> dict[str, Any]:
        endpoint = self.get_editable_endpoint(api_id)
        sql = self._sql_repository.get(endpoint.sql_id)
        if sql is None:
            raise SqlFileNotFoundError(endpoint.sql_id, f"monigrid_sql_queries/{endpoint.sql_id}")
        cfg = self._config_provider()
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "connectionId": endpoint.connection_id,
            "dbType": (
                cfg.connections[endpoint.connection_id].db_type
                if endpoint.connection_id in cfg.connections
                else ""
            ),
            "sql": sql,
        }

    def update_sql_for_api(self, api_id: str, sql: str, actor: str, client_ip: str) -> dict[str, Any]:
        endpoint = self.get_editable_endpoint(api_id)
        if self._sql_repository.get(endpoint.sql_id) is None:
            self._logger.warning(
                "SQL entry missing in settings DB sqlId=%s",
                endpoint.sql_id,
            )
            raise SqlFileNotFoundError(endpoint.sql_id, f"monigrid_sql_queries/{endpoint.sql_id}")

        cfg = self._config_provider()
        connection = cfg.connections.get(endpoint.connection_id)
        db_type = connection.db_type if connection else None

        normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
        validate_select_only_sql(
            normalized_sql, cfg.sql_validation_typo_patterns, db_type=db_type,
        )

        self._sql_repository.put(endpoint.sql_id, normalized_sql)

        self._logger.info(
            "SQL updated via admin apiId=%s sqlId=%s actor=%s clientIp=%s",
            endpoint.api_id, endpoint.sql_id, actor, client_ip,
        )
        self._on_sql_updated(endpoint, client_ip)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": normalized_sql,
        }

    # ── Standalone SQL create / list ──────────────────────────────────────

    def list_sql_files(self) -> list[dict[str, Any]]:
        """List all SQL entries currently present in the settings DB."""
        rows = self._sql_repository.list()
        result: list[dict[str, Any]] = []
        for row in rows:
            sql_id = row["sqlId"]
            result.append({
                "sqlId": sql_id,
                "fileName": f"{sql_id}.sql",
            })
        return result

    def create_sql_file(
        self, sql_id: str, sql: str, actor: str, client_ip: str, *, overwrite: bool = True,
    ) -> dict[str, Any]:
        """Create (or overwrite) a SQL entry in the settings DB.

        - sql_id is validated against `_SQL_ID_PATTERN` (no path traversal).
        - SQL body is validated via `validate_select_only_sql`.
        - When overwrite=False and the entry already exists, raises FileExistsError.
        - Independent of API endpoint config — the entry may exist before any
          endpoint references it (or after, for ad-hoc edits).
        """
        sql_id_clean = str(sql_id or "").strip()
        if not _SQL_ID_PATTERN.match(sql_id_clean):
            raise ValueError(
                "sqlId must contain only letters, digits, underscores, hyphens (1–64 chars)"
            )

        existing = self._sql_repository.get(sql_id_clean)
        already_exists = existing is not None
        if already_exists and not overwrite:
            raise FileExistsError(sql_id_clean)

        normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
        validate_select_only_sql(normalized_sql, self._config_provider().sql_validation_typo_patterns)

        self._sql_repository.put(sql_id_clean, normalized_sql)

        self._logger.info(
            "SQL entry %s sqlId=%s actor=%s clientIp=%s",
            "overwritten" if already_exists else "created",
            sql_id_clean, actor, client_ip,
        )

        # If this sqlId happens to be referenced by an active endpoint, refresh
        # its cache so the new content takes effect immediately. (Best-effort —
        # silently skip if no endpoint matches.)
        for endpoint in self._config_provider().apis.values():
            if endpoint.enabled and endpoint.sql_id == sql_id_clean:
                try:
                    self._on_sql_updated(endpoint, client_ip)
                except Exception:
                    self._logger.exception(
                        "Cache refresh after SQL save failed sqlId=%s apiId=%s",
                        sql_id_clean, endpoint.api_id,
                    )
                break

        return {
            "sqlId": sql_id_clean,
            "fileName": f"{sql_id_clean}.sql",
            "sql": normalized_sql,
            "created": not already_exists,
            "overwritten": already_exists,
        }

    # ── Validation rules ──────────────────────────────────────────────────

    def get_sql_validation_rules(self) -> dict[str, Any]:
        return {
            "typoPatterns": {
                key: list(values)
                for key, values in self._config_provider().sql_validation_typo_patterns.items()
            }
        }

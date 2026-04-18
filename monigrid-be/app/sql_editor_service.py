"""SQL editor service.

Extracted from `MonitoringBackend.{get,update}_sql_for_api` (SRP). Owns
the read/write/validate cycle for the per-endpoint SQL files. Cache
refresh after a write is delegated to a constructor-injected callback so
this service has no dependency on the cache layer (DIP).
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Callable

from .config import ApiEndpointConfig, AppConfig
from .exceptions import SqlFileNotFoundError
from .sql_validator import load_sql_file, validate_select_only_sql

# sqlId 허용 패턴 — path traversal/특수문자 차단.
# 알파벳, 숫자, 언더스코어, 하이픈만 허용. 길이 1~64.
_SQL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


# Callback signature: (endpoint, client_ip) → None
OnSqlUpdated = Callable[[ApiEndpointConfig, str], None]


class SqlEditorService:
    """Reads, validates, and persists per-endpoint SQL files."""

    def __init__(
        self,
        *,
        sql_dir: str,
        config_provider: Callable[[], AppConfig],
        on_sql_updated: OnSqlUpdated,
        logger: logging.Logger,
    ) -> None:
        self._sql_dir = sql_dir
        self._config_provider = config_provider
        self._on_sql_updated = on_sql_updated
        self._logger = logger

    # ── Endpoint listings ─────────────────────────────────────────────────

    def list_sql_editable_endpoints(self) -> list[dict[str, Any]]:
        return [
            {
                "id": ep.api_id,
                "title": ep.title,
                "restApiPath": ep.rest_api_path,
                "sqlId": ep.sql_id,
            }
            for ep in self._config_provider().apis.values()
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
        sql = load_sql_file(endpoint.sql_id, self._sql_dir, self._logger)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": sql,
        }

    def update_sql_for_api(self, api_id: str, sql: str, actor: str, client_ip: str) -> dict[str, Any]:
        endpoint = self.get_editable_endpoint(api_id)
        sql_path = os.path.join(self._sql_dir, f"{endpoint.sql_id}.sql")
        if not os.path.isfile(sql_path):
            self._logger.warning("SQL file not found sqlId=%s expectedPath=%s", endpoint.sql_id, sql_path)
            raise SqlFileNotFoundError(endpoint.sql_id, sql_path)

        normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
        validate_select_only_sql(normalized_sql, self._config_provider().sql_validation_typo_patterns)

        file_contents = f"{normalized_sql}\n"
        with open(sql_path, "w", encoding="utf-8") as file:
            file.write(file_contents)

        self._logger.info(
            "SQL updated via admin apiId=%s sqlId=%s path=%s actor=%s clientIp=%s",
            endpoint.api_id, endpoint.sql_id, sql_path, actor, client_ip,
        )
        # Delegate cache refresh to the injected callback (DIP — editor
        # does not know about EndpointCache or MonitoringBackend).
        self._on_sql_updated(endpoint, client_ip)
        return {
            "id": endpoint.api_id,
            "title": endpoint.title,
            "restApiPath": endpoint.rest_api_path,
            "sqlId": endpoint.sql_id,
            "sql": file_contents,
        }

    # ── Standalone SQL file create / list ─────────────────────────────────

    def list_sql_files(self) -> list[dict[str, Any]]:
        """List all .sql files currently present in the sql directory."""
        if not os.path.isdir(self._sql_dir):
            return []
        files: list[dict[str, Any]] = []
        for name in sorted(os.listdir(self._sql_dir)):
            if not name.endswith(".sql"):
                continue
            sql_id = name[:-4]
            full_path = os.path.join(self._sql_dir, name)
            try:
                size = os.path.getsize(full_path)
            except OSError:
                size = 0
            files.append({"sqlId": sql_id, "fileName": name, "sizeBytes": size})
        return files

    def create_sql_file(
        self, sql_id: str, sql: str, actor: str, client_ip: str, *, overwrite: bool = True,
    ) -> dict[str, Any]:
        """Create (or overwrite) a SQL file at <sql_dir>/<sql_id>.sql.

        - sql_id is validated against `_SQL_ID_PATTERN` (no path traversal).
        - SQL body is validated via `validate_select_only_sql`.
        - When overwrite=False and the file already exists, raises FileExistsError.
        - This is independent of the api endpoint configuration — the file may
          exist before any endpoint references it (or after, for ad-hoc edits).
        """
        sql_id_clean = str(sql_id or "").strip()
        if not _SQL_ID_PATTERN.match(sql_id_clean):
            raise ValueError(
                "sqlId must contain only letters, digits, underscores, hyphens (1–64 chars)"
            )

        # Ensure target dir exists (frozen exe-dir/sql may not exist on first run).
        os.makedirs(self._sql_dir, exist_ok=True)

        sql_path = os.path.join(self._sql_dir, f"{sql_id_clean}.sql")

        # Defense-in-depth: ensure resolved path is still inside sql_dir.
        resolved_sql_dir = os.path.realpath(self._sql_dir)
        resolved_sql_path = os.path.realpath(sql_path)
        if not resolved_sql_path.startswith(resolved_sql_dir + os.sep) \
                and resolved_sql_path != resolved_sql_dir:
            raise ValueError("invalid sqlId — resolved path escapes sql directory")

        already_exists = os.path.isfile(sql_path)
        if already_exists and not overwrite:
            raise FileExistsError(sql_path)

        normalized_sql = str(sql or "").replace("\r\n", "\n").strip()
        validate_select_only_sql(normalized_sql, self._config_provider().sql_validation_typo_patterns)

        file_contents = f"{normalized_sql}\n"
        with open(sql_path, "w", encoding="utf-8") as file:
            file.write(file_contents)

        self._logger.info(
            "SQL file %s sqlId=%s path=%s actor=%s clientIp=%s",
            "overwritten" if already_exists else "created",
            sql_id_clean, sql_path, actor, client_ip,
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
                        "Cache refresh after SQL file save failed sqlId=%s apiId=%s",
                        sql_id_clean, endpoint.api_id,
                    )
                break

        return {
            "sqlId": sql_id_clean,
            "fileName": f"{sql_id_clean}.sql",
            "path": sql_path,
            "sql": file_contents,
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

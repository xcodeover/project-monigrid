"""Settings store: persists backend configuration + SQL queries in a
centralized JDBC database.

Motivation: the backend runs in Active-Active behind a load balancer.
File-based state (config.json, sql/*.sql) cannot diverge between nodes,
so both nodes point at the same settings DB via initsetting.json.

Schema (all tables prefixed `monigrid_`):

  monigrid_settings_meta       (k PK, v)            — bootstrap flag, schema version
  monigrid_settings_kv         (section PK, value)  — scalar sections as JSON
  monigrid_connections         (id PK, ...)         — JDBC connections
  monigrid_apis                (id PK, ...)         — REST API endpoints
  monigrid_sql_queries         (sql_id PK, content, updated_at)
  monigrid_monitor_targets     (id PK, type, label, spec, interval_sec, enabled, updated_at)
                               — server-resource / network probes collected by the BE in the background
  monigrid_user_preferences    (username PK, value, updated_at)
                               — per-user UI state (layouts, thresholds, column order)
  monigrid_users               (username PK, password_hash, role, display_name, enabled, ...)
                               — admin-managed account directory (bcrypt hashes)

Cross-DB support: DDL is dialect-specific; DML is kept ANSI where
practical. Only Oracle / MariaDB / MS-SQL are supported.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Iterable

from .db import ensure_jvm_started

try:
    import jaydebeapi
except ImportError:
    jaydebeapi = None


SCHEMA_VERSION = "1"

_SUPPORTED_DB_TYPES = ("oracle", "mariadb", "mssql")


# ─── init settings ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SettingsDbConfig:
    db_type: str
    jdbc_driver_class: str
    jdbc_url: str
    username: str
    password: str
    jdbc_jars: tuple[str, ...]


def load_init_settings(path: str) -> SettingsDbConfig:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    section = raw.get("settings_db") or {}

    db_type = str(section.get("db_type", "")).strip().lower()
    if db_type not in _SUPPORTED_DB_TYPES:
        raise ValueError(
            f"initsetting.json: settings_db.db_type must be one of "
            f"{_SUPPORTED_DB_TYPES}, got {db_type!r}"
        )

    base_dir = os.path.dirname(os.path.abspath(path))
    raw_jars = section.get("jdbc_jars") or []
    if isinstance(raw_jars, str):
        raw_jars = [raw_jars]
    jars: list[str] = []
    for jar in raw_jars:
        s = str(jar).strip()
        if not s:
            continue
        jars.append(s if os.path.isabs(s) else os.path.normpath(os.path.join(base_dir, s)))

    return SettingsDbConfig(
        db_type=db_type,
        jdbc_driver_class=str(section["jdbc_driver_class"]),
        jdbc_url=str(section["jdbc_url"]),
        username=str(section.get("username", "")),
        password=str(section.get("password", "")),
        jdbc_jars=tuple(jars),
    )


# ─── DDL per dialect ──────────────────────────────────────────────────────────


def _ddl_statements(db_type: str) -> list[str]:
    """Return CREATE TABLE statements for the target dialect.

    Each statement is committed individually. Oracle has no native
    IF NOT EXISTS, so we probe USER_TABLES first at runtime.
    """
    if db_type == "mariadb":
        return [
            """
            CREATE TABLE IF NOT EXISTS monigrid_settings_meta (
                k VARCHAR(64) PRIMARY KEY,
                v VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_settings_kv (
                section VARCHAR(64) PRIMARY KEY,
                value LONGTEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_connections (
                id VARCHAR(128) PRIMARY KEY,
                db_type VARCHAR(32) NOT NULL,
                jdbc_driver_class VARCHAR(255) NOT NULL,
                jdbc_url VARCHAR(1024) NOT NULL,
                username VARCHAR(255),
                password VARCHAR(255),
                jdbc_jars LONGTEXT,
                extra_json LONGTEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_apis (
                id VARCHAR(128) PRIMARY KEY,
                title VARCHAR(255),
                rest_api_path VARCHAR(512) NOT NULL,
                connection_id VARCHAR(128) NOT NULL,
                sql_id VARCHAR(128) NOT NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                refresh_interval_sec INT NOT NULL DEFAULT 5,
                query_timeout_sec INT NOT NULL DEFAULT 30
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_sql_queries (
                sql_id VARCHAR(128) PRIMARY KEY,
                content LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_monitor_targets (
                id VARCHAR(128) PRIMARY KEY,
                type VARCHAR(32) NOT NULL,
                label VARCHAR(255),
                spec LONGTEXT NOT NULL,
                interval_sec INT NOT NULL DEFAULT 30,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_user_preferences (
                username VARCHAR(128) PRIMARY KEY,
                value LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_users (
                username VARCHAR(128) PRIMARY KEY,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(32) NOT NULL DEFAULT 'user',
                display_name VARCHAR(255),
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
        ]
    if db_type == "mssql":
        return [
            """
            IF OBJECT_ID('monigrid_settings_meta', 'U') IS NULL
            CREATE TABLE monigrid_settings_meta (
                k NVARCHAR(64) PRIMARY KEY,
                v NVARCHAR(255) NOT NULL
            )
            """,
            """
            IF OBJECT_ID('monigrid_settings_kv', 'U') IS NULL
            CREATE TABLE monigrid_settings_kv (
                section NVARCHAR(64) PRIMARY KEY,
                value NVARCHAR(MAX) NOT NULL
            )
            """,
            """
            IF OBJECT_ID('monigrid_connections', 'U') IS NULL
            CREATE TABLE monigrid_connections (
                id NVARCHAR(128) PRIMARY KEY,
                db_type NVARCHAR(32) NOT NULL,
                jdbc_driver_class NVARCHAR(255) NOT NULL,
                jdbc_url NVARCHAR(1024) NOT NULL,
                username NVARCHAR(255),
                password NVARCHAR(255),
                jdbc_jars NVARCHAR(MAX),
                extra_json NVARCHAR(MAX)
            )
            """,
            """
            IF OBJECT_ID('monigrid_apis', 'U') IS NULL
            CREATE TABLE monigrid_apis (
                id NVARCHAR(128) PRIMARY KEY,
                title NVARCHAR(255),
                rest_api_path NVARCHAR(512) NOT NULL,
                connection_id NVARCHAR(128) NOT NULL,
                sql_id NVARCHAR(128) NOT NULL,
                enabled BIT NOT NULL DEFAULT 1,
                refresh_interval_sec INT NOT NULL DEFAULT 5,
                query_timeout_sec INT NOT NULL DEFAULT 30
            )
            """,
            """
            IF OBJECT_ID('monigrid_sql_queries', 'U') IS NULL
            CREATE TABLE monigrid_sql_queries (
                sql_id NVARCHAR(128) PRIMARY KEY,
                content NVARCHAR(MAX) NOT NULL,
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            )
            """,
            """
            IF OBJECT_ID('monigrid_monitor_targets', 'U') IS NULL
            CREATE TABLE monigrid_monitor_targets (
                id NVARCHAR(128) PRIMARY KEY,
                type NVARCHAR(32) NOT NULL,
                label NVARCHAR(255),
                spec NVARCHAR(MAX) NOT NULL,
                interval_sec INT NOT NULL DEFAULT 30,
                enabled BIT NOT NULL DEFAULT 1,
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            )
            """,
            """
            IF OBJECT_ID('monigrid_user_preferences', 'U') IS NULL
            CREATE TABLE monigrid_user_preferences (
                username NVARCHAR(128) PRIMARY KEY,
                value NVARCHAR(MAX) NOT NULL,
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            )
            """,
            """
            IF OBJECT_ID('monigrid_users', 'U') IS NULL
            CREATE TABLE monigrid_users (
                username NVARCHAR(128) PRIMARY KEY,
                password_hash NVARCHAR(255) NOT NULL,
                role NVARCHAR(32) NOT NULL DEFAULT 'user',
                display_name NVARCHAR(255),
                enabled BIT NOT NULL DEFAULT 1,
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            )
            """,
        ]
    # oracle
    return [
        """
        CREATE TABLE monigrid_settings_meta (
            k VARCHAR2(64) PRIMARY KEY,
            v VARCHAR2(255) NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_settings_kv (
            section VARCHAR2(64) PRIMARY KEY,
            value CLOB NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_connections (
            id VARCHAR2(128) PRIMARY KEY,
            db_type VARCHAR2(32) NOT NULL,
            jdbc_driver_class VARCHAR2(255) NOT NULL,
            jdbc_url VARCHAR2(1024) NOT NULL,
            username VARCHAR2(255),
            password VARCHAR2(255),
            jdbc_jars CLOB,
            extra_json CLOB
        )
        """,
        """
        CREATE TABLE monigrid_apis (
            id VARCHAR2(128) PRIMARY KEY,
            title VARCHAR2(255),
            rest_api_path VARCHAR2(512) NOT NULL,
            connection_id VARCHAR2(128) NOT NULL,
            sql_id VARCHAR2(128) NOT NULL,
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            refresh_interval_sec NUMBER(10) DEFAULT 5 NOT NULL,
            query_timeout_sec NUMBER(10) DEFAULT 30 NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_sql_queries (
            sql_id VARCHAR2(128) PRIMARY KEY,
            content CLOB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_monitor_targets (
            id VARCHAR2(128) PRIMARY KEY,
            type VARCHAR2(32) NOT NULL,
            label VARCHAR2(255),
            spec CLOB NOT NULL,
            interval_sec NUMBER(10) DEFAULT 30 NOT NULL,
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_user_preferences (
            username VARCHAR2(128) PRIMARY KEY,
            value CLOB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_users (
            username VARCHAR2(128) PRIMARY KEY,
            password_hash VARCHAR2(255) NOT NULL,
            role VARCHAR2(32) DEFAULT 'user' NOT NULL,
            display_name VARCHAR2(255),
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
        """,
    ]


def _oracle_table_exists(cur, table: str) -> bool:
    cur.execute(
        "SELECT COUNT(*) FROM user_tables WHERE table_name = ?",
        [table.upper()],
    )
    row = cur.fetchone()
    return bool(row and int(row[0]) > 0)


# ─── SettingsStore ────────────────────────────────────────────────────────────


class SettingsStore:
    """Owns the JDBC connection to the settings DB and all read/write ops.

    Not thread-safe at the connection level — callers hold a process-wide
    store and should serialize writes. Reads use short-lived cursors.
    """

    def __init__(
        self,
        *,
        settings_db: SettingsDbConfig,
        logger: logging.Logger,
    ) -> None:
        self._cfg = settings_db
        self._logger = logger
        self._conn: Any = None

    # ── lifecycle ─────────────────────────────────────────────────────────

    def connect(self) -> None:
        if jaydebeapi is None:
            raise RuntimeError("jaydebeapi is required for settings DB access")
        ensure_jvm_started(classpath=list(self._cfg.jdbc_jars))
        self._logger.info(
            "Settings DB connecting dbType=%s url=%s",
            self._cfg.db_type, self._cfg.jdbc_url,
        )
        self._conn = jaydebeapi.connect(
            self._cfg.jdbc_driver_class,
            self._cfg.jdbc_url,
            [self._cfg.username, self._cfg.password],
            list(self._cfg.jdbc_jars),
        )
        try:
            self._conn.jconn.setAutoCommit(False)
        except Exception:
            pass

    def close(self) -> None:
        if self._conn is None:
            return
        try:
            self._conn.close()
        except Exception:
            pass
        self._conn = None

    # MariaDB/MSSQL servers reap idle connections (wait_timeout / keepalive). A
    # settings DB session may sit idle between admin ops and quietly die server
    # side — we detect that here and reconnect before handing out a cursor.
    def _ensure_connection_alive(self) -> None:
        if self._conn is None:
            raise RuntimeError("SettingsStore.connect() was not called")
        try:
            if self._conn.jconn.isValid(2):
                return
        except Exception:
            pass
        self._logger.warning(
            "Settings DB connection lost — reconnecting dbType=%s url=%s",
            self._cfg.db_type, self._cfg.jdbc_url,
        )
        try:
            self._conn.close()
        except Exception:
            pass
        self._conn = None
        self.connect()

    def _cursor(self):
        self._ensure_connection_alive()
        return self._conn.cursor()

    @property
    def db_type(self) -> str:
        return self._cfg.db_type

    # ── bootstrap ─────────────────────────────────────────────────────────

    def is_bootstrapped(self) -> bool:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT v FROM monigrid_settings_meta WHERE k = ?",
                ["bootstrapped"],
            )
            row = cur.fetchone()
            return bool(row and str(row[0]).lower() == "true")
        except Exception:
            return False
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def create_schema(self) -> None:
        """Create all monigrid_* tables if missing. Idempotent."""
        for stmt in _ddl_statements(self._cfg.db_type):
            self._execute_ddl(stmt)
        self._conn.commit()

    def _execute_ddl(self, stmt: str) -> None:
        normalized = stmt.strip()
        if not normalized:
            return
        cur = self._cursor()
        try:
            if self._cfg.db_type == "oracle":
                # Oracle lacks IF NOT EXISTS; probe user_tables to stay idempotent.
                table = _extract_table_name(normalized)
                if table and _oracle_table_exists(cur, table):
                    return
            cur.execute(normalized)
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def seed_from_config(self, config_dict: dict[str, Any], sql_files_dir: str) -> None:
        """First-run seed: write all config sections + sql/*.sql into the DB."""
        self.save_scalar_sections(config_dict)
        self.replace_connections(config_dict.get("connections") or [])
        self.replace_apis(config_dict.get("apis") or [])
        self.seed_sql_files(sql_files_dir)
        self._set_meta("schema_version", SCHEMA_VERSION)
        self._set_meta("bootstrapped", "true")
        self._conn.commit()

    def _set_meta(self, key: str, value: str) -> None:
        self._upsert(
            table="monigrid_settings_meta",
            key_col="k",
            key_value=key,
            values={"v": value},
        )

    # ── scalar KV sections ────────────────────────────────────────────────

    # Sections that are stored whole (as a JSON blob) in monigrid_settings_kv.
    _KV_SECTIONS = (
        "server",
        "auth",
        "rate_limits",
        "logging",
        "sql_validation",
    )
    # Top-level scalars stored each under its own key.
    _KV_SCALARS = (
        "version",
        "global_jdbc_jars",
    )

    def save_scalar_sections(self, config_dict: dict[str, Any]) -> None:
        for section in self._KV_SECTIONS:
            if section in config_dict:
                self._upsert_kv(section, json.dumps(config_dict[section], ensure_ascii=False))
        for scalar in self._KV_SCALARS:
            if scalar in config_dict:
                self._upsert_kv(scalar, json.dumps(config_dict[scalar], ensure_ascii=False))

    def _upsert_kv(self, section: str, value_json: str) -> None:
        self._upsert(
            table="monigrid_settings_kv",
            key_col="section",
            key_value=section,
            values={"value": value_json},
        )

    def load_scalar_sections(self) -> dict[str, Any]:
        cur = self._cursor()
        try:
            cur.execute("SELECT section, value FROM monigrid_settings_kv")
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        result: dict[str, Any] = {}
        for row in rows:
            section = str(row[0])
            raw = row[1]
            text = raw if isinstance(raw, str) else _read_clob(raw)
            try:
                result[section] = json.loads(text) if text else None
            except json.JSONDecodeError:
                result[section] = text
        return result

    # ── connections ───────────────────────────────────────────────────────

    def replace_connections(self, connections: Iterable[dict[str, Any]]) -> None:
        self._execute_simple("DELETE FROM monigrid_connections")
        for item in connections:
            self._insert_connection(item)

    def _insert_connection(self, item: dict[str, Any]) -> None:
        known = {"id", "db_type", "jdbc_driver_class", "jdbc_url", "username", "password", "jdbc_jars"}
        extras = {k: v for k, v in item.items() if k not in known}
        jars_raw = item.get("jdbc_jars")
        jars_text = jars_raw if isinstance(jars_raw, str) else (
            json.dumps(jars_raw, ensure_ascii=False) if jars_raw else None
        )
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_connections "
                "(id, db_type, jdbc_driver_class, jdbc_url, username, password, jdbc_jars, extra_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    str(item["id"]),
                    str(item.get("db_type", "")),
                    str(item["jdbc_driver_class"]),
                    str(item["jdbc_url"]),
                    item.get("username"),
                    item.get("password"),
                    jars_text,
                    json.dumps(extras, ensure_ascii=False) if extras else None,
                ],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def load_connections(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, db_type, jdbc_driver_class, jdbc_url, username, password, "
                "jdbc_jars, extra_json FROM monigrid_connections"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        result: list[dict[str, Any]] = []
        for row in rows:
            extra_text = _read_clob(row[7]) if row[7] is not None else None
            extras: dict[str, Any] = {}
            if extra_text:
                try:
                    extras = json.loads(extra_text)
                except json.JSONDecodeError:
                    extras = {}
            jars_text = _read_clob(row[6]) if row[6] is not None else None
            jars: Any = jars_text
            if jars_text:
                try:
                    parsed = json.loads(jars_text)
                    if isinstance(parsed, list):
                        jars = parsed
                except json.JSONDecodeError:
                    pass
            item = {
                "id": row[0],
                "db_type": row[1],
                "jdbc_driver_class": row[2],
                "jdbc_url": row[3],
                "username": row[4],
                "password": row[5],
            }
            if jars:
                item["jdbc_jars"] = jars
            item.update(extras)
            result.append(item)
        return result

    # ── apis ──────────────────────────────────────────────────────────────

    def replace_apis(self, apis: Iterable[dict[str, Any]]) -> None:
        self._execute_simple("DELETE FROM monigrid_apis")
        for item in apis:
            self._insert_api(item)

    def _insert_api(self, item: dict[str, Any]) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_apis "
                "(id, title, rest_api_path, connection_id, sql_id, enabled, "
                " refresh_interval_sec, query_timeout_sec) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    str(item["id"]),
                    item.get("title") or str(item["id"]),
                    str(item["rest_api_path"]),
                    str(item["connection_id"]),
                    str(item["sql_id"]),
                    1 if item.get("enabled", True) else 0,
                    int(item.get("refresh_interval_sec") or 5),
                    int(item.get("query_timeout_sec") or 30),
                ],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def load_apis(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, title, rest_api_path, connection_id, sql_id, enabled, "
                "refresh_interval_sec, query_timeout_sec FROM monigrid_apis"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [
            {
                "id": row[0],
                "title": row[1],
                "rest_api_path": row[2],
                "connection_id": row[3],
                "sql_id": row[4],
                "enabled": bool(row[5]),
                "refresh_interval_sec": int(row[6]),
                "query_timeout_sec": int(row[7]),
            }
            for row in rows
        ]

    # ── SQL queries ───────────────────────────────────────────────────────

    def seed_sql_files(self, sql_files_dir: str) -> None:
        """Import every *.sql file under sql_files_dir into monigrid_sql_queries."""
        if not os.path.isdir(sql_files_dir):
            return
        for name in sorted(os.listdir(sql_files_dir)):
            if not name.endswith(".sql"):
                continue
            sql_id = name[:-4]
            path = os.path.join(sql_files_dir, name)
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            self.upsert_sql(sql_id, content)

    def upsert_sql(self, sql_id: str, content: str) -> None:
        self._upsert(
            table="monigrid_sql_queries",
            key_col="sql_id",
            key_value=sql_id,
            values={"content": content},
            also_set_updated_at=True,
        )

    def get_sql(self, sql_id: str) -> str | None:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT content FROM monigrid_sql_queries WHERE sql_id = ?",
                [sql_id],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        if not row:
            return None
        return _read_clob(row[0])

    def list_sql_ids(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute("SELECT sql_id FROM monigrid_sql_queries ORDER BY sql_id")
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [{"sqlId": str(row[0])} for row in rows]

    def delete_sql(self, sql_id: str) -> None:
        cur = self._cursor()
        try:
            cur.execute("DELETE FROM monigrid_sql_queries WHERE sql_id = ?", [sql_id])
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── monitor targets (server-resource / network probes) ───────────────
    #
    # Rows here describe *what* the BE should poll, not per-user widget
    # layout. Each A-A node collects the same target independently and
    # exposes the latest snapshot via the monitor routes. Operators
    # maintain this list from the admin UI.
    _MONITOR_TARGET_TYPES = ("server_resource", "network")

    def list_monitor_targets(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, type, label, spec, interval_sec, enabled "
                "FROM monigrid_monitor_targets"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [_row_to_monitor_target(row) for row in rows]

    def get_monitor_target(self, target_id: str) -> dict[str, Any] | None:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, type, label, spec, interval_sec, enabled "
                "FROM monigrid_monitor_targets WHERE id = ?",
                [target_id],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return _row_to_monitor_target(row) if row else None

    def upsert_monitor_target(self, item: dict[str, Any]) -> dict[str, Any]:
        target_id = str(item.get("id") or "").strip()
        if not target_id:
            raise ValueError("monitor target id is required")
        target_type = str(item.get("type") or "").strip().lower()
        if target_type not in self._MONITOR_TARGET_TYPES:
            raise ValueError(
                f"monitor target type must be one of {self._MONITOR_TARGET_TYPES}, got {target_type!r}"
            )
        spec = item.get("spec")
        if not isinstance(spec, dict):
            raise ValueError("monitor target spec must be an object")
        label = str(item.get("label") or "").strip() or None
        interval_sec = max(1, int(item.get("interval_sec") or 30))
        enabled = 1 if item.get("enabled", True) else 0

        spec_json = json.dumps(spec, ensure_ascii=False)

        self._upsert(
            table="monigrid_monitor_targets",
            key_col="id",
            key_value=target_id,
            values={
                "type": target_type,
                "label": label,
                "spec": spec_json,
                "interval_sec": interval_sec,
                "enabled": enabled,
            },
            also_set_updated_at=True,
        )
        self._conn.commit()
        stored = self.get_monitor_target(target_id)
        assert stored is not None
        return stored

    def delete_monitor_target(self, target_id: str) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_monitor_targets WHERE id = ?",
                [target_id],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── user preferences (per-user UI state) ─────────────────────────────
    #
    # One row per user; `value` is an opaque JSON blob the FE round-trips.
    # Keyed by username (lowercased) — matches the JWT `username` claim. We
    # deliberately don't enforce a schema here: widget layouts, criteria
    # overrides, column order are all FE concerns, and forcing migrations
    # on each UI change would be painful. If the stored JSON can't parse
    # we return it as-is under a `raw` key so the FE can recover.

    def get_user_preferences(self, username: str) -> dict[str, Any] | None:
        key = _normalize_username(username)
        if not key:
            return None
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT value FROM monigrid_user_preferences WHERE username = ?",
                [key],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        if not row:
            return None
        text = _read_clob(row[0])
        if not text:
            return {}
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        except json.JSONDecodeError:
            return {"raw": text}

    def save_user_preferences(self, username: str, value: dict[str, Any]) -> dict[str, Any]:
        key = _normalize_username(username)
        if not key:
            raise ValueError("username is required")
        if not isinstance(value, dict):
            raise ValueError("preferences payload must be an object")
        value_json = json.dumps(value, ensure_ascii=False)
        self._upsert(
            table="monigrid_user_preferences",
            key_col="username",
            key_value=key,
            values={"value": value_json},
            also_set_updated_at=True,
        )
        self._conn.commit()
        return value

    def delete_user_preferences(self, username: str) -> None:
        key = _normalize_username(username)
        if not key:
            return
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_user_preferences WHERE username = ?",
                [key],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── users (admin-managed account directory) ──────────────────────────
    #
    # bcrypt hashes are stored verbatim. `role` is 'admin' or 'user' — the
    # JWT role claim comes from this column. While the table is empty the
    # login flow falls back to the env/config admin (bootstrap mode); once
    # an admin row exists the env fallback is refused so someone with the
    # env creds can't bypass DB-managed accounts.
    _USER_ROLES = ("admin", "user")

    def count_admin_users(self) -> int:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT COUNT(*) FROM monigrid_users WHERE role = ? AND enabled = 1",
                ["admin"],
            )
            row = cur.fetchone()
            return int(row[0]) if row else 0
        except Exception:
            return 0
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def list_users(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT username, role, display_name, enabled, created_at, updated_at "
                "FROM monigrid_users ORDER BY username"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [_row_to_user(row) for row in rows]

    def get_user(self, username: str) -> dict[str, Any] | None:
        key = _normalize_username(username)
        if not key:
            return None
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT username, role, display_name, enabled, created_at, updated_at "
                "FROM monigrid_users WHERE username = ?",
                [key],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return _row_to_user(row) if row else None

    def _get_user_hash(self, username: str) -> tuple[str, str, bool] | None:
        """Return (password_hash, role, enabled) for the username, or None."""
        key = _normalize_username(username)
        if not key:
            return None
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT password_hash, role, enabled FROM monigrid_users WHERE username = ?",
                [key],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        if not row:
            return None
        hash_text = _read_clob(row[0])
        return hash_text, str(row[1] or "user"), bool(row[2])

    def create_user(
        self,
        *,
        username: str,
        password_hash: str,
        role: str = "user",
        display_name: str | None = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        key = _normalize_username(username)
        if not key:
            raise ValueError("username is required")
        role_value = (role or "user").strip().lower()
        if role_value not in self._USER_ROLES:
            raise ValueError(f"role must be one of {self._USER_ROLES}, got {role!r}")
        if not password_hash:
            raise ValueError("password_hash is required")
        if self.get_user(key) is not None:
            raise ValueError(f"user already exists: {key}")
        cur = self._cursor()
        try:
            cur.execute(
                f"INSERT INTO monigrid_users "
                f"(username, password_hash, role, display_name, enabled, created_at, updated_at) "
                f"VALUES (?, ?, ?, ?, ?, {self._now_literal()}, {self._now_literal()})",
                [
                    key,
                    password_hash,
                    role_value,
                    (display_name or "").strip() or None,
                    1 if enabled else 0,
                ],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        stored = self.get_user(key)
        assert stored is not None
        return stored

    def update_user(
        self,
        username: str,
        *,
        password_hash: str | None = None,
        role: str | None = None,
        display_name: str | None = None,
        enabled: bool | None = None,
    ) -> dict[str, Any]:
        key = _normalize_username(username)
        if not key or self.get_user(key) is None:
            raise ValueError(f"user not found: {key}")
        sets: list[str] = []
        params: list[Any] = []
        if password_hash is not None:
            sets.append("password_hash = ?")
            params.append(password_hash)
        if role is not None:
            role_value = role.strip().lower()
            if role_value not in self._USER_ROLES:
                raise ValueError(f"role must be one of {self._USER_ROLES}, got {role!r}")
            sets.append("role = ?")
            params.append(role_value)
        if display_name is not None:
            sets.append("display_name = ?")
            params.append((display_name or "").strip() or None)
        if enabled is not None:
            sets.append("enabled = ?")
            params.append(1 if enabled else 0)
        if not sets:
            stored = self.get_user(key)
            assert stored is not None
            return stored
        sets.append(self._current_ts_expr("updated_at"))
        params.append(key)
        cur = self._cursor()
        try:
            cur.execute(
                f"UPDATE monigrid_users SET {', '.join(sets)} WHERE username = ?",
                params,
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        stored = self.get_user(key)
        assert stored is not None
        return stored

    def delete_user(self, username: str) -> None:
        key = _normalize_username(username)
        if not key:
            return
        cur = self._cursor()
        try:
            cur.execute("DELETE FROM monigrid_users WHERE username = ?", [key])
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── full config dict (the shape FE/config.py expects) ─────────────────

    def load_config_dict(self) -> dict[str, Any]:
        """Assemble a dict identical in shape to the original config.json."""
        result: dict[str, Any] = {}
        scalars = self.load_scalar_sections()
        result.update(scalars)
        result["connections"] = self.load_connections()
        result["apis"] = self.load_apis()
        return result

    def save_config_dict(self, config_dict: dict[str, Any]) -> None:
        """Persist a full config.json-shaped dict back to the DB.

        Semantics: replace-all for connections/apis; upsert for scalar KV.
        Meant for the /dashboard/config PUT path.
        """
        self.save_scalar_sections(config_dict)
        self.replace_connections(config_dict.get("connections") or [])
        self.replace_apis(config_dict.get("apis") or [])
        self._conn.commit()

    # ── internals: generic upsert ─────────────────────────────────────────

    def _upsert(
        self,
        *,
        table: str,
        key_col: str,
        key_value: str,
        values: dict[str, Any],
        also_set_updated_at: bool = False,
    ) -> None:
        """Cross-dialect upsert via probe-then-insert/update.

        This keeps the code readable across 3 dialects at the cost of an
        extra round-trip — acceptable for settings writes (low volume).
        """
        cur = self._cursor()
        try:
            cur.execute(
                f"SELECT 1 FROM {table} WHERE {key_col} = ?",
                [key_value],
            )
            exists = cur.fetchone() is not None
        finally:
            try:
                cur.close()
            except Exception:
                pass

        cur = self._cursor()
        try:
            if exists:
                set_parts = [f"{col} = ?" for col in values]
                params = list(values.values())
                if also_set_updated_at:
                    set_parts.append(self._current_ts_expr("updated_at"))
                params.append(key_value)
                cur.execute(
                    f"UPDATE {table} SET {', '.join(set_parts)} WHERE {key_col} = ?",
                    params,
                )
            else:
                cols = [key_col, *values.keys()]
                placeholders = ["?"] * len(cols)
                params = [key_value, *values.values()]
                if also_set_updated_at:
                    cols.append("updated_at")
                    placeholders.append(self._now_literal())
                cur.execute(
                    f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(placeholders)})",
                    params,
                )
        finally:
            try:
                cur.close()
            except Exception:
                pass

    def _current_ts_expr(self, col: str) -> str:
        if self._cfg.db_type == "mssql":
            return f"{col} = SYSUTCDATETIME()"
        return f"{col} = CURRENT_TIMESTAMP"

    def _now_literal(self) -> str:
        if self._cfg.db_type == "mssql":
            return "SYSUTCDATETIME()"
        return "CURRENT_TIMESTAMP"

    def _execute_simple(self, sql: str) -> None:
        cur = self._cursor()
        try:
            cur.execute(sql)
        finally:
            try:
                cur.close()
            except Exception:
                pass


# ─── helpers ──────────────────────────────────────────────────────────────────


def _read_clob(value: Any) -> str:
    """jaydebeapi returns CLOBs as Java objects on Oracle; unwrap to str."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    # jpype Java CLOB / Reader-like → getSubString
    try:
        length = value.length()
        return value.getSubString(1, int(length))
    except Exception:
        return str(value)


def _normalize_username(value: Any) -> str:
    """Return a canonical form (trimmed + lowercased) for the user key.

    Usernames flow in from JWT claims which preserve case on login; using
    a case-insensitive key prevents duplicate pref rows for "Admin" vs
    "admin".
    """
    return str(value or "").strip().lower()


def _row_to_user(row: Any) -> dict[str, Any]:
    created = row[4]
    updated = row[5]
    return {
        "username":     str(row[0]),
        "role":         str(row[1] or "user"),
        "display_name": row[2],
        "enabled":      bool(row[3]),
        "created_at":   created.isoformat() if hasattr(created, "isoformat") else (str(created) if created is not None else None),
        "updated_at":   updated.isoformat() if hasattr(updated, "isoformat") else (str(updated) if updated is not None else None),
    }


def _row_to_monitor_target(row: Any) -> dict[str, Any]:
    spec_text = _read_clob(row[3]) if row[3] is not None else ""
    try:
        spec = json.loads(spec_text) if spec_text else {}
    except json.JSONDecodeError:
        spec = {}
    return {
        "id":           str(row[0]),
        "type":         str(row[1]),
        "label":        row[2],
        "spec":         spec,
        "interval_sec": int(row[4]),
        "enabled":      bool(row[5]),
    }


def _extract_table_name(ddl: str) -> str | None:
    """Crude but sufficient for our internal DDL list."""
    upper = ddl.upper()
    idx = upper.find("CREATE TABLE")
    if idx < 0:
        return None
    tail = ddl[idx + len("CREATE TABLE"):].strip()
    # strip possible IF NOT EXISTS (not used for Oracle, defensive anyway)
    if tail.upper().startswith("IF NOT EXISTS"):
        tail = tail[len("IF NOT EXISTS"):].strip()
    end = 0
    while end < len(tail) and (tail[end].isalnum() or tail[end] == "_"):
        end += 1
    name = tail[:end]
    return name or None


# ─── SqlRepository: thin adapter used by jdbc_executor / sql_editor_service ───


class SqlRepository:
    """Read/write SQL queries out of the settings DB.

    Wraps SettingsStore so the executor and editor don't depend directly on
    settings-store internals. Write-through cache is intentionally omitted —
    a fresh SELECT on every run_query() keeps A-A nodes in sync the moment
    the other node edits a query.
    """

    def __init__(self, store: SettingsStore) -> None:
        self._store = store

    def get(self, sql_id: str) -> str | None:
        return self._store.get_sql(sql_id)

    def put(self, sql_id: str, content: str) -> None:
        self._store.upsert_sql(sql_id, content)
        self._store._conn.commit()

    def list(self) -> list[dict[str, Any]]:
        return self._store.list_sql_ids()

    def delete(self, sql_id: str) -> None:
        self._store.delete_sql(sql_id)

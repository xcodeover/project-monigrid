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
  monigrid_monitor_targets     (id PK, type, label, spec, interval_sec, enabled, updated_at, updated_by)
                               — server-resource / network probes collected by the BE in the background
  monigrid_user_preferences    (username PK, value, updated_at)
                               — per-user UI state (layouts, thresholds, column order)
  monigrid_users               (username PK, password_hash, role, display_name, enabled, ...)
                               — admin-managed account directory (bcrypt hashes)
  monigrid_alert_events        (id PK, source_type, source_id, metric, severity, level,
                                label, message, payload, created_at)
                               — raise/clear transitions emitted by the BE alert evaluator
                                 (Phase 1: monitor target collector). Time-ordered append-log;
                                 retention is ops-managed for now.
  monigrid_widget_configs      ((api_id, widget_type) PK, config JSON, updated_at)
                               — central display columns + alarm thresholds for data-API
                                 widgets (table / line-chart / bar-chart). FE per-user state
                                 (size, column order, column width) stays in user_preferences;
                                 only the *shared* definition lives here.

Cross-DB support: DDL is dialect-specific; DML is kept ANSI where
practical. Only Oracle / MariaDB / MS-SQL are supported.
"""
from __future__ import annotations

import functools
import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from .db import ensure_jvm_started

try:
    import jaydebeapi
except ImportError:
    jaydebeapi = None


SCHEMA_VERSION = "4"

_SUPPORTED_DB_TYPES = ("oracle", "mariadb", "mssql")

# Settings DB sits behind every config / SQL fetch, so a transient outage
# (DB restart, network blip) used to leave the store with `_conn=None` and
# every subsequent call permafailed. We now retry connect() on each
# `_ensure_connection_alive` invocation — the previous behaviour required
# a backend restart to recover, which is exactly what we're trying to avoid.
_SETTINGS_RECONNECT_ATTEMPTS = int(os.environ.get("SETTINGS_DB_RECONNECT_ATTEMPTS", "3"))
_SETTINGS_RECONNECT_BACKOFF_SEC = float(os.environ.get("SETTINGS_DB_RECONNECT_BACKOFF_SEC", "0.5"))


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
            # MariaDB implicitly adds ON UPDATE CURRENT_TIMESTAMP to the first
            # `TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP` column. For monigrid_apis
            # this is harmless (persistence is DELETE+INSERT). For monigrid_monitor_targets
            # the bump-on-UPDATE behavior matches the audit semantics we want.
            """
            CREATE TABLE IF NOT EXISTS monigrid_apis (
                id VARCHAR(128) PRIMARY KEY,
                title VARCHAR(255),
                rest_api_path VARCHAR(512) NOT NULL,
                connection_id VARCHAR(128) NOT NULL,
                sql_id VARCHAR(128) NOT NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                refresh_interval_sec INT NOT NULL DEFAULT 5,
                query_timeout_sec INT NOT NULL DEFAULT 30,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_by VARCHAR(128) NULL
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
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_by VARCHAR(128) NULL
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
            """
            CREATE TABLE IF NOT EXISTS monigrid_alert_events (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                source_type VARCHAR(32) NOT NULL,
                source_id VARCHAR(128) NOT NULL,
                metric VARCHAR(64),
                severity VARCHAR(16) NOT NULL,
                level VARCHAR(16),
                label VARCHAR(255),
                message VARCHAR(1024),
                payload LONGTEXT,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_alert_events_created (created_at),
                INDEX idx_alert_events_source (source_type, source_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_widget_configs (
                api_id VARCHAR(128) NOT NULL,
                widget_type VARCHAR(32) NOT NULL,
                config LONGTEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (api_id, widget_type)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_notification_channels (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                kind VARCHAR(32) NOT NULL UNIQUE,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                config_encrypted LONGTEXT,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_by VARCHAR(128) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_notification_groups (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(128) NOT NULL UNIQUE,
                description VARCHAR(512),
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_by VARCHAR(128) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_notification_recipients (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                group_id BIGINT NOT NULL,
                kind VARCHAR(16) NOT NULL DEFAULT 'email',
                address VARCHAR(255) NOT NULL,
                display_name VARCHAR(128),
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_recipients_group (group_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_notification_rules (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(128) NOT NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                source_type VARCHAR(32) NULL,
                source_id_pattern VARCHAR(255) NULL,
                metric_pattern VARCHAR(128) NULL,
                min_level VARCHAR(16) NOT NULL DEFAULT 'warn',
                recipient_group_id BIGINT NOT NULL,
                channel_id BIGINT NOT NULL,
                cooldown_sec INT NOT NULL DEFAULT 300,
                digest_window_sec INT NOT NULL DEFAULT 0,
                send_on_clear TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_by VARCHAR(128) NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_by VARCHAR(128) NULL,
                INDEX idx_rules_enabled (enabled)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_notification_queue (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                alert_event_id BIGINT NULL,
                rule_id BIGINT NULL,
                channel_id BIGINT NOT NULL,
                recipient_address VARCHAR(255) NOT NULL,
                subject VARCHAR(512) NOT NULL,
                body_html LONGTEXT,
                body_text LONGTEXT,
                status VARCHAR(16) NOT NULL DEFAULT 'pending',
                attempt INT NOT NULL DEFAULT 0,
                next_attempt_at TIMESTAMP NULL DEFAULT NULL,
                last_error VARCHAR(2048),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                sent_at TIMESTAMP NULL DEFAULT NULL,
                INDEX idx_queue_status (status, next_attempt_at),
                INDEX idx_queue_event (alert_event_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """,
            """
            CREATE TABLE IF NOT EXISTS monigrid_silence_rules (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(128) NOT NULL,
                source_type VARCHAR(32) NULL,
                source_id_pattern VARCHAR(255) NULL,
                metric_pattern VARCHAR(128) NULL,
                starts_at TIMESTAMP NOT NULL,
                ends_at TIMESTAMP NOT NULL,
                reason VARCHAR(512),
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_by VARCHAR(128) NULL,
                INDEX idx_silence_window (starts_at, ends_at)
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
                query_timeout_sec INT NOT NULL DEFAULT 30,
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_by NVARCHAR(128) NULL
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
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_by NVARCHAR(128) NULL
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
            """
            IF OBJECT_ID('monigrid_alert_events', 'U') IS NULL
            CREATE TABLE monigrid_alert_events (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                source_type NVARCHAR(32) NOT NULL,
                source_id NVARCHAR(128) NOT NULL,
                metric NVARCHAR(64),
                severity NVARCHAR(16) NOT NULL,
                level NVARCHAR(16),
                label NVARCHAR(255),
                message NVARCHAR(1024),
                payload NVARCHAR(MAX),
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            )
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_alert_events_created')
            CREATE INDEX idx_alert_events_created ON monigrid_alert_events (created_at)
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_alert_events_source')
            CREATE INDEX idx_alert_events_source ON monigrid_alert_events (source_type, source_id)
            """,
            """
            IF OBJECT_ID('monigrid_widget_configs', 'U') IS NULL
            CREATE TABLE monigrid_widget_configs (
                api_id NVARCHAR(128) NOT NULL,
                widget_type NVARCHAR(32) NOT NULL,
                config NVARCHAR(MAX) NOT NULL,
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                CONSTRAINT pk_widget_configs PRIMARY KEY (api_id, widget_type)
            )
            """,
            """
            IF OBJECT_ID('monigrid_notification_channels', 'U') IS NULL
            CREATE TABLE monigrid_notification_channels (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                kind NVARCHAR(32) NOT NULL UNIQUE,
                enabled BIT NOT NULL DEFAULT 1,
                config_encrypted NVARCHAR(MAX),
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_by NVARCHAR(128) NULL
            )
            """,
            """
            IF OBJECT_ID('monigrid_notification_groups', 'U') IS NULL
            CREATE TABLE monigrid_notification_groups (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                name NVARCHAR(128) NOT NULL UNIQUE,
                description NVARCHAR(512),
                enabled BIT NOT NULL DEFAULT 1,
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_by NVARCHAR(128) NULL
            )
            """,
            """
            IF OBJECT_ID('monigrid_notification_recipients', 'U') IS NULL
            CREATE TABLE monigrid_notification_recipients (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                group_id BIGINT NOT NULL,
                kind NVARCHAR(16) NOT NULL DEFAULT 'email',
                address NVARCHAR(255) NOT NULL,
                display_name NVARCHAR(128),
                enabled BIT NOT NULL DEFAULT 1,
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            )
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_recipients_group')
            CREATE INDEX idx_recipients_group ON monigrid_notification_recipients (group_id)
            """,
            """
            IF OBJECT_ID('monigrid_notification_rules', 'U') IS NULL
            CREATE TABLE monigrid_notification_rules (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                name NVARCHAR(128) NOT NULL,
                enabled BIT NOT NULL DEFAULT 1,
                source_type NVARCHAR(32) NULL,
                source_id_pattern NVARCHAR(255) NULL,
                metric_pattern NVARCHAR(128) NULL,
                min_level NVARCHAR(16) NOT NULL DEFAULT 'warn',
                recipient_group_id BIGINT NOT NULL,
                channel_id BIGINT NOT NULL,
                cooldown_sec INT NOT NULL DEFAULT 300,
                digest_window_sec INT NOT NULL DEFAULT 0,
                send_on_clear BIT NOT NULL DEFAULT 0,
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                created_by NVARCHAR(128) NULL,
                updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                updated_by NVARCHAR(128) NULL
            )
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_rules_enabled')
            CREATE INDEX idx_rules_enabled ON monigrid_notification_rules (enabled)
            """,
            """
            IF OBJECT_ID('monigrid_notification_queue', 'U') IS NULL
            CREATE TABLE monigrid_notification_queue (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                alert_event_id BIGINT NULL,
                rule_id BIGINT NULL,
                channel_id BIGINT NOT NULL,
                recipient_address NVARCHAR(255) NOT NULL,
                subject NVARCHAR(512) NOT NULL,
                body_html NVARCHAR(MAX),
                body_text NVARCHAR(MAX),
                status NVARCHAR(16) NOT NULL DEFAULT 'pending',
                attempt INT NOT NULL DEFAULT 0,
                next_attempt_at DATETIME2 NULL,
                last_error NVARCHAR(2048),
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                sent_at DATETIME2 NULL
            )
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_queue_status')
            CREATE INDEX idx_queue_status ON monigrid_notification_queue (status, next_attempt_at)
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_queue_event')
            CREATE INDEX idx_queue_event ON monigrid_notification_queue (alert_event_id)
            """,
            """
            IF OBJECT_ID('monigrid_silence_rules', 'U') IS NULL
            CREATE TABLE monigrid_silence_rules (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                name NVARCHAR(128) NOT NULL,
                source_type NVARCHAR(32) NULL,
                source_id_pattern NVARCHAR(255) NULL,
                metric_pattern NVARCHAR(128) NULL,
                starts_at DATETIME2 NOT NULL,
                ends_at DATETIME2 NOT NULL,
                reason NVARCHAR(512),
                created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                created_by NVARCHAR(128) NULL
            )
            """,
            """
            IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_silence_window')
            CREATE INDEX idx_silence_window ON monigrid_silence_rules (starts_at, ends_at)
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
            query_timeout_sec NUMBER(10) DEFAULT 30 NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_by VARCHAR2(128) NULL
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
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_by VARCHAR2(128) NULL
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
        """
        CREATE TABLE monigrid_alert_events (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            source_type VARCHAR2(32) NOT NULL,
            source_id VARCHAR2(128) NOT NULL,
            metric VARCHAR2(64),
            severity VARCHAR2(16) NOT NULL,
            level VARCHAR2(16),
            label VARCHAR2(255),
            message VARCHAR2(1024),
            payload CLOB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE monigrid_widget_configs (
            api_id VARCHAR2(128) NOT NULL,
            widget_type VARCHAR2(32) NOT NULL,
            config CLOB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            CONSTRAINT pk_widget_configs PRIMARY KEY (api_id, widget_type)
        )
        """,
        """
        CREATE TABLE monigrid_notification_channels (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            kind VARCHAR2(32) NOT NULL UNIQUE,
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            config_encrypted CLOB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_by VARCHAR2(128) NULL
        )
        """,
        """
        CREATE TABLE monigrid_notification_groups (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            name VARCHAR2(128) NOT NULL UNIQUE,
            description VARCHAR2(512),
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_by VARCHAR2(128) NULL
        )
        """,
        """
        CREATE TABLE monigrid_notification_recipients (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            group_id NUMBER NOT NULL,
            kind VARCHAR2(16) DEFAULT 'email' NOT NULL,
            address VARCHAR2(255) NOT NULL,
            display_name VARCHAR2(128),
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
        """,
        """
        CREATE INDEX idx_recipients_group ON monigrid_notification_recipients (group_id)
        """,
        """
        CREATE TABLE monigrid_notification_rules (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            name VARCHAR2(128) NOT NULL,
            enabled NUMBER(1) DEFAULT 1 NOT NULL,
            source_type VARCHAR2(32) NULL,
            source_id_pattern VARCHAR2(255) NULL,
            metric_pattern VARCHAR2(128) NULL,
            min_level VARCHAR2(16) DEFAULT 'warn' NOT NULL,
            recipient_group_id NUMBER NOT NULL,
            channel_id NUMBER NOT NULL,
            cooldown_sec NUMBER(10) DEFAULT 300 NOT NULL,
            digest_window_sec NUMBER(10) DEFAULT 0 NOT NULL,
            send_on_clear NUMBER(1) DEFAULT 0 NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            created_by VARCHAR2(128) NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            updated_by VARCHAR2(128) NULL
        )
        """,
        """
        CREATE INDEX idx_rules_enabled ON monigrid_notification_rules (enabled)
        """,
        """
        CREATE TABLE monigrid_notification_queue (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            alert_event_id NUMBER NULL,
            rule_id NUMBER NULL,
            channel_id NUMBER NOT NULL,
            recipient_address VARCHAR2(255) NOT NULL,
            subject VARCHAR2(512) NOT NULL,
            body_html CLOB,
            body_text CLOB,
            status VARCHAR2(16) DEFAULT 'pending' NOT NULL,
            attempt NUMBER(10) DEFAULT 0 NOT NULL,
            next_attempt_at TIMESTAMP NULL,
            last_error VARCHAR2(2048),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            sent_at TIMESTAMP NULL
        )
        """,
        """
        CREATE INDEX idx_queue_status ON monigrid_notification_queue (status, next_attempt_at)
        """,
        """
        CREATE INDEX idx_queue_event ON monigrid_notification_queue (alert_event_id)
        """,
        """
        CREATE TABLE monigrid_silence_rules (
            id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            name VARCHAR2(128) NOT NULL,
            source_type VARCHAR2(32) NULL,
            source_id_pattern VARCHAR2(255) NULL,
            metric_pattern VARCHAR2(128) NULL,
            starts_at TIMESTAMP NOT NULL,
            ends_at TIMESTAMP NOT NULL,
            reason VARCHAR2(512),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
            created_by VARCHAR2(128) NULL
        )
        """,
        """
        CREATE INDEX idx_silence_window ON monigrid_silence_rules (starts_at, ends_at)
        """,
    ]


def _oracle_table_exists(cur, table: str) -> bool:
    cur.execute(
        "SELECT COUNT(*) FROM user_tables WHERE table_name = ?",
        [table.upper()],
    )
    row = cur.fetchone()
    return bool(row and int(row[0]) > 0)


def _oracle_index_exists(cur, index: str) -> bool:
    cur.execute(
        "SELECT COUNT(*) FROM user_indexes WHERE index_name = ?",
        [index.upper()],
    )
    row = cur.fetchone()
    return bool(row and int(row[0]) > 0)


# ─── SettingsStore ────────────────────────────────────────────────────────────


def _sync(method):
    # Single JDBC connection is shared across collector threads, the cache
    # refresh loop, and Flask workers — concurrent cursors on it raised
    # `Connection is busy` / `ResultSet already closed`. RLock serializes
    # public ops so multi-statement sequences stay atomic against peers.
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return wrapper


class SettingsStore:
    """Owns the JDBC connection to the settings DB and all read/write ops.

    All public methods serialize on `self._lock` (RLock) so that the single
    JDBC connection is not addressed by two cursors simultaneously. Helpers
    that are only invoked from already-locked methods (`_cursor`, `_upsert`,
    `_set_meta`, `_execute_simple`, etc.) intentionally skip the decorator —
    RLock would let them re-enter, but the extra wrapping is unnecessary.
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
        self._lock = threading.RLock()
        # Tracks whether `connect()` was ever successfully called. Without
        # this, the "you forgot to call connect()" guard in
        # `_ensure_connection_alive` would fire whenever a reconnect attempt
        # left `_conn=None`, masking the real (transient DB outage) error
        # behind a misleading "not initialized" message.
        self._ever_connected = False

    # ── lifecycle ─────────────────────────────────────────────────────────

    @_sync
    def connect(self) -> None:
        if jaydebeapi is None:
            raise RuntimeError("jaydebeapi is required for settings DB access")
        # JVM 시작 시 settings DB driver 만 넣지 말고, 같은 drivers/ 디렉토리에
        # 있는 *.jar 도 모두 포함시킨다. JPype 는 startJVM 이후 classpath 추가가
        # 불가능하기 때문에, MonitoringBackend 가 나중에 connection 별 driver 를
        # 추가하려 해도 silent ignore 된다 (기존엔 "JDBC jars not on classpath at
        # boot" 경고로 노출됨). settings_store 가 부팅 첫 진입점이라 여기서 한
        # 번에 다 로드해두면 connection 등록 / 추가, ConfigEditor 의 connection
        # test 등 모든 후속 JDBC 사용처에서 driver class 를 찾을 수 있다.
        import glob as _glob
        classpath_jars = list(self._cfg.jdbc_jars)
        for d in {os.path.dirname(j) for j in classpath_jars if j}:
            for jar_path in _glob.glob(os.path.join(d, "*.jar")):
                if jar_path not in classpath_jars:
                    classpath_jars.append(jar_path)
        ensure_jvm_started(classpath=classpath_jars)
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
        self._normalize_session_timezone()
        self._ever_connected = True

    def _normalize_session_timezone(self) -> None:
        """Pin session timezone to UTC so TIMESTAMP / DATETIME values come back
        in UTC regardless of the DB server's local timezone.

        mssql DATETIME2 has no session timezone, so this is a no-op there.
        """
        db = self._cfg.db_type
        sql = None
        if db == "mariadb":
            sql = "SET time_zone = '+00:00'"
        elif db == "oracle":
            sql = "ALTER SESSION SET TIME_ZONE = '+00:00'"
        if sql is None:
            return
        cur = self._conn.cursor()
        try:
            cur.execute(sql)
        except Exception as exc:
            # Non-fatal — log and proceed; subsequent reads may have non-UTC
            # offsets but the system is still functional.
            self._logger.warning(
                "session timezone normalization failed (%s): %s — falling back to server default",
                db, exc,
            )
        finally:
            try: cur.close()
            except Exception: pass

    @_sync
    def close(self) -> None:
        if self._conn is None:
            return
        try:
            self._conn.close()
        except Exception:
            pass
        self._conn = None

    # MariaDB/MSSQL servers reap idle connections (wait_timeout / keepalive),
    # and the settings DB itself can restart underneath us. Either way the
    # session quietly dies server-side — we detect that here and reconnect
    # before handing out a cursor. Reconnect is bounded-retry (not single-shot)
    # so a brief DB outage heals on the very next caller instead of leaving
    # the process wedged until restart.
    def _ensure_connection_alive(self) -> None:
        if not self._ever_connected:
            raise RuntimeError("SettingsStore.connect() was not called")
        if self._conn is not None:
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

        last_exc: Exception | None = None
        for attempt in range(1, _SETTINGS_RECONNECT_ATTEMPTS + 1):
            try:
                self.connect()
                return
            except Exception as exc:
                last_exc = exc
                if attempt < _SETTINGS_RECONNECT_ATTEMPTS:
                    backoff = _SETTINGS_RECONNECT_BACKOFF_SEC * attempt
                    self._logger.warning(
                        "Settings DB reconnect failed dbType=%s url=%s attempt=%d/%d "
                        "retryIn=%.2fs error=%s",
                        self._cfg.db_type, self._cfg.jdbc_url,
                        attempt, _SETTINGS_RECONNECT_ATTEMPTS, backoff, exc,
                    )
                    time.sleep(backoff)
                else:
                    self._logger.error(
                        "Settings DB reconnect exhausted dbType=%s url=%s attempts=%d error=%s",
                        self._cfg.db_type, self._cfg.jdbc_url,
                        _SETTINGS_RECONNECT_ATTEMPTS, exc,
                    )
        # Surface to the caller. `_conn` stays None; the next call retries
        # from scratch instead of dying on the "connect() was not called"
        # guard, so the store auto-heals once the DB is back.
        assert last_exc is not None
        raise RuntimeError(f"Settings DB unavailable: {last_exc}") from last_exc

    def _cursor(self):
        self._ensure_connection_alive()
        return self._conn.cursor()

    @_sync
    def commit(self) -> None:
        """Public commit hook for callers that perform writes via this store.

        Mariadb / MSSQL run with autocommit disabled, so any
        upsert / delete needs an explicit commit to be visible to other
        sessions (and other Active-Active nodes). Going through this
        method instead of poking ``self._conn`` keeps the
        ``_ensure_connection_alive`` reconnect logic in the loop.
        """
        self._ensure_connection_alive()
        self._conn.commit()

    @property
    def db_type(self) -> str:
        return self._cfg.db_type

    # ── bootstrap ─────────────────────────────────────────────────────────

    @_sync
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

    @_sync
    def create_schema(self) -> None:
        """Create all monigrid_* tables if missing. Idempotent."""
        for stmt in _ddl_statements(self._cfg.db_type):
            self._execute_ddl(stmt)
        self._conn.commit()
        # Forward schema migrations for already-bootstrapped DBs whose tables
        # predate newly-added audit columns (updated_at / updated_by).
        # _lock is RLock, so calling another @_sync method from here is safe.
        self.ensure_audit_columns()

    @_sync
    def ensure_audit_columns(self) -> None:
        """Add updated_at / updated_by columns to tables that predate them.

        Idempotent — checks INFORMATION_SCHEMA / catalog views before each
        ALTER, so re-running on an already-migrated DB is a no-op.
        """
        db = self._cfg.db_type
        cur = self._cursor()
        try:
            if db == "mariadb":
                cur.execute("SELECT DATABASE()")
                row = cur.fetchone()
                schema = row[0] if row else None
                if not schema:
                    self._logger.warning(
                        "audit-migration: MariaDB session has no default database (DATABASE() is NULL); "
                        "skipping audit column check. Configure JDBC URL with a database name."
                    )
                    return

                triples = [
                    (
                        "monigrid_apis",
                        "updated_at",
                        "ALTER TABLE monigrid_apis ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
                    ),
                    (
                        "monigrid_apis",
                        "updated_by",
                        "ALTER TABLE monigrid_apis ADD COLUMN updated_by VARCHAR(128) NULL",
                    ),
                    (
                        "monigrid_monitor_targets",
                        "updated_by",
                        "ALTER TABLE monigrid_monitor_targets ADD COLUMN updated_by VARCHAR(128) NULL",
                    ),
                ]
                for table, column, alter_sql in triples:
                    cur.execute(
                        "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS"
                        " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                        [schema, table, column],
                    )
                    exists = int(cur.fetchone()[0]) > 0
                    if not exists:
                        cur.execute(alter_sql)
                        self._conn.commit()  # commit per ALTER so partial failure leaves a coherent state
                        self._logger.info("audit-migration: added %s.%s", table, column)

            elif db == "mssql":
                cur.execute("SELECT SCHEMA_NAME()")
                row = cur.fetchone()
                mssql_schema = row[0] if row else None
                if not mssql_schema:
                    self._logger.warning(
                        "audit-migration: cannot resolve MSSQL default schema; skipping audit column check"
                    )
                    return
                triples = [
                    (
                        "monigrid_apis",
                        "updated_at",
                        "ALTER TABLE monigrid_apis ADD updated_at DATETIME2 NOT NULL"
                        " CONSTRAINT df_apis_updated_at DEFAULT SYSUTCDATETIME()",
                    ),
                    (
                        "monigrid_apis",
                        "updated_by",
                        "ALTER TABLE monigrid_apis ADD updated_by NVARCHAR(128) NULL",
                    ),
                    (
                        "monigrid_monitor_targets",
                        "updated_by",
                        "ALTER TABLE monigrid_monitor_targets ADD updated_by NVARCHAR(128) NULL",
                    ),
                ]
                for table, column, alter_sql in triples:
                    qualified = f"{mssql_schema}.{table}"
                    cur.execute(
                        "SELECT COUNT(*) FROM sys.columns WHERE Name = ? AND Object_ID = OBJECT_ID(?)",
                        [column, qualified],
                    )
                    exists = int(cur.fetchone()[0]) > 0
                    if not exists:
                        cur.execute(alter_sql)
                        self._conn.commit()  # commit per ALTER so partial failure leaves a coherent state
                        self._logger.info("audit-migration: added %s.%s", table, column)

            elif db == "oracle":
                triples = [
                    (
                        "MONIGRID_APIS",
                        "UPDATED_AT",
                        "ALTER TABLE monigrid_apis ADD (updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
                    ),
                    (
                        "MONIGRID_APIS",
                        "UPDATED_BY",
                        "ALTER TABLE monigrid_apis ADD (updated_by VARCHAR2(128) NULL)",
                    ),
                    (
                        "MONIGRID_MONITOR_TARGETS",
                        "UPDATED_BY",
                        "ALTER TABLE monigrid_monitor_targets ADD (updated_by VARCHAR2(128) NULL)",
                    ),
                ]
                for table, column, alter_sql in triples:
                    cur.execute(
                        "SELECT COUNT(*) FROM USER_TAB_COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?",
                        [table, column],
                    )
                    exists = int(cur.fetchone()[0]) > 0
                    if not exists:
                        cur.execute(alter_sql)
                        self._conn.commit()  # commit per ALTER so partial failure leaves a coherent state
                        self._logger.info(
                            "audit-migration: added %s.%s",
                            table.lower(),
                            column.lower(),
                        )

        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    def _execute_ddl(self, stmt: str) -> None:
        normalized = stmt.strip()
        if not normalized:
            return
        cur = self._cursor()
        try:
            if self._cfg.db_type == "oracle":
                # Oracle lacks IF NOT EXISTS; probe user_tables / user_indexes
                # before each CREATE so re-running the DDL list is idempotent.
                table = _extract_table_name(normalized)
                if table and _oracle_table_exists(cur, table):
                    return
                index = _extract_index_name(normalized)
                if index and _oracle_index_exists(cur, index):
                    return
            cur.execute(normalized)
        finally:
            try:
                cur.close()
            except Exception:
                pass

    @_sync
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
        "dashboard_title",
        "app_company_name",
        # Phase 3: timemachine retention window (hours). 0 disables write/eviction.
        "timemachine_retention_hours",
        # Notification subsystem master switch. Stored as a JSON object
        # ({"enabled": bool}) for forward-compat (rate caps, default
        # cooldown, etc may join later). Default OFF — operators must
        # opt in explicitly so a fresh deployment never spams.
        "notification.global",
    )

    @_sync
    def save_scalar_sections(self, config_dict: dict[str, Any]) -> None:
        for section in self._KV_SECTIONS:
            if section in config_dict:
                self._upsert_kv(section, json.dumps(config_dict[section], ensure_ascii=False))
        for scalar in self._KV_SCALARS:
            if scalar in config_dict:
                self._upsert_kv(scalar, json.dumps(config_dict[scalar], ensure_ascii=False))

    @_sync
    def set_kv_scalar(self, key: str, value: Any) -> None:
        """Persist a single KV scalar (value JSON-serialised). Allowed keys
        are those declared in ``_KV_SCALARS`` — explicit allow-list to
        prevent accidental writes to other rows.
        """
        if key not in self._KV_SCALARS:
            raise ValueError(f"unknown KV scalar key: {key!r}")
        self._upsert_kv(key, json.dumps(value, ensure_ascii=False))
        self._conn.commit()

    def _upsert_kv(self, section: str, value_json: str) -> None:
        self._upsert(
            table="monigrid_settings_kv",
            key_col="section",
            key_value=section,
            values={"value": value_json},
        )

    @_sync
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

    @_sync
    def replace_connections(self, connections: Iterable[dict[str, Any]]) -> None:
        # Commit inside so a standalone caller doesn't leave the DELETE +
        # INSERTs in an open transaction. The composite paths
        # (seed_from_config / save_config_dict) issue their own final
        # commit too, but a no-op double commit is cheaper than a forgotten
        # one that strands rows in the session buffer.
        self._execute_simple("DELETE FROM monigrid_connections")
        for item in connections:
            self._insert_connection(item)
        self._conn.commit()

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

    @_sync
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

    @_sync
    def replace_apis(
        self, apis: Iterable[dict[str, Any]], *, actor: str = "",
    ) -> None:
        """Replace all rows in monigrid_apis. Preserves audit (updated_at, updated_by)
        for rows whose business content hasn't changed; stamps fresh audit values on
        new or content-changed rows.

        actor: caller's username. Empty string → updated_by stays NULL on changed rows.
        """
        new_list = list(apis)
        prior_by_id = {a["id"]: a for a in self._load_apis_no_commit()}
        self._execute_simple("DELETE FROM monigrid_apis")
        actor_val = (actor or "").strip() or None
        for item in new_list:
            prior = prior_by_id.get(item["id"])
            if prior and _api_business_equal(prior, item):
                # 내용 미변경 — prior audit 보존
                self._insert_api_with_audit(
                    item,
                    updated_at_iso=prior.get("updated_at"),
                    updated_by=prior.get("updated_by"),
                )
            else:
                # 신규 또는 변경 — 현재 시각 + actor 로 stamp
                self._insert_api_with_audit(
                    item,
                    updated_at_iso=None,
                    updated_by=actor_val,
                )
        self._conn.commit()

    def _load_apis_no_commit(self) -> list[dict[str, Any]]:
        """Same SELECT as load_apis but without @_sync (caller already locked)."""
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, title, rest_api_path, connection_id, sql_id, enabled, "
                "refresh_interval_sec, query_timeout_sec, updated_at, updated_by "
                "FROM monigrid_apis"
            )
            rows = cur.fetchall()
        finally:
            try: cur.close()
            except Exception: pass
        return [
            {
                "id": row[0], "title": row[1], "rest_api_path": row[2],
                "connection_id": row[3], "sql_id": row[4], "enabled": bool(row[5]),
                "refresh_interval_sec": int(row[6]), "query_timeout_sec": int(row[7]),
                "updated_at": _to_utc_iso8601(row[8]),
                "updated_by": row[9] if row[9] else None,
            }
            for row in rows
        ]

    def _insert_api_with_audit(
        self,
        item: dict[str, Any],
        *,
        updated_at_iso: str | None,
        updated_by: str | None,
    ) -> None:
        cur = self._cursor()
        try:
            if updated_at_iso:
                # Convert ISO8601 'Z' string to 'YYYY-MM-DD HH:MM:SS' (naive UTC)
                # string for JayDeBeApi — MariaDB/MSSQL/Oracle all accept this literal.
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(updated_at_iso.replace("Z", "+00:00"))
                naive_utc = dt.astimezone(timezone.utc).replace(tzinfo=None)
                ts_str = naive_utc.strftime("%Y-%m-%d %H:%M:%S")
                cur.execute(
                    "INSERT INTO monigrid_apis "
                    "(id, title, rest_api_path, connection_id, sql_id, enabled, "
                    " refresh_interval_sec, query_timeout_sec, updated_at, updated_by) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        str(item["id"]),
                        item.get("title") or str(item["id"]),
                        str(item["rest_api_path"]),
                        str(item["connection_id"]),
                        str(item["sql_id"]),
                        1 if item.get("enabled", True) else 0,
                        int(item.get("refresh_interval_sec") or 5),
                        int(item.get("query_timeout_sec") or 30),
                        ts_str,
                        updated_by,
                    ],
                )
            else:
                # DB DEFAULT CURRENT_TIMESTAMP populates updated_at; omit from INSERT.
                cur.execute(
                    "INSERT INTO monigrid_apis "
                    "(id, title, rest_api_path, connection_id, sql_id, enabled, "
                    " refresh_interval_sec, query_timeout_sec, updated_by) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        str(item["id"]),
                        item.get("title") or str(item["id"]),
                        str(item["rest_api_path"]),
                        str(item["connection_id"]),
                        str(item["sql_id"]),
                        1 if item.get("enabled", True) else 0,
                        int(item.get("refresh_interval_sec") or 5),
                        int(item.get("query_timeout_sec") or 30),
                        updated_by,
                    ],
                )
        finally:
            try: cur.close()
            except Exception: pass

    @_sync
    def load_apis(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, title, rest_api_path, connection_id, sql_id, enabled, "
                "refresh_interval_sec, query_timeout_sec, updated_at, updated_by "
                "FROM monigrid_apis"
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
                "updated_at": _to_utc_iso8601(row[8]),
                "updated_by": row[9] if row[9] else None,
            }
            for row in rows
        ]

    # ── SQL queries ───────────────────────────────────────────────────────

    @_sync
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

    @_sync
    def upsert_sql(self, sql_id: str, content: str) -> None:
        self._upsert(
            table="monigrid_sql_queries",
            key_col="sql_id",
            key_value=sql_id,
            values={"content": content},
            also_set_updated_at=True,
        )

    @_sync
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

    @_sync
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

    @_sync
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
    _MONITOR_TARGET_TYPES = ("server_resource", "network", "http_status")

    # 서버 리소스 알람 임계치(%) — 운영자가 등록 시 미지정하면 이 값으로 채운다.
    # 클라이언트는 spec.criteria 를 단일 출처로 삼아 위젯에서 알람을 평가한다.
    _DEFAULT_SERVER_RESOURCE_CRITERIA = {"cpu": 90, "memory": 85, "disk": 90}
    _CRITERIA_KEYS = ("cpu", "memory", "disk")

    @classmethod
    def _normalize_server_resource_criteria(cls, raw: Any) -> dict[str, int]:
        """Validate criteria dict and clamp values to [1, 100].

        Returns the full {cpu, memory, disk} dict so persisted spec is
        self-describing (no implicit defaults at read time). Raises
        ValueError for clearly bad values so the route returns HTTP 400.
        """
        normalized = dict(cls._DEFAULT_SERVER_RESOURCE_CRITERIA)
        if raw is None:
            return normalized
        if not isinstance(raw, dict):
            raise ValueError("spec.criteria must be an object")
        for key in cls._CRITERIA_KEYS:
            if key not in raw or raw[key] is None or raw[key] == "":
                continue
            try:
                value = int(raw[key])
            except (TypeError, ValueError):
                raise ValueError(
                    f"spec.criteria.{key} must be an integer between 1 and 100"
                )
            if value < 1 or value > 100:
                raise ValueError(
                    f"spec.criteria.{key} must be between 1 and 100, got {value}"
                )
            normalized[key] = value
        return normalized

    @_sync
    def list_monitor_targets(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, type, label, spec, interval_sec, enabled, updated_at, updated_by "
                "FROM monigrid_monitor_targets"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [_row_to_monitor_target(row) for row in rows]

    @_sync
    def get_monitor_target(self, target_id: str) -> dict[str, Any] | None:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, type, label, spec, interval_sec, enabled, updated_at, updated_by "
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

    @_sync
    def upsert_monitor_target(self, item: dict[str, Any], *, actor: str = "") -> dict[str, Any]:
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
        # server_resource 는 알람 임계치(criteria)를 spec 안에 함께 저장한다.
        # 다른 type 에는 criteria 가 없으므로 이 정규화를 적용하지 않는다.
        if target_type == "server_resource":
            spec = {
                **spec,
                "criteria": self._normalize_server_resource_criteria(
                    spec.get("criteria"),
                ),
            }
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
            actor=actor,
        )
        self._conn.commit()
        stored = self.get_monitor_target(target_id)
        assert stored is not None
        return stored

    @_sync
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

    # ── batch monitor target write ────────────────────────────────────────
    #
    # Helpers (no @_sync — called from an already-locked context):

    _MONITOR_TARGET_COLS = frozenset(
        {"id", "type", "label", "spec", "interval_sec", "enabled"}
    )

    def _prepare_monitor_target_fields(
        self, item: dict[str, Any]
    ) -> tuple[str, str | None, str, int, int]:
        """Validate + normalise a monitor-target payload.

        Returns (target_type, label, spec_json, interval_sec, enabled_int).
        Raises ValueError on invalid input.
        """
        target_type = str(item.get("type") or "").strip().lower()
        if target_type not in self._MONITOR_TARGET_TYPES:
            raise ValueError(
                f"monitor target type must be one of {self._MONITOR_TARGET_TYPES}, "
                f"got {target_type!r}"
            )
        spec = item.get("spec")
        if not isinstance(spec, dict):
            raise ValueError("monitor target spec must be an object")
        if target_type == "server_resource":
            spec = {
                **spec,
                "criteria": self._normalize_server_resource_criteria(
                    spec.get("criteria"),
                ),
            }
        label = str(item.get("label") or "").strip() or None
        interval_sec = max(1, int(item.get("interval_sec") or 30))
        enabled = 1 if item.get("enabled", True) else 0
        spec_json = json.dumps(spec, ensure_ascii=False)
        return target_type, label, spec_json, interval_sec, enabled

    def _fetch_monitor_target_no_commit(self, target_id: str) -> dict[str, Any] | None:
        """SELECT a single monitor target row (no commit, caller holds lock)."""
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, type, label, spec, interval_sec, enabled, updated_at, updated_by "
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

    def _insert_monitor_target_no_commit(
        self, item: dict[str, Any], *, actor: str = "",
    ) -> dict[str, Any]:
        """INSERT a new monitor-target row; generate a fresh UUID for the id.

        Does NOT commit.  Returns the inserted row dict (with generated id).
        Raises ValueError on invalid payload.
        """
        # Keep only known DB columns; drops FE-only internal fields
        # (e.g. _isNew, _isDeleted, _clientId) and any future unknowns.
        clean = {k: v for k, v in item.items() if k in self._MONITOR_TARGET_COLS}

        new_id = str(uuid.uuid4())
        target_type, label, spec_json, interval_sec, enabled = (
            self._prepare_monitor_target_fields(clean)
        )

        self._upsert(
            table="monigrid_monitor_targets",
            key_col="id",
            key_value=new_id,
            values={
                "type": target_type,
                "label": label,
                "spec": spec_json,
                "interval_sec": interval_sec,
                "enabled": enabled,
            },
            also_set_updated_at=True,
            actor=actor,
        )
        stored = self._fetch_monitor_target_no_commit(new_id)
        assert stored is not None
        return stored

    def _update_monitor_target_no_commit(
        self, target_id: str, item: dict[str, Any], *, actor: str = "",
    ) -> dict[str, Any] | None:
        """UPDATE an existing monitor-target row.

        Does NOT commit.  Returns the updated row dict, or None if the row
        did not exist (rowcount == 0 after upsert — treated as not-found).
        Raises ValueError on invalid payload.
        """
        # Keep only known DB columns; drops FE-only internal fields
        # (e.g. _isNew, _isDeleted, _clientId) and any future unknowns.
        clean = {k: v for k, v in item.items() if k in self._MONITOR_TARGET_COLS}

        target_type, label, spec_json, interval_sec, enabled = (
            self._prepare_monitor_target_fields(clean)
        )

        actor_val = (actor or "").strip() or None

        # Use a plain UPDATE so we get an accurate "not found" signal via
        # rowcount, rather than silently inserting via the upsert helper.
        # updated_at uses the same dialect-aware expression as _upsert.
        ts_expr = self._now_literal()
        cur = self._cursor()
        try:
            cur.execute(
                "UPDATE monigrid_monitor_targets "
                f"SET type = ?, label = ?, spec = ?, interval_sec = ?, enabled = ?, "
                f"updated_at = {ts_expr}, updated_by = ? "
                "WHERE id = ?",
                [target_type, label, spec_json, interval_sec, enabled, actor_val, target_id],
            )
            rowcount = cur.rowcount if cur.rowcount is not None else -1
        finally:
            try:
                cur.close()
            except Exception:
                pass

        if rowcount == 0:
            return None
        return self._fetch_monitor_target_no_commit(target_id)

    def _delete_monitor_target_no_commit(self, target_id: str) -> int:
        """DELETE a monitor-target row.  Does NOT commit.  Returns rowcount."""
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_monitor_targets WHERE id = ?",
                [target_id],
            )
            rowcount = cur.rowcount if cur.rowcount is not None else -1
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return rowcount

    @_sync
    def apply_monitor_targets_batch(
        self,
        *,
        creates: list[dict],
        updates: list[dict],
        deletes: list[str],
        actor: str = "",
    ) -> dict:
        """Atomic batch CRUD on monigrid_monitor_targets.

        Applies creates → updates → deletes in a single transaction.
        On any failure the whole transaction is rolled back and a structured
        error dict is returned.  On full success the transaction is committed.

        Returns on success:
            {"success": True, "results": {"created": [...], "updated": [...], "deleted": [...]}}

        Returns on failure (after rollback):
            {"success": False, "error": str, "failedItem": {"kind": ..., "index": ...,
             "id": ..., "message": ...}}
        """
        # ── pre-validation: reject ID overlap between updates and deletes ──
        update_ids = {str(u.get("id") or "").strip() for u in updates if u.get("id")}
        delete_set = {str(d).strip() for d in deletes if str(d).strip()}
        overlap = update_ids & delete_set
        if overlap:
            overlap_id = next(iter(overlap))
            return {
                "success": False,
                "error": f"id {overlap_id!r} appears in both updates and deletes",
                "failedItem": {
                    "kind": "delete",
                    "index": next(
                        i for i, d in enumerate(deletes) if str(d).strip() == overlap_id
                    ),
                    "id": overlap_id,
                    "message": f"id {overlap_id!r} cannot be updated and deleted in the same batch",
                },
            }

        created_rows: list[dict] = []
        updated_rows: list[dict] = []
        deleted_ids: list[str] = []

        try:
            # ── creates ───────────────────────────────────────────────────
            for idx, item in enumerate(creates):
                try:
                    row = self._insert_monitor_target_no_commit(item, actor=actor)
                    created_rows.append(row)
                except Exception as exc:
                    self._conn.rollback()
                    msg = str(exc)
                    self._logger.warning(
                        "apply_monitor_targets_batch: create[%d] failed — rolled back: %s",
                        idx, msg,
                    )
                    return {
                        "success": False,
                        "error": msg,
                        "failedItem": {
                            "kind": "create",
                            "index": idx,
                            "id": None,
                            "message": msg,
                        },
                    }

            # ── updates ───────────────────────────────────────────────────
            for idx, item in enumerate(updates):
                target_id = str(item.get("id") or "").strip()
                try:
                    row = self._update_monitor_target_no_commit(target_id, item, actor=actor)
                    if row is None:
                        raise ValueError(
                            f"monitor target id={target_id!r} not found"
                        )
                    updated_rows.append(row)
                except Exception as exc:
                    self._conn.rollback()
                    msg = str(exc)
                    self._logger.warning(
                        "apply_monitor_targets_batch: update[%d] id=%s failed — rolled back: %s",
                        idx, target_id, msg,
                    )
                    return {
                        "success": False,
                        "error": msg,
                        "failedItem": {
                            "kind": "update",
                            "index": idx,
                            "id": target_id or None,
                            "message": msg,
                        },
                    }

            # ── deletes ───────────────────────────────────────────────────
            for idx, raw_id in enumerate(deletes):
                target_id = str(raw_id).strip()
                try:
                    count = self._delete_monitor_target_no_commit(target_id)
                    if count == 0:
                        self._conn.rollback()
                        return {
                            "success": False,
                            "error": f"monitor target id={target_id!r} not found",
                            "failedItem": {
                                "kind": "delete",
                                "index": idx,
                                "id": target_id,
                                "message": f"target {target_id!r} not found",
                            },
                        }
                    deleted_ids.append(target_id)
                except Exception as exc:
                    self._conn.rollback()
                    msg = str(exc)
                    self._logger.warning(
                        "apply_monitor_targets_batch: delete[%d] id=%s failed — rolled back: %s",
                        idx, target_id, msg,
                    )
                    return {
                        "success": False,
                        "error": msg,
                        "failedItem": {
                            "kind": "delete",
                            "index": idx,
                            "id": target_id or None,
                            "message": msg,
                        },
                    }

            # ── all ops succeeded — commit ─────────────────────────────
            self._conn.commit()
            self._logger.info(
                "apply_monitor_targets_batch: committed creates=%d updates=%d deletes=%d",
                len(created_rows), len(updated_rows), len(deleted_ids),
            )
            return {
                "success": True,
                "results": {
                    "created": created_rows,
                    "updated": updated_rows,
                    "deleted": deleted_ids,
                },
            }

        except Exception as exc:
            # Catch-all for unexpected errors (e.g. connection loss mid-batch).
            try:
                self._conn.rollback()
            except Exception:
                pass
            msg = str(exc)
            self._logger.error(
                "apply_monitor_targets_batch: unexpected error — rolled back: %s", msg,
            )
            return {
                "success": False,
                "error": msg,
                "failedItem": {
                    "kind": "unknown",  # connection-level failure; phase indeterminate
                    "index": -1,
                    "id": None,
                    "message": msg,
                },
            }

    # ── user preferences (per-user UI state) ─────────────────────────────
    #
    # One row per user; `value` is an opaque JSON blob the FE round-trips.
    # Keyed by username (lowercased) — matches the JWT `username` claim. We
    # deliberately don't enforce a schema here: widget layouts, criteria
    # overrides, column order are all FE concerns, and forcing migrations
    # on each UI change would be painful. If the stored JSON can't parse
    # we return it as-is under a `raw` key so the FE can recover.

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
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

    @_sync
    def load_config_dict(self) -> dict[str, Any]:
        """Assemble a dict identical in shape to the original config.json."""
        result: dict[str, Any] = {}
        scalars = self.load_scalar_sections()
        result.update(scalars)
        result["connections"] = self.load_connections()
        result["apis"] = self.load_apis()
        return result

    @_sync
    def save_config_dict(
        self, config_dict: dict[str, Any], *, actor: str = "",
    ) -> None:
        """Persist a full config.json-shaped dict back to the DB.

        Semantics: replace-all for connections/apis; upsert for scalar KV.
        Meant for the /dashboard/config PUT path.
        """
        self.save_scalar_sections(config_dict)
        self.replace_connections(config_dict.get("connections") or [])
        self.replace_apis(config_dict.get("apis") or [], actor=actor)
        self._conn.commit()

    # ── alert events (BE-side raise/clear transition log) ────────────────
    #
    # Phase 1: monitor target collector emits a row on every state transition
    # (OK→ALARM = "raise", ALARM→OK = "clear"). Same-state ticks do not
    # generate rows — that dedupe lives in AlertEvaluator (in-memory active
    # set), not here. This table is append-only; no UPDATE / DELETE paths.

    @_sync
    def record_alert_event(
        self,
        *,
        source_type: str,
        source_id: str,
        severity: str,
        metric: str | None = None,
        level: str | None = None,
        label: str | None = None,
        message: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """Append a single alert event row — but only when severity actually
        transitions from the prior recorded state for that (source, metric).

        사용자 요구: "동일 상태 유지일때는 기록하지 않음. 상태가 변경되었을 때
        만 기록함 (정상→알람 또는 알람→정상)". AlertEvaluator 의 in-memory
        `_active` 가 일차적으로 dedupe 하지만, BE 재시작/장애 복구로 `_active`
        가 비워지면 진행 중 알람이 새 raise 로 다시 들어가는 케이스가 있다.
        여기서 한 번 더 DB last-severity 와 비교해 transition 만 기록한다.

        created_at 은 어플리케이션 측에서 UTC 로 명시 전달한다. DB DEFAULT
        (CURRENT_TIMESTAMP / SYSUTCDATETIME) 는 dialect 마다 기준 timezone 이
        달라서 (MariaDB: 서버 로컬, MSSQL: UTC), 노드 timezone 이 다르면 정렬·
        필터가 어긋난다. UTC naive 로 통일 후 응답 단계에서 'Z' 를 붙여
        클라이언트로 내려준다.
        """
        new_severity = str(severity)
        last = self._last_alert_severity_unlocked(
            source_type=str(source_type),
            source_id=str(source_id),
            metric=metric,
        )
        if last is not None and last == new_severity:
            # 동일 상태 — INSERT skip. (정상→정상, 알람→알람 모두)
            return

        payload_json = (
            json.dumps(payload, ensure_ascii=False) if payload is not None else None
        )
        now_utc_naive = datetime.now(timezone.utc).replace(tzinfo=None)
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_alert_events "
                "(source_type, source_id, metric, severity, level, label, message, payload, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    str(source_type),
                    str(source_id),
                    metric,
                    new_severity,
                    level,
                    label,
                    message,
                    payload_json,
                    now_utc_naive,
                ],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    def _last_alert_severity_unlocked(
        self,
        *,
        source_type: str,
        source_id: str,
        metric: str | None,
    ) -> str | None:
        """Return the most recent severity for (source_type, source_id, metric).

        Called from inside ``record_alert_event`` which already holds the
        SettingsStore RLock via ``@_sync`` — so we must NOT take it again.
        Returns None if no prior row exists.

        NULL metric is matched explicitly (NULL = NULL fails in SQL).
        """
        sql = (
            "SELECT severity FROM monigrid_alert_events "
            "WHERE source_type = ? AND source_id = ? "
            "AND ((metric IS NULL AND ? IS NULL) OR metric = ?) "
        )
        if self._cfg.db_type == "mariadb":
            sql += "ORDER BY id DESC LIMIT 1"
        else:
            sql += "ORDER BY id DESC OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY"
        cur = self._cursor()
        try:
            cur.execute(sql, [source_type, source_id, metric, metric])
            row = cur.fetchone()
        except Exception:
            # 조회 실패는 dedupe 를 포기하고 INSERT 진행 — append-log 가
            # 우선이고, 중복 row 한두 개가 _record_safe 의 fallback 보다 낫다.
            return None
        finally:
            try:
                cur.close()
            except Exception:
                pass
        if row is None:
            return None
        return str(row[0]) if row[0] is not None else None

    @_sync
    def list_alert_events(
        self,
        *,
        from_ts: str | None = None,
        to_ts: str | None = None,
        source_type: str | None = None,
        source_id: str | None = None,
        severity: str | None = None,
        keyword: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        """Filtered list. Returns (rows, total_count_before_paging).

        - from_ts / to_ts: ISO-8601 strings (Z / +offset 허용); UTC 로 변환해
          created_at(UTC naive) 와 datetime 객체로 비교한다. 문자열 그대로
          넘기면 MariaDB TIMESTAMP 가 'T'/'Z' 표기를 거부할 수 있어 반드시
          datetime 으로 캐스팅한다.
        - keyword: substring match against label OR message (case-sensitive
          fallback OK — BE-side normalisation can come later).
        - limit / offset: paging. limit clamped to [1, 1000].
        """
        limit = max(1, min(int(limit), 1000))
        offset = max(0, int(offset))

        from_dt = _parse_iso_to_utc_naive(from_ts) if from_ts else None
        to_dt = _parse_iso_to_utc_naive(to_ts) if to_ts else None

        wheres: list[str] = []
        params: list[Any] = []
        if from_dt is not None:
            wheres.append("created_at >= ?")
            params.append(from_dt)
        if to_dt is not None:
            wheres.append("created_at <= ?")
            params.append(to_dt)
        if source_type:
            wheres.append("source_type = ?")
            params.append(str(source_type))
        if source_id:
            wheres.append("source_id = ?")
            params.append(str(source_id))
        if severity:
            wheres.append("severity = ?")
            params.append(str(severity))
        if keyword:
            wheres.append("(label LIKE ? OR message LIKE ?)")
            kw = f"%{keyword}%"
            params.extend([kw, kw])
        where_sql = (" WHERE " + " AND ".join(wheres)) if wheres else ""

        # ── total count (before paging) ─────────────────────────────────
        count_sql = f"SELECT COUNT(*) FROM monigrid_alert_events{where_sql}"
        cur = self._cursor()
        try:
            cur.execute(count_sql, params)
            row = cur.fetchone()
            total = int(row[0]) if row else 0
        finally:
            try:
                cur.close()
            except Exception:
                pass

        # ── paged rows ─────────────────────────────────────────────────
        # MariaDB: LIMIT n OFFSET m
        # MSSQL 2012+ / Oracle 12c+: OFFSET m ROWS FETCH NEXT n ROWS ONLY
        select_cols = (
            "id, source_type, source_id, metric, severity, level, label, "
            "message, payload, created_at"
        )
        if self._cfg.db_type == "mariadb":
            page_sql = (
                f"SELECT {select_cols} FROM monigrid_alert_events"
                f"{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
            )
            page_params = list(params) + [limit, offset]
        else:
            page_sql = (
                f"SELECT {select_cols} FROM monigrid_alert_events"
                f"{where_sql} ORDER BY created_at DESC, id DESC "
                f"OFFSET ? ROWS FETCH NEXT ? ROWS ONLY"
            )
            page_params = list(params) + [offset, limit]

        cur = self._cursor()
        try:
            cur.execute(page_sql, page_params)
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass

        out: list[dict[str, Any]] = []
        for r in rows:
            payload_text = _read_clob(r[8])
            try:
                payload_obj = json.loads(payload_text) if payload_text else None
            except json.JSONDecodeError:
                payload_obj = {"raw": payload_text}
            out.append({
                "id": int(r[0]) if r[0] is not None else None,
                "sourceType": str(r[1]) if r[1] is not None else None,
                "sourceId": str(r[2]) if r[2] is not None else None,
                "metric": str(r[3]) if r[3] is not None else None,
                "severity": str(r[4]) if r[4] is not None else None,
                "level": str(r[5]) if r[5] is not None else None,
                "label": str(r[6]) if r[6] is not None else None,
                "message": str(r[7]) if r[7] is not None else None,
                "payload": payload_obj,
                "createdAt": _to_utc_iso8601(r[9]),
            })
        return out, total

    # ── widget configs (BE-central display columns + thresholds) ─────────
    #
    # Phase 2 (Step 1): per (api_id, widget_type) JSON config row. Holds the
    # *shared* definition — display column list, alarm thresholds. Per-user
    # state (size, column order, column width) stays in user_preferences.
    #
    # Composite PK so the same data API can be visualised as both a table
    # and a chart with independent column / threshold definitions.
    _ALLOWED_WIDGET_TYPES = ("table", "line-chart", "bar-chart")

    @_sync
    def list_widget_configs(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT api_id, widget_type, config, updated_at "
                "FROM monigrid_widget_configs"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        out: list[dict[str, Any]] = []
        for r in rows:
            text = _read_clob(r[2])
            try:
                cfg = json.loads(text) if text else {}
            except json.JSONDecodeError:
                cfg = {"raw": text}
            updated = r[3]
            updated_iso = (
                updated.isoformat() if hasattr(updated, "isoformat")
                else (str(updated) if updated is not None else None)
            )
            out.append({
                "apiId": str(r[0]),
                "widgetType": str(r[1]),
                "config": cfg,
                "updatedAt": updated_iso,
            })
        return out

    @_sync
    def list_widget_configs_by_api_id(
        self, api_id: str,
    ) -> list[dict[str, Any]]:
        """Hot-path lookup for the alert evaluator: every widget_type row
        registered for one data API. Skips the json-parse round trip on
        the dial overhead path (settings DB itself is local-network)."""
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT widget_type, config FROM monigrid_widget_configs "
                "WHERE api_id = ?",
                [str(api_id)],
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        out: list[dict[str, Any]] = []
        for r in rows:
            text = _read_clob(r[1])
            try:
                cfg = json.loads(text) if text else {}
            except json.JSONDecodeError:
                cfg = {"raw": text}
            out.append({
                "widgetType": str(r[0]),
                "config": cfg,
            })
        return out

    @_sync
    def get_widget_config(
        self, api_id: str, widget_type: str,
    ) -> dict[str, Any] | None:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT config, updated_at FROM monigrid_widget_configs "
                "WHERE api_id = ? AND widget_type = ?",
                [str(api_id), str(widget_type)],
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
        try:
            cfg = json.loads(text) if text else {}
        except json.JSONDecodeError:
            cfg = {"raw": text}
        updated = row[1]
        updated_iso = (
            updated.isoformat() if hasattr(updated, "isoformat")
            else (str(updated) if updated is not None else None)
        )
        return {
            "apiId": str(api_id),
            "widgetType": str(widget_type),
            "config": cfg,
            "updatedAt": updated_iso,
        }

    @_sync
    def save_widget_config(
        self, api_id: str, widget_type: str, config: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(api_id, str) or not api_id.strip():
            raise ValueError("api_id is required")
        if widget_type not in self._ALLOWED_WIDGET_TYPES:
            raise ValueError(
                f"widget_type must be one of {self._ALLOWED_WIDGET_TYPES}"
            )
        if not isinstance(config, dict):
            raise ValueError("config must be a JSON object")

        # Soft schema validation — accept any extra keys but require the
        # two we actually consume so a typo doesn't silently disappear.
        display_columns = config.get("displayColumns")
        if display_columns is not None and not isinstance(display_columns, list):
            raise ValueError("config.displayColumns must be an array")
        thresholds = config.get("thresholds")
        if thresholds is not None and not isinstance(thresholds, list):
            raise ValueError("config.thresholds must be an array")

        config_json = json.dumps(config, ensure_ascii=False)
        db_type = self._cfg.db_type
        cur = self._cursor()
        try:
            if db_type == "mariadb":
                cur.execute(
                    "INSERT INTO monigrid_widget_configs "
                    "(api_id, widget_type, config, updated_at) "
                    "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
                    "ON DUPLICATE KEY UPDATE config = VALUES(config), "
                    "updated_at = CURRENT_TIMESTAMP",
                    [str(api_id), str(widget_type), config_json],
                )
            elif db_type == "mssql":
                cur.execute(
                    "MERGE INTO monigrid_widget_configs WITH (HOLDLOCK) AS target "
                    "USING (SELECT ? AS api_id, ? AS widget_type, ? AS src_config) AS source "
                    "ON target.api_id = source.api_id "
                    "AND target.widget_type = source.widget_type "
                    "WHEN MATCHED THEN UPDATE SET "
                    "target.config = source.src_config, "
                    "target.updated_at = SYSUTCDATETIME() "
                    "WHEN NOT MATCHED THEN INSERT "
                    "(api_id, widget_type, config, updated_at) "
                    "VALUES (source.api_id, source.widget_type, "
                    "source.src_config, SYSUTCDATETIME());",
                    [str(api_id), str(widget_type), config_json],
                )
            else:  # oracle
                cur.execute(
                    "MERGE INTO monigrid_widget_configs target "
                    "USING (SELECT ? AS api_id, ? AS widget_type, "
                    "? AS src_config FROM dual) source "
                    "ON (target.api_id = source.api_id "
                    "AND target.widget_type = source.widget_type) "
                    "WHEN MATCHED THEN UPDATE SET "
                    "target.config = source.src_config, "
                    "target.updated_at = CURRENT_TIMESTAMP "
                    "WHEN NOT MATCHED THEN INSERT "
                    "(api_id, widget_type, config, updated_at) "
                    "VALUES (source.api_id, source.widget_type, "
                    "source.src_config, CURRENT_TIMESTAMP)",
                    [str(api_id), str(widget_type), config_json],
                )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return {
            "apiId": str(api_id),
            "widgetType": str(widget_type),
            "config": config,
        }

    @_sync
    def delete_widget_config(self, api_id: str, widget_type: str) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_widget_configs "
                "WHERE api_id = ? AND widget_type = ?",
                [str(api_id), str(widget_type)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ─────────────────────────────────────────────────────────────────────
    # Notifications: channels / groups / recipients / rules / silence / queue
    # All ops go through @_sync so they share the SettingsStore RLock with
    # collector + cache + Flask workers — same posture as the rest of the
    # store. INSERTs return the new row id via _last_inserted_id so the REST
    # layer can echo a POST response back.
    # ─────────────────────────────────────────────────────────────────────

    # ── notification: channels (one row per kind) ─────────────────────────
    @_sync
    def list_notification_channels(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, kind, enabled, config_encrypted, "
                "created_at, updated_at, updated_by FROM monigrid_notification_channels "
                "ORDER BY id"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [
            {
                "id": int(r[0]),
                "kind": str(r[1]),
                "enabled": bool(r[2]),
                "configEncrypted": _read_clob(r[3]),
                "createdAt": _iso(r[4]),
                "updatedAt": _iso(r[5]),
                "updatedBy": r[6],
            }
            for r in rows
        ]

    @_sync
    def get_notification_channel(self, kind: str) -> dict[str, Any] | None:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, kind, enabled, config_encrypted, "
                "created_at, updated_at, updated_by FROM monigrid_notification_channels "
                "WHERE kind = ?",
                [str(kind)],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        if not row:
            return None
        return {
            "id": int(row[0]),
            "kind": str(row[1]),
            "enabled": bool(row[2]),
            "configEncrypted": _read_clob(row[3]),
            "createdAt": _iso(row[4]),
            "updatedAt": _iso(row[5]),
            "updatedBy": row[6],
        }

    @_sync
    def upsert_notification_channel(
        self,
        *,
        kind: str,
        enabled: bool,
        config_encrypted: str,
        actor: str = "",
    ) -> int:
        """Insert or update a channel row keyed by `kind` (which is UNIQUE)."""
        existing = self._channel_id_by_kind_unlocked(kind)
        cur = self._cursor()
        actor_norm = (actor or "").strip() or None
        try:
            if existing is None:
                cur.execute(
                    "INSERT INTO monigrid_notification_channels "
                    "(kind, enabled, config_encrypted, created_at, updated_at, updated_by) "
                    f"VALUES (?, ?, ?, {self._now_literal()}, {self._now_literal()}, ?)",
                    [str(kind), 1 if enabled else 0, config_encrypted, actor_norm],
                )
                channel_id = self._last_inserted_id(cur, "monigrid_notification_channels")
            else:
                cur.execute(
                    "UPDATE monigrid_notification_channels SET "
                    f"enabled = ?, config_encrypted = ?, {self._current_ts_expr('updated_at')}, "
                    "updated_by = ? WHERE id = ?",
                    [1 if enabled else 0, config_encrypted, actor_norm, existing],
                )
                channel_id = existing
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(channel_id) if channel_id is not None else (existing or 0)

    def _channel_id_by_kind_unlocked(self, kind: str) -> int | None:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id FROM monigrid_notification_channels WHERE kind = ?",
                [str(kind)],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return int(row[0]) if row else None

    @_sync
    def set_notification_channel_enabled(
        self, kind: str, enabled: bool, actor: str = "",
    ) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "UPDATE monigrid_notification_channels SET "
                f"enabled = ?, {self._current_ts_expr('updated_at')}, updated_by = ? "
                "WHERE kind = ?",
                [1 if enabled else 0, (actor or "").strip() or None, str(kind)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── notification: groups ──────────────────────────────────────────────
    @_sync
    def list_notification_groups(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, name, description, enabled, created_at, updated_at, updated_by "
                "FROM monigrid_notification_groups ORDER BY name"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [
            {
                "id": int(r[0]),
                "name": str(r[1]),
                "description": r[2],
                "enabled": bool(r[3]),
                "createdAt": _iso(r[4]),
                "updatedAt": _iso(r[5]),
                "updatedBy": r[6],
            }
            for r in rows
        ]

    @_sync
    def create_notification_group(
        self, *, name: str, description: str | None = None,
        enabled: bool = True, actor: str = "",
    ) -> int:
        if not (name or "").strip():
            raise ValueError("group name is required")
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_notification_groups "
                "(name, description, enabled, created_at, updated_at, updated_by) "
                f"VALUES (?, ?, ?, {self._now_literal()}, {self._now_literal()}, ?)",
                [name.strip(), description, 1 if enabled else 0,
                 (actor or "").strip() or None],
            )
            new_id = self._last_inserted_id(cur, "monigrid_notification_groups")
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(new_id) if new_id is not None else 0

    @_sync
    def update_notification_group(
        self, group_id: int, *,
        name: str | None = None,
        description: str | None = None,
        enabled: bool | None = None,
        actor: str = "",
    ) -> None:
        sets: list[str] = []
        params: list[Any] = []
        if name is not None:
            if not name.strip():
                raise ValueError("group name cannot be blank")
            sets.append("name = ?"); params.append(name.strip())
        if description is not None:
            sets.append("description = ?"); params.append(description or None)
        if enabled is not None:
            sets.append("enabled = ?"); params.append(1 if enabled else 0)
        if not sets:
            return
        sets.append(self._current_ts_expr("updated_at"))
        sets.append("updated_by = ?")
        params.append((actor or "").strip() or None)
        params.append(int(group_id))
        cur = self._cursor()
        try:
            cur.execute(
                f"UPDATE monigrid_notification_groups SET {', '.join(sets)} WHERE id = ?",
                params,
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    @_sync
    def delete_notification_group(self, group_id: int) -> None:
        # Soft constraint — if recipients/rules still reference this group,
        # caller (route layer) is expected to refuse. We still cascade-delete
        # recipients here so the group goes away cleanly.
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_notification_recipients WHERE group_id = ?",
                [int(group_id)],
            )
            cur.execute(
                "DELETE FROM monigrid_notification_groups WHERE id = ?",
                [int(group_id)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── notification: recipients ──────────────────────────────────────────
    @_sync
    def list_notification_recipients(
        self, group_id: int | None = None,
    ) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            if group_id is None:
                cur.execute(
                    "SELECT id, group_id, kind, address, display_name, enabled, created_at "
                    "FROM monigrid_notification_recipients ORDER BY group_id, id"
                )
            else:
                cur.execute(
                    "SELECT id, group_id, kind, address, display_name, enabled, created_at "
                    "FROM monigrid_notification_recipients WHERE group_id = ? ORDER BY id",
                    [int(group_id)],
                )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [
            {
                "id": int(r[0]),
                "groupId": int(r[1]),
                "kind": str(r[2]),
                "address": str(r[3]),
                "displayName": r[4],
                "enabled": bool(r[5]),
                "createdAt": _iso(r[6]),
            }
            for r in rows
        ]

    @_sync
    def create_notification_recipient(
        self, *, group_id: int, kind: str = "email",
        address: str, display_name: str | None = None, enabled: bool = True,
    ) -> int:
        addr = (address or "").strip()
        if not addr:
            raise ValueError("recipient address is required")
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_notification_recipients "
                "(group_id, kind, address, display_name, enabled, created_at) "
                f"VALUES (?, ?, ?, ?, ?, {self._now_literal()})",
                [int(group_id), str(kind or "email"), addr,
                 (display_name or "").strip() or None, 1 if enabled else 0],
            )
            new_id = self._last_inserted_id(cur, "monigrid_notification_recipients")
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(new_id) if new_id is not None else 0

    @_sync
    def update_notification_recipient(
        self, recipient_id: int, *,
        kind: str | None = None,
        address: str | None = None,
        display_name: str | None = None,
        enabled: bool | None = None,
    ) -> None:
        sets: list[str] = []
        params: list[Any] = []
        if kind is not None:
            sets.append("kind = ?"); params.append(str(kind))
        if address is not None:
            addr = (address or "").strip()
            if not addr:
                raise ValueError("recipient address cannot be blank")
            sets.append("address = ?"); params.append(addr)
        if display_name is not None:
            sets.append("display_name = ?"); params.append((display_name or "").strip() or None)
        if enabled is not None:
            sets.append("enabled = ?"); params.append(1 if enabled else 0)
        if not sets:
            return
        params.append(int(recipient_id))
        cur = self._cursor()
        try:
            cur.execute(
                f"UPDATE monigrid_notification_recipients SET {', '.join(sets)} WHERE id = ?",
                params,
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    @_sync
    def delete_notification_recipient(self, recipient_id: int) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_notification_recipients WHERE id = ?",
                [int(recipient_id)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── notification: rules ───────────────────────────────────────────────
    _RULE_COLS = (
        "id, name, enabled, source_type, source_id_pattern, metric_pattern, "
        "min_level, recipient_group_id, channel_id, cooldown_sec, "
        "digest_window_sec, send_on_clear, created_at, created_by, "
        "updated_at, updated_by"
    )

    def _row_to_rule(self, r: tuple) -> dict[str, Any]:
        return {
            "id": int(r[0]),
            "name": str(r[1]),
            "enabled": bool(r[2]),
            "sourceType": r[3],
            "sourceIdPattern": r[4],
            "metricPattern": r[5],
            "minLevel": str(r[6] or "warn"),
            "recipientGroupId": int(r[7]),
            "channelId": int(r[8]),
            "cooldownSec": int(r[9] or 0),
            "digestWindowSec": int(r[10] or 0),
            "sendOnClear": bool(r[11]),
            "createdAt": _iso(r[12]),
            "createdBy": r[13],
            "updatedAt": _iso(r[14]),
            "updatedBy": r[15],
        }

    @_sync
    def list_notification_rules(self, *, only_enabled: bool = False) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            sql = f"SELECT {self._RULE_COLS} FROM monigrid_notification_rules"
            if only_enabled:
                sql += " WHERE enabled = 1"
            sql += " ORDER BY id"
            cur.execute(sql)
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [self._row_to_rule(r) for r in rows]

    @_sync
    def get_notification_rule(self, rule_id: int) -> dict[str, Any] | None:
        cur = self._cursor()
        try:
            cur.execute(
                f"SELECT {self._RULE_COLS} FROM monigrid_notification_rules WHERE id = ?",
                [int(rule_id)],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return self._row_to_rule(row) if row else None

    @_sync
    def create_notification_rule(
        self, *, name: str,
        recipient_group_id: int, channel_id: int,
        source_type: str | None = None,
        source_id_pattern: str | None = None,
        metric_pattern: str | None = None,
        min_level: str = "warn",
        cooldown_sec: int = 300,
        digest_window_sec: int = 0,
        send_on_clear: bool = False,
        enabled: bool = True,
        actor: str = "",
    ) -> int:
        if not (name or "").strip():
            raise ValueError("rule name is required")
        if min_level not in ("warn", "critical"):
            raise ValueError("min_level must be 'warn' or 'critical'")
        actor_norm = (actor or "").strip() or None
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_notification_rules "
                "(name, enabled, source_type, source_id_pattern, metric_pattern, "
                "min_level, recipient_group_id, channel_id, cooldown_sec, "
                "digest_window_sec, send_on_clear, created_at, created_by, "
                "updated_at, updated_by) "
                f"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                f"{self._now_literal()}, ?, {self._now_literal()}, ?)",
                [name.strip(), 1 if enabled else 0,
                 source_type, source_id_pattern, metric_pattern,
                 min_level, int(recipient_group_id), int(channel_id),
                 int(cooldown_sec), int(digest_window_sec),
                 1 if send_on_clear else 0,
                 actor_norm, actor_norm],
            )
            new_id = self._last_inserted_id(cur, "monigrid_notification_rules")
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(new_id) if new_id is not None else 0

    @_sync
    def update_notification_rule(
        self, rule_id: int, *,
        name: str | None = None,
        enabled: bool | None = None,
        source_type: str | None = None,
        source_id_pattern: str | None = None,
        metric_pattern: str | None = None,
        min_level: str | None = None,
        recipient_group_id: int | None = None,
        channel_id: int | None = None,
        cooldown_sec: int | None = None,
        digest_window_sec: int | None = None,
        send_on_clear: bool | None = None,
        actor: str = "",
    ) -> None:
        sets: list[str] = []
        params: list[Any] = []
        if name is not None:
            if not name.strip():
                raise ValueError("rule name cannot be blank")
            sets.append("name = ?"); params.append(name.strip())
        if enabled is not None:
            sets.append("enabled = ?"); params.append(1 if enabled else 0)
        for col, val in (
            ("source_type", source_type),
            ("source_id_pattern", source_id_pattern),
            ("metric_pattern", metric_pattern),
        ):
            if val is not None:
                sets.append(f"{col} = ?"); params.append(val or None)
        if min_level is not None:
            if min_level not in ("warn", "critical"):
                raise ValueError("min_level must be 'warn' or 'critical'")
            sets.append("min_level = ?"); params.append(min_level)
        for col, val in (
            ("recipient_group_id", recipient_group_id),
            ("channel_id", channel_id),
            ("cooldown_sec", cooldown_sec),
            ("digest_window_sec", digest_window_sec),
        ):
            if val is not None:
                sets.append(f"{col} = ?"); params.append(int(val))
        if send_on_clear is not None:
            sets.append("send_on_clear = ?"); params.append(1 if send_on_clear else 0)
        if not sets:
            return
        sets.append(self._current_ts_expr("updated_at"))
        sets.append("updated_by = ?")
        params.append((actor or "").strip() or None)
        params.append(int(rule_id))
        cur = self._cursor()
        try:
            cur.execute(
                f"UPDATE monigrid_notification_rules SET {', '.join(sets)} WHERE id = ?",
                params,
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    @_sync
    def delete_notification_rule(self, rule_id: int) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_notification_rules WHERE id = ?",
                [int(rule_id)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── notification: silence rules ───────────────────────────────────────
    @_sync
    def list_silence_rules(self) -> list[dict[str, Any]]:
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, name, source_type, source_id_pattern, metric_pattern, "
                "starts_at, ends_at, reason, created_at, created_by "
                "FROM monigrid_silence_rules ORDER BY starts_at DESC, id DESC"
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [
            {
                "id": int(r[0]),
                "name": str(r[1]),
                "sourceType": r[2],
                "sourceIdPattern": r[3],
                "metricPattern": r[4],
                "startsAt": _iso(r[5]),
                "endsAt": _iso(r[6]),
                "reason": r[7],
                "createdAt": _iso(r[8]),
                "createdBy": r[9],
            }
            for r in rows
        ]

    @_sync
    def list_active_silence_rules(
        self, *, at_utc: datetime | None = None,
    ) -> list[dict[str, Any]]:
        ref = (at_utc or datetime.now(timezone.utc)).replace(tzinfo=None)
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT id, name, source_type, source_id_pattern, metric_pattern, "
                "starts_at, ends_at, reason "
                "FROM monigrid_silence_rules WHERE starts_at <= ? AND ends_at >= ?",
                [ref, ref],
            )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return [
            {
                "id": int(r[0]),
                "name": str(r[1]),
                "sourceType": r[2],
                "sourceIdPattern": r[3],
                "metricPattern": r[4],
                "startsAt": _iso(r[5]),
                "endsAt": _iso(r[6]),
                "reason": r[7],
            }
            for r in rows
        ]

    @_sync
    def create_silence_rule(
        self, *, name: str,
        starts_at: datetime, ends_at: datetime,
        source_type: str | None = None,
        source_id_pattern: str | None = None,
        metric_pattern: str | None = None,
        reason: str | None = None,
        actor: str = "",
    ) -> int:
        if not (name or "").strip():
            raise ValueError("silence name is required")
        if ends_at <= starts_at:
            raise ValueError("silence ends_at must be after starts_at")
        starts_naive = starts_at.astimezone(timezone.utc).replace(tzinfo=None) \
            if starts_at.tzinfo else starts_at
        ends_naive = ends_at.astimezone(timezone.utc).replace(tzinfo=None) \
            if ends_at.tzinfo else ends_at
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_silence_rules "
                "(name, source_type, source_id_pattern, metric_pattern, "
                "starts_at, ends_at, reason, created_at, created_by) "
                f"VALUES (?, ?, ?, ?, ?, ?, ?, {self._now_literal()}, ?)",
                [name.strip(), source_type, source_id_pattern, metric_pattern,
                 starts_naive, ends_naive, reason,
                 (actor or "").strip() or None],
            )
            new_id = self._last_inserted_id(cur, "monigrid_silence_rules")
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(new_id) if new_id is not None else 0

    @_sync
    def delete_silence_rule(self, silence_id: int) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                "DELETE FROM monigrid_silence_rules WHERE id = ?",
                [int(silence_id)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    # ── notification: queue ───────────────────────────────────────────────
    _QUEUE_COLS = (
        "id, alert_event_id, rule_id, channel_id, recipient_address, "
        "subject, body_html, body_text, status, attempt, "
        "next_attempt_at, last_error, created_at, sent_at"
    )

    def _row_to_queue_item(self, r: tuple) -> dict[str, Any]:
        return {
            "id": int(r[0]),
            "alertEventId": int(r[1]) if r[1] is not None else None,
            "ruleId": int(r[2]) if r[2] is not None else None,
            "channelId": int(r[3]),
            "recipientAddress": str(r[4]),
            "subject": str(r[5]),
            "bodyHtml": _read_clob(r[6]),
            "bodyText": _read_clob(r[7]),
            "status": str(r[8]),
            "attempt": int(r[9] or 0),
            "nextAttemptAt": _iso(r[10]),
            "lastError": _read_clob(r[11]),
            "createdAt": _iso(r[12]),
            "sentAt": _iso(r[13]),
        }

    @_sync
    def enqueue_notification(
        self, *, channel_id: int,
        recipient_address: str, subject: str,
        body_html: str = "", body_text: str = "",
        alert_event_id: int | None = None,
        rule_id: int | None = None,
        next_attempt_at: datetime | None = None,
    ) -> int:
        if not recipient_address.strip():
            raise ValueError("recipient_address is required")
        nxt = None
        if next_attempt_at is not None:
            nxt = next_attempt_at.astimezone(timezone.utc).replace(tzinfo=None) \
                if next_attempt_at.tzinfo else next_attempt_at
        cur = self._cursor()
        try:
            cur.execute(
                "INSERT INTO monigrid_notification_queue "
                "(alert_event_id, rule_id, channel_id, recipient_address, "
                "subject, body_html, body_text, status, attempt, "
                "next_attempt_at, created_at) "
                f"VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, {self._now_literal()})",
                [alert_event_id, rule_id, int(channel_id),
                 recipient_address.strip(), subject, body_html, body_text, nxt],
            )
            new_id = self._last_inserted_id(cur, "monigrid_notification_queue")
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(new_id) if new_id is not None else 0

    @_sync
    def claim_pending_notifications(
        self, *, limit: int = 50,
        now_utc: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """Fetch up to `limit` pending rows whose next_attempt_at is due.

        We don't take an explicit row-lock — the SettingsStore RLock + worker
        single-threaded poll is enough today (one worker process). If we ever
        run two workers, switch to UPDATE ... WHERE status='pending' RETURNING
        or a SELECT FOR UPDATE.
        """
        ref = (now_utc or datetime.now(timezone.utc)).replace(tzinfo=None)
        cur = self._cursor()
        try:
            db = self._cfg.db_type
            base = (
                f"SELECT {self._QUEUE_COLS} FROM monigrid_notification_queue "
                "WHERE status = 'pending' "
                "AND (next_attempt_at IS NULL OR next_attempt_at <= ?) "
                "ORDER BY id"
            )
            if db == "mariadb":
                cur.execute(base + " LIMIT ?", [ref, int(limit)])
            elif db == "mssql":
                cur.execute(
                    base + " OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY",
                    [ref, int(limit)],
                )
            else:  # oracle
                cur.execute(
                    base + " FETCH FIRST ? ROWS ONLY",
                    [ref, int(limit)],
                )
            rows = cur.fetchall()
            ids = [int(r[0]) for r in rows]
            if ids:
                placeholders = ",".join(["?"] * len(ids))
                cur.execute(
                    f"UPDATE monigrid_notification_queue SET status = 'sending' "
                    f"WHERE id IN ({placeholders})",
                    ids,
                )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return [self._row_to_queue_item(r) for r in rows]

    @_sync
    def mark_notification_sent(self, queue_id: int) -> None:
        cur = self._cursor()
        try:
            cur.execute(
                f"UPDATE monigrid_notification_queue SET status = 'sent', "
                f"sent_at = {self._now_literal()}, last_error = NULL "
                "WHERE id = ?",
                [int(queue_id)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    @_sync
    def mark_notification_failed(
        self, queue_id: int, *,
        error: str,
        next_attempt_at: datetime | None = None,
        mark_dead: bool = False,
    ) -> None:
        nxt = None
        if next_attempt_at is not None:
            nxt = next_attempt_at.astimezone(timezone.utc).replace(tzinfo=None) \
                if next_attempt_at.tzinfo else next_attempt_at
        new_status = "dead" if mark_dead else "pending"
        cur = self._cursor()
        try:
            cur.execute(
                "UPDATE monigrid_notification_queue SET status = ?, "
                "attempt = attempt + 1, last_error = ?, next_attempt_at = ? "
                "WHERE id = ?",
                [new_status, (error or "")[:2000], nxt, int(queue_id)],
            )
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()

    @_sync
    def list_notification_queue(
        self, *,
        status: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> dict[str, Any]:
        params: list[Any] = []
        where = ""
        if status:
            where = " WHERE status = ?"
            params.append(str(status))
        cur = self._cursor()
        try:
            cur.execute(
                f"SELECT COUNT(*) FROM monigrid_notification_queue{where}",
                params,
            )
            total = int(cur.fetchone()[0])
            db = self._cfg.db_type
            base = (
                f"SELECT {self._QUEUE_COLS} FROM monigrid_notification_queue"
                f"{where} ORDER BY id DESC"
            )
            if db == "mariadb":
                cur.execute(base + " LIMIT ? OFFSET ?", params + [int(limit), int(offset)])
            else:
                cur.execute(
                    base + " OFFSET ? ROWS FETCH NEXT ? ROWS ONLY",
                    params + [int(offset), int(limit)],
                )
            rows = cur.fetchall()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return {
            "items": [self._row_to_queue_item(r) for r in rows],
            "totalCount": total,
            "limit": int(limit),
            "offset": int(offset),
        }

    @_sync
    def retry_notification_queue_item(self, queue_id: int) -> bool:
        cur = self._cursor()
        try:
            cur.execute(
                "UPDATE monigrid_notification_queue SET status = 'pending', "
                "attempt = 0, next_attempt_at = NULL, last_error = NULL "
                "WHERE id = ? AND status IN ('failed', 'dead')",
                [int(queue_id)],
            )
            updated = getattr(cur, "rowcount", 0) or 0
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(updated) > 0

    @_sync
    def cancel_notification_queue_item(self, queue_id: int) -> bool:
        cur = self._cursor()
        try:
            cur.execute(
                "UPDATE monigrid_notification_queue SET status = 'cancelled' "
                "WHERE id = ? AND status IN ('pending', 'failed')",
                [int(queue_id)],
            )
            updated = getattr(cur, "rowcount", 0) or 0
        finally:
            try:
                cur.close()
            except Exception:
                pass
        self._conn.commit()
        return int(updated) > 0

    @_sync
    def count_dead_notifications_in_window(
        self, *, window_seconds: int = 86400,
    ) -> int:
        ref = (datetime.now(timezone.utc)
               - timedelta(seconds=int(window_seconds))).replace(tzinfo=None)
        cur = self._cursor()
        try:
            cur.execute(
                "SELECT COUNT(*) FROM monigrid_notification_queue "
                "WHERE status = 'dead' AND created_at >= ?",
                [ref],
            )
            row = cur.fetchone()
        finally:
            try:
                cur.close()
            except Exception:
                pass
        return int(row[0]) if row else 0

    # ── internals: generic upsert ─────────────────────────────────────────

    def _upsert(
        self,
        *,
        table: str,
        key_col: str,
        key_value: str,
        values: dict[str, Any],
        also_set_updated_at: bool = False,
        actor: str = "",
    ) -> None:
        """Cross-dialect single-statement upsert.

        The previous implementation did SELECT-then-INSERT-or-UPDATE in two
        round-trips, which left a TOCTOU window: between the SELECT and the
        write, a peer A-A node could insert/delete the same key and one of
        the two writes would fail (lost update or duplicate-key error). All
        three target dialects support a native single-statement upsert, so
        we use those instead — last-write-wins is the same semantic but
        without the race window or extra round-trip.
        """
        final_values = dict(values)
        if actor and "updated_by" not in final_values:
            normalized = actor.strip()
            final_values["updated_by"] = normalized if normalized else None
        db_type = self._cfg.db_type
        cur = self._cursor()
        try:
            if db_type == "mariadb":
                self._upsert_mariadb(cur, table, key_col, key_value, final_values, also_set_updated_at)
            elif db_type == "mssql":
                self._upsert_mssql(cur, table, key_col, key_value, final_values, also_set_updated_at)
            else:
                # Oracle (default) — MERGE with a dual-source row
                self._upsert_oracle(cur, table, key_col, key_value, final_values, also_set_updated_at)
        finally:
            try:
                cur.close()
            except Exception:
                pass

    @staticmethod
    def _upsert_mariadb(
        cur, table: str, key_col: str, key_value: str,
        values: dict[str, Any], also_set_updated_at: bool,
    ) -> None:
        cols = [key_col, *values.keys()]
        placeholders = ["?"] * len(cols)
        params: list[Any] = [key_value, *values.values()]
        if also_set_updated_at:
            cols.append("updated_at")
            placeholders.append("CURRENT_TIMESTAMP")
        update_parts = [f"{c} = VALUES({c})" for c in values.keys()]
        if also_set_updated_at:
            update_parts.append("updated_at = CURRENT_TIMESTAMP")
        sql = (
            f"INSERT INTO {table} ({', '.join(cols)}) "
            f"VALUES ({', '.join(placeholders)}) "
            f"ON DUPLICATE KEY UPDATE {', '.join(update_parts)}"
        )
        cur.execute(sql, params)

    @staticmethod
    def _upsert_mssql(
        cur, table: str, key_col: str, key_value: str,
        values: dict[str, Any], also_set_updated_at: bool,
    ) -> None:
        # WITH (HOLDLOCK) is required for safe MERGE under concurrent writes.
        # Without it MERGE can race and produce primary-key violations.
        update_parts = [f"target.{c} = ?" for c in values.keys()]
        if also_set_updated_at:
            update_parts.append("target.updated_at = SYSUTCDATETIME()")
        insert_cols = [key_col, *values.keys()]
        insert_vals = [f"source.{key_col}"] + [f"src_{c}" for c in values.keys()]
        if also_set_updated_at:
            insert_cols.append("updated_at")
            insert_vals.append("SYSUTCDATETIME()")
        source_cols = [f"? AS {key_col}"] + [f"? AS src_{c}" for c in values.keys()]
        sql = (
            f"MERGE INTO {table} WITH (HOLDLOCK) AS target "
            f"USING (SELECT {', '.join(source_cols)}) AS source "
            f"ON target.{key_col} = source.{key_col} "
            f"WHEN MATCHED THEN UPDATE SET {', '.join(update_parts)} "
            f"WHEN NOT MATCHED THEN INSERT ({', '.join(insert_cols)}) "
            f"VALUES ({', '.join(insert_vals)});"
        )
        # Params order: source row (key + each value), then UPDATE SET values.
        # MSSQL drivers bind by position, so we list all source params first
        # (used by both branches via aliases) then UPDATE SET params.
        source_params = [key_value, *values.values()]
        update_params = list(values.values())
        cur.execute(sql, source_params + update_params)

    @staticmethod
    def _upsert_oracle(
        cur, table: str, key_col: str, key_value: str,
        values: dict[str, Any], also_set_updated_at: bool,
    ) -> None:
        update_parts = [f"target.{c} = source.src_{c}" for c in values.keys()]
        if also_set_updated_at:
            update_parts.append("target.updated_at = CURRENT_TIMESTAMP")
        insert_cols = [key_col, *values.keys()]
        insert_vals = [f"source.{key_col}"] + [f"source.src_{c}" for c in values.keys()]
        if also_set_updated_at:
            insert_cols.append("updated_at")
            insert_vals.append("CURRENT_TIMESTAMP")
        source_cols = [f"? AS {key_col}"] + [f"? AS src_{c}" for c in values.keys()]
        sql = (
            f"MERGE INTO {table} target "
            f"USING (SELECT {', '.join(source_cols)} FROM dual) source "
            f"ON (target.{key_col} = source.{key_col}) "
            f"WHEN MATCHED THEN UPDATE SET {', '.join(update_parts)} "
            f"WHEN NOT MATCHED THEN INSERT ({', '.join(insert_cols)}) "
            f"VALUES ({', '.join(insert_vals)})"
        )
        params = [key_value, *values.values()]
        cur.execute(sql, params)

    def _current_ts_expr(self, col: str) -> str:
        if self._cfg.db_type == "mssql":
            return f"{col} = SYSUTCDATETIME()"
        return f"{col} = CURRENT_TIMESTAMP"

    def _now_literal(self) -> str:
        if self._cfg.db_type == "mssql":
            return "SYSUTCDATETIME()"
        return "CURRENT_TIMESTAMP"

    def _last_inserted_id(self, cur, table: str, *, pk_col: str = "id") -> int | None:
        """Return the auto-increment id assigned by the most recent INSERT.

        Tries cursor.lastrowid first (works on MariaDB via jaydebeapi); falls
        back to dialect-specific lookups. Safe inside @_sync because the
        SettingsStore RLock prevents another writer from interleaving between
        the INSERT and the lookup — Oracle's ``SELECT MAX(id)`` is therefore
        race-free in this codebase.
        """
        rid = getattr(cur, "lastrowid", None)
        if rid is not None and rid != 0:
            try:
                return int(rid)
            except (TypeError, ValueError):
                pass
        db = self._cfg.db_type
        try:
            if db == "mariadb":
                cur.execute("SELECT LAST_INSERT_ID()")
            elif db == "mssql":
                cur.execute("SELECT SCOPE_IDENTITY()")
            else:  # oracle
                cur.execute(f"SELECT MAX({pk_col}) FROM {table}")
            row = cur.fetchone()
        except Exception:
            return None
        if not row or row[0] is None:
            return None
        try:
            return int(row[0])
        except (TypeError, ValueError):
            return None

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


def _iso(value: Any) -> str | None:
    """Render a datetime (or already-string) as an ISO-8601 string with 'Z'.

    Used by all the JSON-shaped getters so the FE never has to special-case
    naive vs aware vs string dates coming back from JDBC. None passes through.
    """
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            if value.tzinfo is None:
                return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return value.isoformat()
    return str(value)


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
        "updated_at":   _to_utc_iso8601(row[6]),
        "updated_by":   row[7] if row[7] else None,
    }


def _parse_iso_to_utc_naive(value: Any) -> datetime | None:
    """Parse ISO-8601 (with or without TZ suffix) and return UTC-naive datetime.

    Used for query params (from_ts / to_ts) so DB drivers receive a real
    datetime, not a string with 'T' / 'Z' that MariaDB TIMESTAMP comparison
    can't coerce. Naive input is assumed UTC (matches our INSERT contract).
    Returns None on missing / invalid input.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _to_utc_iso8601(value: Any) -> str | None:
    """Convert any datetime-ish value to a UTC ISO8601 string with 'Z'.

    Accepts: datetime, java.sql.Timestamp (via JayDeBeApi), str, None.
    Returns None on missing/empty input.
    """
    if value is None or value == "":
        return None
    from datetime import datetime, timezone
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    s = str(value).strip()
    if not s:
        return None
    try:
        if "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError):
        return s  # final defensive fallback — return raw string


def _api_business_equal(a: dict, b: dict) -> bool:
    """True iff the non-audit fields of two api dicts match."""
    keys = ("id", "title", "rest_api_path", "connection_id", "sql_id",
            "enabled", "refresh_interval_sec", "query_timeout_sec")
    def norm(d, k):
        v = d.get(k)
        if k == "enabled":
            return bool(v) if v is not None else True
        if k == "refresh_interval_sec":
            return int(v) if v is not None else 5
        if k == "query_timeout_sec":
            return int(v) if v is not None else 30
        return None if v is None else str(v)
    return all(norm(a, k) == norm(b, k) for k in keys)


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


def _extract_index_name(ddl: str) -> str | None:
    """Pull index name out of a `CREATE [UNIQUE] INDEX <name> ON ...` DDL."""
    upper = ddl.upper()
    idx = upper.find("CREATE INDEX")
    if idx < 0:
        idx = upper.find("CREATE UNIQUE INDEX")
        if idx < 0:
            return None
        tail = ddl[idx + len("CREATE UNIQUE INDEX"):].strip()
    else:
        tail = ddl[idx + len("CREATE INDEX"):].strip()
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
        self._store.commit()

    def list(self) -> list[dict[str, Any]]:
        return self._store.list_sql_ids()

    def delete(self, sql_id: str) -> None:
        self._store.delete_sql(sql_id)
        # delete_sql() ran a DELETE under a non-autocommit connection — commit
        # so the change is durable and visible to peer A-A nodes.
        self._store.commit()

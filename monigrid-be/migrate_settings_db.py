"""One-shot migration: copy every `monigrid_*` table between settings DBs.

Usage (from monigrid-be/):
    python migrate_settings_db.py --from initsetting.json --to initsetting.oracle.json

Both JSON files use the same schema as the normal bootstrap initsetting.json.
The destination schema is created if missing. Existing destination rows in
the monigrid_* tables are wiped before the copy so the source becomes the
authoritative snapshot.

CLOB values (Oracle) and LONGTEXT values (MariaDB) are fetched as strings
via the settings_store `_read_clob` helper. Timestamps are preserved
literally — we explicitly set created_at/updated_at from the source row
instead of falling back to the DDL default.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Any

# Allow running as a plain script ("python migrate_settings_db.py").
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.db import ensure_jvm_started
from app.settings_store import (
    SettingsDbConfig,
    SettingsStore,
    _read_clob,
    load_init_settings,
)

try:
    import jaydebeapi
except ImportError:
    jaydebeapi = None


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s migrate %(message)s",
)
log = logging.getLogger("migrate")


# Column order per table. Must match the DDL in settings_store.py so we can
# drive every dialect with the same INSERT statement.
TABLE_COLUMNS: dict[str, list[str]] = {
    "monigrid_settings_meta": ["k", "v"],
    "monigrid_settings_kv":   ["section", "value"],
    "monigrid_connections":   [
        "id", "db_type", "jdbc_driver_class", "jdbc_url",
        "username", "password", "jdbc_jars", "extra_json",
    ],
    "monigrid_apis": [
        "id", "title", "rest_api_path", "connection_id", "sql_id",
        "enabled", "refresh_interval_sec", "query_timeout_sec",
    ],
    "monigrid_sql_queries":     ["sql_id", "content", "updated_at"],
    "monigrid_monitor_targets": [
        "id", "type", "label", "spec", "interval_sec", "enabled", "updated_at",
    ],
    "monigrid_user_preferences": ["username", "value", "updated_at"],
    "monigrid_users": [
        "username", "password_hash", "role", "display_name",
        "enabled", "created_at", "updated_at",
    ],
}


# Columns that are CLOB/LONGTEXT — must be unwrapped to str before re-bind.
CLOB_COLUMNS = {
    ("monigrid_settings_kv",       "value"),
    ("monigrid_connections",       "jdbc_jars"),
    ("monigrid_connections",       "extra_json"),
    ("monigrid_sql_queries",       "content"),
    ("monigrid_monitor_targets",   "spec"),
    ("monigrid_user_preferences",  "value"),
}


def _open_store(cfg: SettingsDbConfig, *, all_jars: list[str]) -> SettingsStore:
    """Open a SettingsStore but share one JVM classpath with both jars."""
    ensure_jvm_started(classpath=all_jars)
    store = SettingsStore(settings_db=cfg, logger=log)
    # Bypass its internal ensure_jvm call (already started above).
    if jaydebeapi is None:
        raise RuntimeError("jaydebeapi missing")
    log.info("connecting %s url=%s", cfg.db_type, cfg.jdbc_url)
    store._conn = jaydebeapi.connect(
        cfg.jdbc_driver_class,
        cfg.jdbc_url,
        [cfg.username, cfg.password],
        all_jars,
    )
    try:
        store._conn.jconn.setAutoCommit(False)
    except Exception:
        pass
    return store


def _fetch_rows(store: SettingsStore, table: str, columns: list[str]) -> list[list[Any]]:
    cur = store._cursor()
    try:
        cur.execute(f"SELECT {', '.join(columns)} FROM {table}")
        rows = cur.fetchall()
    finally:
        try:
            cur.close()
        except Exception:
            pass
    normalized: list[list[Any]] = []
    for row in rows:
        values: list[Any] = []
        for col, val in zip(columns, row):
            if (table, col) in CLOB_COLUMNS:
                values.append(_read_clob(val) if val is not None else None)
            else:
                values.append(val)
        normalized.append(values)
    return normalized


def _wipe_destination(store: SettingsStore, tables: list[str]) -> None:
    # Delete in reverse dependency order — none of our tables have FKs, so the
    # order is irrelevant, but we still commit once after all deletes.
    for t in tables:
        cur = store._cursor()
        try:
            cur.execute(f"DELETE FROM {t}")
            log.info("wiped destination table %s", t)
        finally:
            try:
                cur.close()
            except Exception:
                pass
    store._conn.commit()


def _insert_rows(store: SettingsStore, table: str, columns: list[str], rows: list[list[Any]]) -> int:
    if not rows:
        return 0
    placeholders = ", ".join(["?"] * len(columns))
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    cur = store._cursor()
    inserted = 0
    try:
        for row in rows:
            cur.execute(sql, row)
            inserted += 1
    finally:
        try:
            cur.close()
        except Exception:
            pass
    store._conn.commit()
    return inserted


def migrate(src_path: str, dst_path: str) -> None:
    src_cfg = load_init_settings(src_path)
    dst_cfg = load_init_settings(dst_path)

    # Merge jar paths so one JVM can talk to both ends.
    all_jars = list(dict.fromkeys([*src_cfg.jdbc_jars, *dst_cfg.jdbc_jars]))

    src = _open_store(src_cfg, all_jars=all_jars)
    dst = _open_store(dst_cfg, all_jars=all_jars)

    try:
        log.info("creating destination schema if missing (dbType=%s)", dst_cfg.db_type)
        dst.create_schema()

        tables = list(TABLE_COLUMNS.keys())
        log.info("wiping destination tables in preparation for copy")
        _wipe_destination(dst, tables)

        total_rows = 0
        for table in tables:
            columns = TABLE_COLUMNS[table]
            try:
                rows = _fetch_rows(src, table, columns)
            except Exception as exc:
                log.warning("source table %s not readable (%s) — skipping", table, exc)
                continue
            inserted = _insert_rows(dst, table, columns, rows)
            total_rows += inserted
            log.info("copied %s: %d rows", table, inserted)

        log.info("migration complete — %d total rows copied", total_rows)
    finally:
        src.close()
        dst.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate monigrid_* tables between settings DBs")
    parser.add_argument("--from", dest="src", required=True, help="Source initsetting.json")
    parser.add_argument("--to",   dest="dst", required=True, help="Destination initsetting.json")
    args = parser.parse_args()
    migrate(args.src, args.dst)


if __name__ == "__main__":
    main()

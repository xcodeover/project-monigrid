"""Export monigrid settings DB → portable SQL dump (schema + data).

Run with:
    python monigrid-be/scripts/export_settings_db.py
    python monigrid-be/scripts/export_settings_db.py --out monigrid_db.sql
    python monigrid-be/scripts/export_settings_db.py --include-alerts

Source DB is whatever ``initsetting.json`` points at. Output is one
self-contained `.sql` file with `DROP TABLE IF EXISTS` + `CREATE TABLE`
+ `INSERT` statements for every `monigrid_*` table the backend needs to
boot on a fresh node.

By design this **excludes** ``monigrid_alert_events`` (raise/clear log).
Pass ``--include-alerts`` if you want the history too.

The output targets MariaDB SQL dialect (DDL comes from `SHOW CREATE TABLE`
on the source). Importing into a different engine (Oracle / MSSQL)
requires translation — use ``migrate_settings_db.py`` for that path.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import decimal
import logging
import os
import sys

from monigrid_be_path_setup import setup
setup()

from app.settings_store import (  # noqa: E402
    SettingsStore,
    _read_clob,
    load_init_settings,
)


_LOG = logging.getLogger("export_settings_db")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


# All monigrid_* tables, in dependency-safe insert order. alert_events sits at
# the end so --include-alerts only adds tail rows.
_TABLES_CORE: list[str] = [
    "monigrid_settings_meta",
    "monigrid_settings_kv",
    "monigrid_connections",
    "monigrid_sql_queries",
    "monigrid_apis",
    "monigrid_monitor_targets",
    "monigrid_widget_configs",
    "monigrid_users",
    "monigrid_user_preferences",
]
_TABLES_ALERTS: list[str] = ["monigrid_alert_events"]


def _escape_sql_str(s: str) -> str:
    """MariaDB string literal escaping (default sql_mode)."""
    return s.replace("\\", "\\\\").replace("'", "\\'").replace("\x00", "\\0")


def _format_value(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int,)):
        return str(int(v))
    if isinstance(v, (float, decimal.Decimal)):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "0x" + bytes(v).hex()
    if isinstance(v, _dt.datetime):
        # MariaDB DATETIME / TIMESTAMP literal.
        return f"'{v.strftime('%Y-%m-%d %H:%M:%S')}'"
    if isinstance(v, _dt.date):
        return f"'{v.isoformat()}'"
    # jaydebeapi returns CLOB / LONGTEXT as Java objects sometimes; _read_clob
    # handles both that and pre-converted strings.
    text = v if isinstance(v, str) else _read_clob(v)
    return f"'{_escape_sql_str(text)}'"


def _columns(store: SettingsStore, table: str) -> list[str]:
    cur = store._cursor()
    try:
        # 0 rows back, but the cursor description is populated. Using LIMIT 0
        # avoids streaming any data over the wire just to read column names.
        cur.execute(f"SELECT * FROM {table} WHERE 1=0")
        return [d[0] for d in cur.description]
    finally:
        try:
            cur.close()
        except Exception:
            pass


def _show_create_table(store: SettingsStore, table: str) -> str:
    cur = store._cursor()
    try:
        cur.execute(f"SHOW CREATE TABLE {table}")
        row = cur.fetchone()
    finally:
        try:
            cur.close()
        except Exception:
            pass
    if not row or len(row) < 2:
        raise RuntimeError(f"SHOW CREATE TABLE returned no DDL for {table}")
    return _read_clob(row[1]) if not isinstance(row[1], str) else row[1]


def _fetch_rows(store: SettingsStore, table: str, columns: list[str]) -> list[list]:
    cur = store._cursor()
    try:
        cur.execute(f"SELECT {', '.join(columns)} FROM {table}")
        rows = cur.fetchall()
    finally:
        try:
            cur.close()
        except Exception:
            pass
    return [list(r) for r in rows]


def _dump_table(out, store: SettingsStore, table: str) -> int:
    columns = _columns(store, table)
    ddl = _show_create_table(store, table)
    rows = _fetch_rows(store, table, columns)

    out.write(f"\n-- ─── {table} ({len(rows)} rows) " + "─" * (40 - len(table)) + "\n")
    out.write(f"DROP TABLE IF EXISTS `{table}`;\n")
    out.write(ddl.rstrip() + ";\n\n")

    if not rows:
        out.write(f"-- (no rows in {table})\n")
        return 0

    col_list = ", ".join(f"`{c}`" for c in columns)
    out.write(f"LOCK TABLES `{table}` WRITE;\n")
    for row in rows:
        values = ", ".join(_format_value(v) for v in row)
        out.write(f"INSERT INTO `{table}` ({col_list}) VALUES ({values});\n")
    out.write(f"UNLOCK TABLES;\n")
    return len(rows)


def _open_store():
    here = os.path.dirname(os.path.abspath(__file__))
    be_root = os.path.normpath(os.path.join(here, ".."))
    init_path = os.path.join(be_root, "initsetting.json")
    cfg = load_init_settings(init_path)
    _LOG.info("connecting source dbType=%s url=%s", cfg.db_type, cfg.jdbc_url)
    store = SettingsStore(settings_db=cfg, logger=_LOG)
    store.connect()
    return store, cfg


def main() -> None:
    parser = argparse.ArgumentParser(description="Export monigrid settings DB to SQL")
    parser.add_argument(
        "--out",
        default="monigrid_db_export.sql",
        help="Output .sql path (default: ./monigrid_db_export.sql)",
    )
    parser.add_argument(
        "--include-alerts",
        action="store_true",
        help="Also dump monigrid_alert_events (raise/clear history)",
    )
    args = parser.parse_args()

    out_path = os.path.abspath(args.out)
    tables = list(_TABLES_CORE)
    if args.include_alerts:
        tables += _TABLES_ALERTS

    store, cfg = _open_store()
    try:
        if cfg.db_type != "mariadb":
            _LOG.warning(
                "source dbType=%s — SHOW CREATE TABLE / LOCK TABLES syntax is MariaDB-specific. "
                "Output may not be portable.",
                cfg.db_type,
            )

        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write("-- monigrid settings DB export\n")
            f.write(f"-- source: {cfg.jdbc_url}\n")
            f.write(f"-- generated: {_dt.datetime.utcnow().isoformat()}Z\n")
            f.write(f"-- tables: {', '.join(tables)}\n")
            f.write("--\n")
            f.write("-- Import:\n")
            f.write("--   mysql -h <new-host> -P <port> -u <user> -p <db> < monigrid_db_export.sql\n")
            f.write("\n")
            f.write("SET NAMES utf8mb4;\n")
            f.write("SET FOREIGN_KEY_CHECKS=0;\n")
            f.write("SET UNIQUE_CHECKS=0;\n")
            f.write("SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n")

            total = 0
            for table in tables:
                try:
                    n = _dump_table(f, store, table)
                except Exception as exc:
                    _LOG.error("dump failed for %s: %s", table, exc)
                    f.write(f"\n-- ERROR dumping {table}: {exc}\n")
                    continue
                _LOG.info("dumped %-30s %d rows", table, n)
                total += n

            f.write("\nSET SQL_MODE=@OLD_SQL_MODE;\n")
            f.write("SET FOREIGN_KEY_CHECKS=1;\n")
            f.write("SET UNIQUE_CHECKS=1;\n")
            f.write(f"-- {total} rows total across {len(tables)} tables\n")

        _LOG.info("wrote %s (%d total rows)", out_path, total)
    finally:
        store.close()


if __name__ == "__main__":
    main()

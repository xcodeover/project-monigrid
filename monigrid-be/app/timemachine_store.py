"""Timemachine sample store (Phase 3).

Periodically-collected samples — both monitor target snapshots and data API
endpoint cache refreshes — are appended to a local SQLite file as they
happen. The dashboard's "rewind" UI later fetches the closest-in-time sample
per source so the user can step backward through history.

Why a separate store (not the settings DB):

- Settings DB holds organisation policy / catalog / alert events. It is
  small, schema-controlled, and may live on a remote JDBC server. Time
  series volume (every collector tick × every source) would dominate it.

- A node-local SQLite file has zero ops cost: no provisioning, no
  failover, no pool tuning, and the stdlib ``sqlite3`` module ships with
  Python so there's no new dependency.

- Active-Active note: each node writes its own ``.db`` and the rewind
  endpoint reads only the local file. The lossy semantics (you may see
  the snapshot from whichever node served you) are acceptable for a
  visualisation tool — the source-of-truth (settings/alerts) still lives
  in the shared JDBC DB.

Concurrency:

  ``sqlite3`` connections are not thread-safe. We open the connection with
  ``check_same_thread=False`` and serialise every public method on an
  RLock — every collector / cache thread sees the same connection and the
  lock guarantees one writer at a time.

Compression:

  Per-sample ``zlib.compress(json.dumps(payload).encode("utf-8"))``.
  Default level (6) trades ~70-80% of the bytes for sub-millisecond CPU
  on the typical (small dict) payload — zlib is faster than the SQLite
  insert it precedes, so the cost is invisible in collector wall time.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import zlib
from typing import Any


_DDL = [
    """
    CREATE TABLE IF NOT EXISTS timemachine_samples (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type  TEXT NOT NULL,
        source_id    TEXT NOT NULL,
        ts_ms        INTEGER NOT NULL,
        payload      BLOB NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_tm_source_ts ON timemachine_samples (source_type, source_id, ts_ms)",
    "CREATE INDEX IF NOT EXISTS idx_tm_ts ON timemachine_samples (ts_ms)",
]


class TimemachineStore:
    """Append-only time-series of source samples + per-source latest-at lookup."""

    def __init__(
        self,
        *,
        db_path: str,
        logger: logging.Logger,
    ) -> None:
        self._db_path = db_path
        self._logger = logger
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.RLock()

    # ── lifecycle ────────────────────────────────────────────────────────

    def connect(self) -> None:
        """Open the SQLite file (creates parent directory + schema if needed)."""
        with self._lock:
            if self._conn is not None:
                return
            parent = os.path.dirname(os.path.abspath(self._db_path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            # check_same_thread=False so collector / cache threads can call
            # write_sample without each opening their own connection. Lock
            # provides the actual mutual exclusion.
            self._conn = sqlite3.connect(
                self._db_path,
                check_same_thread=False,
                isolation_level=None,  # autocommit; we still BEGIN where useful
            )
            # WAL keeps reads (dashboard rewind queries) from blocking writes
            # (background collectors). Synchronous=NORMAL is the standard
            # WAL pairing; durability tradeoff is acceptable for a
            # visualisation cache that is intentionally lossy on crash.
            try:
                self._conn.execute("PRAGMA journal_mode = WAL")
                self._conn.execute("PRAGMA synchronous = NORMAL")
            except Exception:
                self._logger.exception("timemachine PRAGMA failed — continuing")
            for stmt in _DDL:
                self._conn.execute(stmt)
            self._logger.info("Timemachine store ready path=%s", self._db_path)

    def close(self) -> None:
        with self._lock:
            if self._conn is None:
                return
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    # ── writes ───────────────────────────────────────────────────────────

    def write_sample(
        self,
        *,
        source_type: str,
        source_id: str,
        payload: Any,
        ts_ms: int | None = None,
    ) -> None:
        """Append one sample. ``payload`` is JSON-serialised then zlib-compressed.

        Failures here MUST NOT propagate up to the collector — the timemachine
        is a best-effort archive. We log and swallow.
        """
        if self._conn is None:
            return
        try:
            ts = int(ts_ms) if ts_ms is not None else int(time.time() * 1000)
            blob = zlib.compress(
                json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8"),
            )
            with self._lock:
                if self._conn is None:
                    return
                self._conn.execute(
                    "INSERT INTO timemachine_samples "
                    "(source_type, source_id, ts_ms, payload) VALUES (?, ?, ?, ?)",
                    (str(source_type), str(source_id), ts, blob),
                )
        except Exception:
            self._logger.exception(
                "timemachine write_sample failed sourceType=%s sourceId=%s",
                source_type, source_id,
            )

    def prune_older_than(self, *, ts_ms: int) -> int:
        """Delete samples older than ``ts_ms``. Returns number of rows removed.

        Run from the retention thread. Idempotent + safe under concurrent writes
        (lock serialises the DELETE just like every other op)."""
        if self._conn is None:
            return 0
        try:
            with self._lock:
                if self._conn is None:
                    return 0
                cur = self._conn.execute(
                    "DELETE FROM timemachine_samples WHERE ts_ms < ?",
                    (int(ts_ms),),
                )
                return int(cur.rowcount or 0)
        except Exception:
            self._logger.exception("timemachine prune_older_than failed")
            return 0

    def vacuum_if_needed(self) -> None:
        """Reclaim deleted-page space. Cheap on small DBs; called occasionally."""
        if self._conn is None:
            return
        try:
            with self._lock:
                if self._conn is None:
                    return
                self._conn.execute("VACUUM")
        except Exception:
            self._logger.exception("timemachine vacuum failed")

    # ── reads ────────────────────────────────────────────────────────────

    def get_sample_at(
        self,
        *,
        source_type: str,
        source_id: str,
        at_ms: int,
    ) -> dict[str, Any] | None:
        """Return the most recent sample at-or-before ``at_ms`` for one source.

        Output shape: ``{tsMs, payload}`` where payload is the decoded dict
        the collector originally saved. Returns ``None`` if no sample exists
        within the available window.
        """
        if self._conn is None:
            return None
        try:
            with self._lock:
                if self._conn is None:
                    return None
                row = self._conn.execute(
                    "SELECT ts_ms, payload FROM timemachine_samples "
                    "WHERE source_type = ? AND source_id = ? AND ts_ms <= ? "
                    "ORDER BY ts_ms DESC LIMIT 1",
                    (str(source_type), str(source_id), int(at_ms)),
                ).fetchone()
        except Exception:
            self._logger.exception(
                "timemachine get_sample_at failed sourceType=%s sourceId=%s",
                source_type, source_id,
            )
            return None
        if row is None:
            return None
        return {"tsMs": int(row[0]), "payload": _decode_payload(row[1])}

    def list_samples_at(self, *, at_ms: int) -> list[dict[str, Any]]:
        """For every (source_type, source_id) that has any sample ≤ at_ms,
        return its most recent sample. Used by the rewind dashboard fetch.

        Implemented with a window-style "latest per group" pattern that
        SQLite supports via correlated subquery — fine for the scale here
        (a few hundred sources × any retention window).
        """
        if self._conn is None:
            return []
        try:
            with self._lock:
                if self._conn is None:
                    return []
                rows = self._conn.execute(
                    "SELECT t.source_type, t.source_id, t.ts_ms, t.payload "
                    "FROM timemachine_samples t "
                    "JOIN ( "
                    "  SELECT source_type, source_id, MAX(ts_ms) AS max_ts "
                    "  FROM timemachine_samples WHERE ts_ms <= ? "
                    "  GROUP BY source_type, source_id "
                    ") m ON m.source_type = t.source_type "
                    "  AND m.source_id = t.source_id AND m.max_ts = t.ts_ms",
                    (int(at_ms),),
                ).fetchall()
        except Exception:
            self._logger.exception("timemachine list_samples_at failed")
            return []
        out: list[dict[str, Any]] = []
        for r in rows:
            out.append({
                "sourceType": str(r[0]),
                "sourceId": str(r[1]),
                "tsMs": int(r[2]),
                "payload": _decode_payload(r[3]),
            })
        return out

    def list_samples_range(
        self, *, source_type: str, source_id: str,
        from_ms: int, to_ms: int, limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Return samples for one source within [from_ms, to_ms] ordered ascending.

        Output shape: ``[{tsMs, payload}, ...]``. Used by the Phase 3 ``/series``
        endpoint to feed detail modals with a 1-hour timeseries.
        """
        if self._conn is None:
            return []
        try:
            with self._lock:
                if self._conn is None:
                    return []
                rows = self._conn.execute(
                    "SELECT ts_ms, payload FROM timemachine_samples "
                    "WHERE source_type = ? AND source_id = ? "
                    "AND ts_ms BETWEEN ? AND ? "
                    "ORDER BY ts_ms ASC LIMIT ?",
                    (source_type, source_id, int(from_ms), int(to_ms), int(limit)),
                ).fetchall()
        except Exception:
            self._logger.exception("timemachine list_samples_range failed")
            return []
        return [{"tsMs": int(r[0]), "payload": _decode_payload(r[1])} for r in rows]

    def stats(self) -> dict[str, Any]:
        """Return basic stats for the Configuration page (row count, span)."""
        if self._conn is None:
            return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
        try:
            with self._lock:
                if self._conn is None:
                    return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
                row = self._conn.execute(
                    "SELECT COUNT(*), MIN(ts_ms), MAX(ts_ms) FROM timemachine_samples",
                ).fetchone()
        except Exception:
            self._logger.exception("timemachine stats failed")
            return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
        if row is None:
            return {"rowCount": 0, "minTsMs": None, "maxTsMs": None}
        return {
            "rowCount": int(row[0] or 0),
            "minTsMs": int(row[1]) if row[1] is not None else None,
            "maxTsMs": int(row[2]) if row[2] is not None else None,
        }


def _decode_payload(blob: Any) -> Any:
    if blob is None:
        return None
    try:
        text = zlib.decompress(blob).decode("utf-8")
    except Exception:
        # Defensive fallback: someone wrote raw JSON bytes by hand
        try:
            text = bytes(blob).decode("utf-8")
        except Exception:
            return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text

"""Log file reader service.

Extracted from `MonitoringBackend.get_logs` (SRP). Owns nothing but the
logging-section of `AppConfig` and a logger; reads daily-rotated log files
under `logging.directory` and returns paginated lines plus a cursor for
incremental tailing.

## Cursor formats

Two distinct cursor schemas are in use:

**History mode** (``follow_latest=False``):
    ``{"YYYY-MM-DD": line_count, ...}``
    Tracks per-date line offsets so the caller can page forward across a date
    range without re-reading already-seen lines.

**Follow mode** (``follow_latest=True``):
    ``{"__follow__": {"file": "prefix-YYYY-MM-DD.log", "offset": N, "line": N}}``
    Stores a *byte* offset into the active daily log so that each polling call
    only reads the newly appended bytes instead of the entire (potentially
    multi-GB) file.  ``line`` is the cumulative line count (UI display only).

### Follow-mode seek logic

1. ``cursor is None`` → first call; start at byte 0 (or seek to max_lines tail).
2. ``cursor.file == active_filename`` and ``offset <= file_size``
       → ``f.seek(offset)``; read only new bytes.
3. ``cursor.file != active_filename`` (date rotate at midnight)
       → open new file from byte 0.
4. ``cursor.offset > os.path.getsize(file)`` (truncate / inode change)
       → reset to byte 0.
"""
from __future__ import annotations

import logging
import os
from collections import deque
from datetime import date, datetime, timedelta
from pathlib import Path

from .config import LoggingConfig
from .utils import decode_log_cursor, encode_log_cursor


LOG_DATE_FORMAT = "%Y-%m-%d"


class LogReader:
    """Reads daily-rotated log files and supports incremental cursors."""

    def __init__(self, logging_config: LoggingConfig, logger: logging.Logger) -> None:
        self._logging = logging_config
        self._logger = logger

    def update_logging_config(self, logging_config: LoggingConfig) -> None:
        """Refresh the logging-config reference (called from `MonitoringBackend.reload`)."""
        self._logging = logging_config

    # ── public API ──────────────────────────────────────────────────────────

    def get_logs(
        self,
        start_date_str: str | None = None,
        end_date_str: str | None = None,
        max_lines: int = 1000,
        cursor: str | None = None,
        follow_latest: bool = False,
    ) -> tuple[list[str], str | None, str, str]:
        try:
            if follow_latest:
                end_date = date.today()
            else:
                end_date = (
                    datetime.strptime(end_date_str, LOG_DATE_FORMAT).date()
                    if end_date_str else date.today()
                )
            start_date = (
                datetime.strptime(start_date_str, LOG_DATE_FORMAT).date()
                if start_date_str else end_date
            )
        except ValueError:
            raise ValueError("Invalid date format. Use YYYY-MM-DD.")

        if start_date > end_date:
            raise ValueError("start_date cannot be after end_date")

        if follow_latest:
            return self._get_logs_follow(end_date, max_lines, cursor)
        return self._get_logs_history(start_date, end_date, max_lines, cursor)

    # ── follow mode (byte-offset cursor) ────────────────────────────────────

    def _get_logs_follow(
        self,
        today: date,
        max_lines: int,
        raw_cursor: str | None,
    ) -> tuple[list[str], str | None, str, str]:
        """Return incremental lines for LIVE polling using a byte-offset cursor.

        Only the bytes appended since the last call are read, so disk IO scales
        with *new data* rather than with file size.
        """
        date_key = today.strftime(LOG_DATE_FORMAT)
        log_file = (
            Path(self._logging.directory)
            / f"{self._logging.file_prefix}-{date_key}.log"
        )
        active_filename = log_file.name  # e.g. "monitoring_backend-2026-05-05.log"

        decoded = decode_log_cursor(raw_cursor)
        prev_follow = decoded.get("__follow__") if decoded else None

        # Determine seek offset -------------------------------------------------
        seek_offset: int = 0
        prev_line_count: int = 0
        if prev_follow is not None:
            prev_file: str = prev_follow["file"]
            prev_offset: int = prev_follow["offset"]
            prev_line_count = prev_follow["line"]

            if prev_file != active_filename:
                # Date rotate — new file, start from beginning
                seek_offset = 0
                prev_line_count = 0
                self._logger.info(
                    "log_reader: date rotate detected (%s → %s), resetting offset",
                    prev_file, active_filename,
                )
            else:
                # Same file — validate offset against current size
                try:
                    current_size = os.path.getsize(log_file)
                except OSError:
                    current_size = 0

                if prev_offset > current_size:
                    # Truncation / inode change — reset
                    seek_offset = 0
                    prev_line_count = 0
                    self._logger.info(
                        "log_reader: truncation detected (offset %d > size %d), resetting",
                        prev_offset, current_size,
                    )
                else:
                    seek_offset = prev_offset

        # File does not exist yet (e.g. midnight, new file not created) ----------
        if not log_file.exists():
            next_cursor = encode_log_cursor(
                {"__follow__": {"file": active_filename, "offset": 0, "line": prev_line_count}}
            )
            return [], next_cursor, date_key, date_key

        # Read only the new bytes -----------------------------------------------
        lines: list[str] = []
        end_offset: int = seek_offset
        new_line_count: int = 0

        try:
            with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                if seek_offset == 0 and prev_follow is None:
                    # First call ever: return only the last max_lines lines so
                    # the UI gets an immediately useful tail, not the full file.
                    tail: deque[str] = deque(maxlen=max_lines)
                    for line in f:
                        new_line_count += 1
                        tail.append(line.rstrip("\n"))
                    # NOTE: f.tell()은 for 루프가 이터레이터를 완전히 소진한 후에만 안전합니다.
                    # 루프 중간에 break를 추가하면 텍스트 모드에서 OSError가 발생합니다.
                    end_offset = f.tell()
                    lines = list(tail)
                else:
                    # Subsequent calls (or seek_offset set from prev_follow):
                    # read only newly appended bytes.
                    # 메모리 보호: 폴 사이에 대량의 로그가 쌓여도 max_lines 이상 메모리를 차지하지 않음.
                    f.seek(seek_offset)
                    tail_buf: deque[str] = deque(maxlen=max_lines)
                    for line in f:
                        new_line_count += 1
                        tail_buf.append(line.rstrip("\n"))
                    # NOTE: f.tell()은 for 루프가 이터레이터를 완전히 소진한 후에만 안전합니다.
                    # 루프 중간에 break를 추가하면 텍스트 모드에서 OSError가 발생합니다.
                    end_offset = f.tell()
                    lines = list(tail_buf)

        except Exception as error:
            self._logger.error("Failed to read log file '%s': %s", log_file, error)
            # Return empty with unchanged cursor so next poll retries cleanly
            next_cursor = encode_log_cursor(
                {"__follow__": {"file": active_filename, "offset": seek_offset, "line": prev_line_count}}
            )
            return [], next_cursor, date_key, date_key

        cumulative_lines = prev_line_count + new_line_count
        # lines는 deque(maxlen=max_lines)로 이미 max_lines 이하임 — 별도 trim 불필요.
        next_cursor = encode_log_cursor(
            {"__follow__": {"file": active_filename, "offset": end_offset, "line": cumulative_lines}}
        )
        return lines, next_cursor, date_key, date_key

    # ── history mode (line-count cursor, unchanged) ──────────────────────────

    def _get_logs_history(
        self,
        start_date: date,
        end_date: date,
        max_lines: int,
        raw_cursor: str | None,
    ) -> tuple[list[str], str | None, str, str]:
        """Return paginated log lines across a date range (history / search mode).

        Uses the legacy per-date line-count cursor; behaviour is unchanged from
        before the Phase 4 byte-offset refactor.
        """
        log_cursor = decode_log_cursor(raw_cursor)
        # If caller accidentally passes a follow-mode cursor into history mode,
        # ignore it gracefully.
        if "__follow__" in log_cursor:
            log_cursor = {}

        collected_lines: list[str] = []
        next_cursor: dict[str, int] = {}
        current_date = start_date

        while current_date <= end_date:
            date_key = current_date.strftime(LOG_DATE_FORMAT)
            log_file = (
                Path(self._logging.directory)
                / f"{self._logging.file_prefix}-{date_key}.log"
            )
            if log_file.exists():
                try:
                    # readlines() used to materialise the entire daily log
                    # (potentially hundreds of MB) just to slice the tail.
                    # Stream line-by-line into a fixed-size deque so memory
                    # stays bounded by max_lines regardless of file size.
                    total = 0
                    tail: deque[str] = deque(maxlen=max_lines)
                    with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                        for line in f:
                            total += 1
                            tail.append(line.rstrip("\n"))
                    previous_count = max(0, int(log_cursor.get(date_key, 0)))
                    if previous_count > total:
                        previous_count = 0
                    # tail covers lines [total - len(tail), total). If the
                    # cursor sits inside that window, drop the already-seen
                    # head of the tail; otherwise hand back the whole tail
                    # (older unseen lines were going to be trimmed by the
                    # final [-max_lines:] anyway).
                    tail_start = total - len(tail)
                    skip_in_tail = max(0, previous_count - tail_start)
                    if skip_in_tail:
                        tail_lines = list(tail)[skip_in_tail:]
                    else:
                        tail_lines = list(tail)
                    collected_lines.extend(tail_lines)
                    next_cursor[date_key] = total
                except Exception as error:
                    self._logger.error("Failed to read log file '%s': %s", log_file, error)
            else:
                next_cursor[date_key] = 0
            current_date += timedelta(days=1)

        trimmed_lines = collected_lines[-max_lines:]
        return (
            trimmed_lines,
            encode_log_cursor(next_cursor) if next_cursor else None,
            start_date.strftime(LOG_DATE_FORMAT),
            end_date.strftime(LOG_DATE_FORMAT),
        )

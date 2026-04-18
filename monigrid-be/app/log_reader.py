"""Log file reader service.

Extracted from `MonitoringBackend.get_logs` (SRP). Owns nothing but the
logging-section of `AppConfig` and a logger; reads daily-rotated log files
under `logging.directory` and returns paginated lines plus a cursor for
incremental tailing.
"""
from __future__ import annotations

import logging
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

        log_cursor = decode_log_cursor(cursor)
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
                    with open(log_file, "r", encoding="utf-8") as f:
                        lines = [line.rstrip("\n") for line in f.readlines()]
                        previous_count = max(0, int(log_cursor.get(date_key, 0)))
                        if previous_count > len(lines):
                            previous_count = 0
                        collected_lines.extend(lines[previous_count:])
                        next_cursor[date_key] = len(lines)
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

"""Logging infrastructure: daily rotating file handler and configuration."""
from __future__ import annotations

import logging
import re
import sys
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any


LOG_DATE_FORMAT = "%Y-%m-%d"


class MonitoringLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        original_level_name = record.levelname
        if record.exc_info:
            record.levelname = "EXCEPTION"
        try:
            return super().format(record)
        finally:
            record.levelname = original_level_name


class DailyLogFileHandler(logging.Handler):
    """Logging handler that writes to a daily-rotated file and cleans up old files."""

    def __init__(
        self,
        log_dir: str,
        file_prefix: str,
        retention_days: int,
        encoding: str = "utf-8",
    ) -> None:
        super().__init__()
        self.log_dir = Path(log_dir)
        self.file_prefix = file_prefix
        self.retention_days = max(1, retention_days)
        self.encoding = encoding
        self.current_date: str | None = None
        self.file_handler: logging.FileHandler | None = None
        self.file_pattern = re.compile(
            rf"^{re.escape(self.file_prefix)}-(\d{{4}}-\d{{2}}-\d{{2}})\.log$"
        )
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._refresh_file_handler()

    def emit(self, record: logging.LogRecord) -> None:
        self.acquire()
        try:
            self._refresh_file_handler()
            if self.file_handler is not None:
                self.file_handler.emit(record)
        except Exception:
            self.handleError(record)
        finally:
            self.release()

    def setFormatter(self, fmt: logging.Formatter | None) -> None:
        super().setFormatter(fmt)
        if self.file_handler is not None and fmt is not None:
            self.file_handler.setFormatter(fmt)

    def setLevel(self, level: int | str) -> None:
        super().setLevel(level)
        if self.file_handler is not None:
            self.file_handler.setLevel(level)

    def close(self) -> None:
        self.acquire()
        try:
            if self.file_handler is not None:
                self.file_handler.close()
                self.file_handler = None
                self.current_date = None
        finally:
            self.release()
            super().close()

    def _refresh_file_handler(self) -> None:
        current_date = datetime.now().strftime(LOG_DATE_FORMAT)
        if self.current_date == current_date and self.file_handler is not None:
            return

        if self.file_handler is not None:
            self.file_handler.close()

        self.log_dir.mkdir(parents=True, exist_ok=True)
        log_file_path = self.log_dir / f"{self.file_prefix}-{current_date}.log"
        self.file_handler = logging.FileHandler(log_file_path, encoding=self.encoding)
        self.file_handler.setLevel(self.level)

        if self.formatter is not None:
            self.file_handler.setFormatter(self.formatter)

        self.current_date = current_date
        self._cleanup_old_files()

    def _cleanup_old_files(self) -> None:
        cutoff_date = date.today() - timedelta(days=self.retention_days - 1)

        for file_path in self.log_dir.glob(f"{self.file_prefix}-*.log"):
            match = self.file_pattern.match(file_path.name)
            if not match:
                continue
            try:
                file_date = datetime.strptime(match.group(1), LOG_DATE_FORMAT).date()
            except ValueError:
                continue
            if file_date < cutoff_date:
                try:
                    file_path.unlink()
                except OSError:
                    continue


def _startup_log(logger: logging.Logger, msg: str, *args: Any) -> None:
    """Log startup messages regardless of configured log level."""
    original_logger_level = logger.level
    original_handler_levels = [(h, h.level) for h in logger.handlers]
    logger.setLevel(logging.INFO)
    for h in logger.handlers:
        h.setLevel(logging.INFO)
    logger.info(msg, *args)
    logger.setLevel(original_logger_level)
    for h, lvl in original_handler_levels:
        h.setLevel(lvl)


def configure_logging(logging_config) -> logging.Logger:
    from .utils import get_env as _  # noqa: F401 - ensure utils loaded
    logger = logging.getLogger("monitoring_backend")
    logger.setLevel(logging_config.level)
    logger.propagate = False

    formatter = MonitoringLogFormatter(
        fmt="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        handler.close()

    file_handler = DailyLogFileHandler(
        log_dir=logging_config.directory,
        file_prefix=logging_config.file_prefix,
        retention_days=logging_config.retention_days,
    )
    file_handler.setLevel(logging_config.level)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging_config.level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    level_name = logging.getLevelName(logging_config.level)
    _startup_log(
        logger,
        "Logging configured level=%s logDir=%s retentionDays=%s slowQueryThresholdSec=%.3f",
        level_name,
        logging_config.directory,
        logging_config.retention_days,
        logging_config.slow_query_threshold_sec,
    )
    return logger


def install_global_exception_hooks(logger: logging.Logger) -> None:
    def _handle_unhandled_exception(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_traceback)
            return
        logger.critical(
            "Unhandled process exception",
            exc_info=(exc_type, exc_value, exc_traceback),
        )

    def _handle_thread_exception(args: threading.ExceptHookArgs):
        logger.critical(
            "Unhandled thread exception thread=%s",
            args.thread.name if args.thread else "unknown",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = _handle_unhandled_exception
    if hasattr(threading, "excepthook"):
        threading.excepthook = _handle_thread_exception

"""Shared utility functions."""
from __future__ import annotations

import base64
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from flask import request


def resolve_base_dir() -> str:
    if getattr(sys, "frozen", False):
        meipass_dir = getattr(sys, "_MEIPASS", None)
        if meipass_dir:
            return meipass_dir
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def get_env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def parse_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"false", "0", "no", "off"}
    if isinstance(value, (int, float)):
        return value != 0
    if value is None:
        return True
    return bool(value)


def to_jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def get_client_ip() -> str:
    forwarded_for = (request.headers.get("X-Forwarded-For") or "").strip()
    if forwarded_for:
        first_hop = forwarded_for.split(",", 1)[0].strip()
        if first_hop:
            return first_hop

    real_ip = (request.headers.get("X-Real-IP") or "").strip()
    if real_ip:
        return real_ip

    return request.remote_addr or "unknown"


def encode_log_cursor(cursor: dict) -> str:
    """Encode a log cursor dict to a URL-safe base64 string.

    Supports both history-mode cursors (``{date_key: line_count}``) and
    follow-mode cursors (``{"__follow__": {file, offset, line}}``).
    """
    payload = json.dumps(cursor, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def decode_log_cursor(raw_cursor: str | None) -> dict:
    """Decode a log cursor from a URL-safe base64 string.

    Returns an empty dict when *raw_cursor* is ``None`` or empty.  The returned
    dict may be:
    - a history-mode cursor: ``{"YYYY-MM-DD": line_count, ...}``
    - a follow-mode cursor:  ``{"__follow__": {"file": str, "offset": int, "line": int}}``
    """
    if not raw_cursor:
        return {}

    try:
        padded = raw_cursor + "=" * (-len(raw_cursor) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        parsed = json.loads(decoded)
    except Exception as error:
        raise ValueError("Invalid log cursor") from error

    if not isinstance(parsed, dict):
        raise ValueError("Invalid log cursor")

    # Follow-mode cursor: {"__follow__": {file, offset, line}} — pass through as-is
    if "__follow__" in parsed:
        fc = parsed["__follow__"]
        if isinstance(fc, dict):
            return {
                "__follow__": {
                    "file": str(fc.get("file", "")),
                    "offset": max(0, int(fc.get("offset", 0))),
                    "line": max(0, int(fc.get("line", 0))),
                }
            }
        raise ValueError("Invalid log cursor")

    # Legacy history-mode cursor: {"YYYY-MM-DD": line_count}
    result: dict[str, int] = {}
    for key, value in parsed.items():
        result[str(key)] = max(0, int(value))
    return result

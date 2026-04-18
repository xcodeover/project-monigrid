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


def encode_log_cursor(cursor: dict[str, int]) -> str:
    payload = json.dumps(cursor, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def decode_log_cursor(raw_cursor: str | None) -> dict[str, int]:
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

    result: dict[str, int] = {}
    for key, value in parsed.items():
        result[str(key)] = max(0, int(value))
    return result

"""Email body rendering. HTML + plain-text multipart.

Templates live next to this module rather than under Flask's templates/
because they're not request-scoped. We render with a tiny Jinja2 Environment
configured for autoescape on .html files.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape


_logger = logging.getLogger(__name__)
_TEMPLATE_DIR = os.path.join(os.path.dirname(__file__), "templates")
_LEVEL_COLORS = {
    "warn": "#d97706",      # amber-600
    "critical": "#dc2626",  # red-600
}
_LEVEL_LABELS_KO = {
    "warn": "경고",
    "critical": "심각",
}
_SOURCE_TYPE_LABELS_KO = {
    "server_resource": "서버 리소스",
    "network": "네트워크",
    "http_status": "HTTP 상태",
    "data_api:table": "데이터 API (표)",
    "data_api:line-chart": "데이터 API (라인 차트)",
    "data_api:bar-chart": "데이터 API (바 차트)",
}


def _format_kst(dt_utc: datetime) -> str:
    # We render in KST without pulling pytz — just shift +9h from UTC.
    if dt_utc.tzinfo is None:
        dt_utc = dt_utc.replace(tzinfo=timezone.utc)
    kst = dt_utc.astimezone(timezone(__import__("datetime").timedelta(hours=9)))
    return kst.strftime("%Y-%m-%d %H:%M:%S KST")


def _level_color(level: str) -> str:
    return _LEVEL_COLORS.get(level or "warn", _LEVEL_COLORS["warn"])


def _level_label(level: str) -> str:
    return _LEVEL_LABELS_KO.get(level or "warn", level or "")


def _source_label(source_type: str) -> str:
    return _SOURCE_TYPE_LABELS_KO.get(source_type, source_type)


def _build_env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(_TEMPLATE_DIR),
        autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=False),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["kst"] = _format_kst
    env.filters["level_color"] = _level_color
    env.filters["level_label"] = _level_label
    env.filters["source_label"] = _source_label
    return env


_env: Environment | None = None


def _env_singleton() -> Environment:
    global _env
    if _env is None:
        _env = _build_env()
    return _env


def render_alert_email(
    *,
    event: dict[str, Any],
    related_active: list[dict[str, Any]] | None = None,
    sparkline_svg: str | None = None,
    dashboard_url: str | None = None,
    timemachine_url: str | None = None,
    cooldown_recent_count: int = 0,
    app_name: str = "MoniGrid",
) -> tuple[str, str, str]:
    """Render subject + html + text for a single alert event.

    `event` is the dict shape returned by SettingsStore.list_alert_events
    (source_type, source_id, metric, severity, level, label, message, payload,
    created_at). `payload` may include value/threshold/host/etc.
    """
    env = _env_singleton()
    payload = event.get("payload") or {}
    if isinstance(payload, str):
        # tolerate raw JSON string defensively
        try:
            import json as _json
            payload = _json.loads(payload)
        except Exception:
            payload = {"raw": payload}

    ctx = {
        "event": event,
        "payload": payload,
        "related": related_active or [],
        "sparkline_svg": sparkline_svg or "",
        "dashboard_url": dashboard_url or "",
        "timemachine_url": timemachine_url or "",
        "cooldown_recent_count": cooldown_recent_count,
        "app_name": app_name,
    }

    level = (event.get("level") or "warn").lower()
    severity = (event.get("severity") or "raise").lower()
    source_type = event.get("source_type") or ""
    label = event.get("label") or event.get("source_id") or ""
    metric = event.get("metric") or "-"

    if severity == "clear":
        subject = f"[{app_name}][CLEAR] {_source_label(source_type)} - {label} — {metric}"
    else:
        subject = (
            f"[{app_name}][{level.upper()}] {_source_label(source_type)} - {label} — {metric}"
        )

    html = env.get_template("alert.html").render(**ctx)
    text = env.get_template("alert.txt").render(**ctx)
    return subject, html, text


def render_test_email(*, recipient: str, app_name: str = "MoniGrid") -> tuple[str, str, str]:
    """One-off connectivity probe — used by the 'send test email' button."""
    now = datetime.now(timezone.utc)
    subject = f"[{app_name}] SMTP 연결 테스트"
    text = (
        f"This is a test email from {app_name} sent at {_format_kst(now)}\n"
        f"to {recipient}.\n\n"
        "If you received this, your SMTP channel configuration is working."
    )
    html = (
        "<html><body style=\"font-family:Arial,sans-serif;\">"
        f"<h3>{app_name} SMTP test</h3>"
        f"<p>Sent at <b>{_format_kst(now)}</b> to <b>{recipient}</b>.</p>"
        "<p>If you received this, your SMTP channel configuration is working.</p>"
        "</body></html>"
    )
    return subject, html, text

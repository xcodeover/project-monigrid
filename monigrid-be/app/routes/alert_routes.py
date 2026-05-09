"""Alert event query endpoints.

Phase 1: read-only access to the BE-side alert transition log
(``monigrid_alert_events``). Filtering by time range, source, severity, and
keyword (label/message substring), with paging.

Writes are produced by ``AlertEvaluator`` from the collector hot path, not
from any HTTP request — so this module is GET-only.
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import require_auth


# ── helpers ───────────────────────────────────────────────────────────────────


def _str_or_none(value) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _int_or_default(value, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def register(app, backend, limiter) -> None:
    @app.route("/dashboard/alerts/active", methods=["GET"])
    @require_auth
    def list_active_alerts():
        """Return the in-memory set of currently-raised (un-cleared) alarms.

        FE polls this every few seconds to highlight widgets without
        replaying the entire transition log. ``key`` is a stable string
        clients can diff between polls to detect new vs. continuing alarms.

        Response shape:
          { "items": [{sourceType, sourceId, metric, label, message,
                       payload, key}, ...], "count": N }
        """
        try:
            items = backend.list_active_alerts()
        except Exception:
            backend.logger.exception("list_active_alerts failed")
            return jsonify({"message": "active alert query failed"}), 500
        return jsonify({"items": items, "count": len(items)}), 200

    @app.route("/dashboard/alerts", methods=["GET"])
    @require_auth
    def list_alert_events():
        """Return alert transition events. Filters are all optional.

        Query params:
          from        — ISO-8601 lower bound on created_at (inclusive)
          to          — ISO-8601 upper bound on created_at (inclusive)
          sourceType  — "server_resource" | "network" | "http_status"
          sourceId    — exact match against monitor target id
          severity    — "raise" | "clear"
          keyword     — substring match against label OR message
          limit       — 1..1000 (default 200)
          offset      — non-negative int (default 0)

        Response shape:
          { "items": [...], "totalCount": N, "limit": L, "offset": O }
        """
        args = request.args
        try:
            items, total = backend.settings_store.list_alert_events(
                from_ts=_str_or_none(args.get("from")),
                to_ts=_str_or_none(args.get("to")),
                source_type=_str_or_none(args.get("sourceType")),
                source_id=_str_or_none(args.get("sourceId")),
                severity=_str_or_none(args.get("severity")),
                keyword=_str_or_none(args.get("keyword")),
                limit=_int_or_default(args.get("limit"), 200),
                offset=_int_or_default(args.get("offset"), 0),
            )
        except Exception:
            backend.logger.exception("list_alert_events failed args=%s", dict(args))
            return jsonify({"message": "alert query failed"}), 500

        return jsonify({
            "items": items,
            "totalCount": total,
            "limit": _int_or_default(args.get("limit"), 200),
            "offset": _int_or_default(args.get("offset"), 0),
        }), 200

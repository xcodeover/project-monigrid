"""System endpoints: liveness probe and log access."""
from __future__ import annotations

import dataclasses
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from flask import jsonify, request

from app.auth import require_admin, require_auth
from app.utils import parse_enabled


def register(app, backend, limiter) -> None:

    @app.route("/health", methods=["GET"])
    def health_check():
        # Minimal liveness probe — no auth so LB / k8s readiness checks work,
        # and intentionally no version / endpoint count: those leak the
        # deployed build to anyone who can reach the port. Authenticated
        # callers can use /dashboard/health for diagnostic detail.
        return jsonify({
            "status": "healthy",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }), 200

    @app.route("/dashboard/health", methods=["GET"])
    @require_auth
    def dashboard_health():
        """Authenticated diagnostic health: includes version + endpoint count."""
        return jsonify({
            "status": "healthy",
            "version": backend.config.version,
            "dashboardTitle": backend.config.dashboard_title,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "loadedEndpoints": len(backend.config.apis),
        }), 200

    @app.route("/dashboard/settings/title", methods=["PUT"])
    @require_admin
    def set_dashboard_title():
        """Admin-only: update the dashboard display title.

        Persists the new title to ``monigrid_settings_kv`` under the
        ``dashboard_title`` key and updates the in-memory config so that
        subsequent ``/dashboard/health`` calls return the fresh value
        without requiring a backend restart.

        Body: ``{"title": "..."}``  (string, max 200 chars, may be empty
        to reset to the FE-side default).
        """
        body = request.get_json(silent=True) or {}
        raw_title = body.get("title", "")
        if not isinstance(raw_title, str):
            return jsonify({"message": "title must be a string"}), 400
        title = raw_title.strip()
        if len(title) > 200:
            return jsonify({"message": "title must be 200 characters or fewer"}), 400

        # Persist to KV store
        backend.settings_store.set_kv_scalar("dashboard_title", title)

        # Update in-memory config (frozen dataclass → use dataclasses.replace)
        backend.config = dataclasses.replace(backend.config, dashboard_title=title)

        return jsonify({"title": title}), 200

    @app.route("/logs", methods=["GET"])
    @require_auth
    def get_logs():
        start_date_param = request.args.get("start_date")
        end_date_param = request.args.get("end_date")
        # Clamp max_lines to a sane window. Without this a malicious or
        # buggy client can ask for billions of lines and the backend
        # happily allocates the response in memory.
        try:
            requested = int(request.args.get("max_lines", 1000))
        except (TypeError, ValueError):
            return jsonify({"message": "max_lines must be an integer"}), 400
        max_lines = max(1, min(10000, requested))
        cursor = request.args.get("cursor")
        follow_latest = parse_enabled(request.args.get("follow_latest", False))

        try:
            logs, next_cursor, resolved_start_date, resolved_end_date = backend.get_logs(
                start_date_param, end_date_param, max_lines, cursor=cursor, follow_latest=follow_latest,
            )
        except ValueError as error:
            return jsonify({"message": str(error)}), 400

        return jsonify({
            "logs": logs,
            "count": len(logs),
            "startDate": resolved_start_date,
            "endDate": resolved_end_date,
            "nextCursor": next_cursor,
        }), 200

    @app.route("/logs/available-dates", methods=["GET"])
    @require_auth
    def get_available_log_dates():
        log_dir = Path(backend.config.logging.directory)
        if not log_dir.exists():
            return jsonify({"dates": []}), 200

        pattern = re.compile(
            rf"^{re.escape(backend.config.logging.file_prefix)}-(\d{{4}}-\d{{2}}-\d{{2}})\.log$"
        )
        dates = []
        for file_path in sorted(log_dir.glob(f"{backend.config.logging.file_prefix}-*.log"), reverse=True):
            match = pattern.match(file_path.name)
            if match:
                dates.append(match.group(1))
        return jsonify({"dates": dates}), 200

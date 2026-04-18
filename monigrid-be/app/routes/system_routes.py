"""System endpoints: liveness probe and log access."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from flask import jsonify, request

from app.auth import require_auth
from app.utils import parse_enabled


def register(app, backend, limiter) -> None:

    @app.route("/health", methods=["GET"])
    def health_check():
        return jsonify({
            "status": "healthy",
            "version": backend.config.version,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "loadedEndpoints": len(backend.config.apis),
        }), 200

    @app.route("/logs", methods=["GET"])
    @require_auth
    def get_logs():
        start_date_param = request.args.get("start_date")
        end_date_param = request.args.get("end_date")
        max_lines = int(request.args.get("max_lines", 1000))
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

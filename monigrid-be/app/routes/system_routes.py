"""System endpoints: liveness probe and dashboard title persistence.

Phase 1 removed the ``/logs`` and ``/logs/available-dates`` endpoints
(plus the FE log viewer that was their only consumer) — operators read
log files directly on the host now. The remaining surface is health
checks and the dashboard-title KV mutator.
"""
from __future__ import annotations

import dataclasses
from datetime import datetime, timezone

from flask import jsonify, request

from app.auth import require_admin, require_auth


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

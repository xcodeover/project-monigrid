"""System endpoints: liveness probes.

Phase 1 removed the ``/logs`` and ``/logs/available-dates`` endpoints
(plus the FE log viewer that was their only consumer) — operators read
log files directly on the host now. The dashboard title / company name /
version KV writes were folded into PUT /dashboard/config (admin edits
them via the backend settings page → 기본 탭 → 서버 항목).
"""
from __future__ import annotations

from datetime import datetime, timezone

from flask import jsonify

from app.auth import require_auth


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
            "companyName": backend.config.app_company_name,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "loadedEndpoints": len(backend.config.apis),
        }), 200

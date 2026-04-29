"""Per-user UI preferences (layouts, thresholds, column order).

Endpoints are scoped to the caller's own JWT username — users may not
read or edit anyone else's preferences. Admin-level management of
user accounts themselves is handled separately (users table, Phase 4).
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import current_username, require_auth
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:

    @app.route("/dashboard/me/preferences", methods=["GET"])
    @require_auth
    def get_my_preferences():
        username = current_username()
        if not username:
            return jsonify({"message": "unauthenticated"}), 401
        try:
            prefs = backend.get_user_preferences(username)
        except Exception as err:
            backend.logger.exception(
                "User preferences load failed username=%s clientIp=%s",
                username, get_client_ip(),
            )
            return jsonify({"message": "failed to load preferences", "detail": str(err)}), 500
        return jsonify({"preferences": prefs}), 200

    @app.route("/dashboard/me/preferences", methods=["PUT"])
    @require_auth
    def put_my_preferences():
        username = current_username()
        if not username:
            return jsonify({"message": "unauthenticated"}), 401
        body = request.get_json(silent=True) or {}
        # Accept either {"preferences": {...}} or a raw object — FE may
        # send either shape depending on how the request is composed.
        payload = body.get("preferences") if isinstance(body.get("preferences"), dict) else body
        if not isinstance(payload, dict):
            return jsonify({"message": "preferences payload must be an object"}), 400
        try:
            saved = backend.save_user_preferences(username, payload)
        except ValueError as err:
            return jsonify({"message": str(err)}), 400
        except Exception as err:
            backend.logger.exception(
                "User preferences save failed username=%s clientIp=%s",
                username, get_client_ip(),
            )
            return jsonify({"message": "failed to save preferences", "detail": str(err)}), 500
        if backend.logger.isEnabledFor(10):  # DEBUG
            backend.logger.debug(
                "User preferences saved username=%s keys=%s clientIp=%s",
                username, sorted(saved.keys()), get_client_ip(),
            )
        return jsonify({"preferences": saved}), 200

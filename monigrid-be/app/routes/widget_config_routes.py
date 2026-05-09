"""Widget config endpoints (Phase 2 Step 1).

The "shared" definition of how a data API should be visualised lives here:
display columns and alarm thresholds. Per-user FE state — widget size,
column order, column width — stays in `monigrid_user_preferences`. The
split is intentional: thresholds are organisation policy and must produce
the same alarm signal regardless of whose dashboard is open, while column
order is purely a personal layout choice.

Routes (all auth-required; mutation routes are admin-only):

    GET    /dashboard/widget-configs
        → { configs: [...] }   list every (apiId, widgetType, config)

    GET    /dashboard/widget-configs/<api_id>/<widget_type>
        → 200 { apiId, widgetType, config, updatedAt }
        → 404 if no row

    PUT    /dashboard/widget-configs/<api_id>/<widget_type>
        body: { config: { displayColumns: [...], thresholds: [...] } }
        → 200 { apiId, widgetType, config }
        → 400 on validation failure

    DELETE /dashboard/widget-configs/<api_id>/<widget_type>
        → 204
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import require_admin, require_auth
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:
    @app.route("/dashboard/widget-configs", methods=["GET"])
    @require_auth
    def list_widget_configs():
        try:
            configs = backend.settings_store.list_widget_configs()
        except Exception:
            backend.logger.exception("list_widget_configs failed")
            return jsonify({"message": "widget config query failed"}), 500
        return jsonify({"configs": configs}), 200

    @app.route(
        "/dashboard/widget-configs/<api_id>/<widget_type>",
        methods=["GET"],
    )
    @require_auth
    def get_widget_config(api_id: str, widget_type: str):
        try:
            row = backend.settings_store.get_widget_config(api_id, widget_type)
        except Exception:
            backend.logger.exception(
                "get_widget_config failed apiId=%s widgetType=%s",
                api_id, widget_type,
            )
            return jsonify({"message": "widget config query failed"}), 500
        if row is None:
            return jsonify({"message": "widget config not found"}), 404
        return jsonify(row), 200

    @app.route(
        "/dashboard/widget-configs/<api_id>/<widget_type>",
        methods=["PUT"],
    )
    @require_auth
    @require_admin
    def upsert_widget_config(api_id: str, widget_type: str):
        body = request.get_json(silent=True) or {}
        config = body.get("config")
        if not isinstance(config, dict):
            return jsonify({"message": "body.config must be a JSON object"}), 400
        try:
            stored = backend.settings_store.save_widget_config(
                api_id, widget_type, config,
            )
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception:
            backend.logger.exception(
                "save_widget_config failed apiId=%s widgetType=%s",
                api_id, widget_type,
            )
            return jsonify({"message": "widget config save failed"}), 500
        backend.logger.info(
            "Widget config saved apiId=%s widgetType=%s clientIp=%s",
            api_id, widget_type, get_client_ip(),
        )
        return jsonify(stored), 200

    @app.route(
        "/dashboard/widget-configs/<api_id>/<widget_type>",
        methods=["DELETE"],
    )
    @require_auth
    @require_admin
    def delete_widget_config(api_id: str, widget_type: str):
        try:
            backend.settings_store.delete_widget_config(api_id, widget_type)
        except Exception:
            backend.logger.exception(
                "delete_widget_config failed apiId=%s widgetType=%s",
                api_id, widget_type,
            )
            return jsonify({"message": "widget config delete failed"}), 500
        backend.logger.info(
            "Widget config deleted apiId=%s widgetType=%s clientIp=%s",
            api_id, widget_type, get_client_ip(),
        )
        return ("", 204)

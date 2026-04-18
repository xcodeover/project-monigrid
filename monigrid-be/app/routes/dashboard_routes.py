"""Dashboard endpoints: endpoint listing, cache, sql-editor, db-health, config."""
from __future__ import annotations

import json

from flask import jsonify, request

from app.auth import require_admin, require_auth, verify_jwt_token
from app.exceptions import SqlFileNotFoundError
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:

    @app.route("/dashboard/endpoints", methods=["GET"])
    @require_auth
    def dashboard_endpoints():
        return jsonify(backend.list_endpoints()), 200

    @app.route("/dashboard/sql-editor/endpoints", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_endpoints():
        return jsonify(backend.list_sql_editable_endpoints()), 200

    @app.route("/dashboard/cache/status", methods=["GET"])
    @require_auth
    def dashboard_cache_status():
        """Return per-endpoint cache health: refresh time, duration, row count, errors."""
        snapshot = backend.snapshot_cache_entries()

        entries = []
        for api_id, entry in snapshot.items():
            conn = backend.config.connections.get(entry.connection_id)
            entries.append({
                "apiId":                entry.api_id,
                "path":                 entry.path,
                "connectionId":         entry.connection_id,
                "dbType":               conn.db_type if conn else "unknown",
                "hasData":              entry.data is not None,
                "rowCount":             len(entry.data) if isinstance(entry.data, list) else (1 if entry.data is not None else 0),
                "updatedAt":            entry.updated_at,
                "lastRefreshStartedAt": entry.last_refresh_started_at,
                "lastDurationSec":      entry.last_duration_sec,
                "errorMessage":         entry.error_message,
                "errorDetail":          entry.error_detail,
                "isTimeout":            entry.is_timeout,
                "source":               entry.source,
            })

        healthy = sum(1 for e in entries if e["hasData"])
        return jsonify({
            "endpoints":    entries,
            "totalCount":   len(entries),
            "healthyCount": healthy,
        }), 200

    @app.route("/dashboard/sql-editor/validation-rules", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_validation_rules():
        return jsonify(backend.get_sql_validation_rules()), 200

    @app.route("/dashboard/sql-editor/<api_id>", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_get(api_id: str):
        try:
            payload = backend.get_sql_for_api(api_id)
        except KeyError:
            return jsonify({"message": "enabled api not found"}), 404
        except SqlFileNotFoundError as error:
            return jsonify({"message": str(error), "detail": error.sql_path}), 404
        return jsonify(payload), 200

    @app.route("/dashboard/sql-editor/files", methods=["GET"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_list_files():
        return jsonify({"files": backend.list_sql_files()}), 200

    @app.route("/dashboard/sql-editor/files", methods=["POST"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_create_file():
        """Create (or overwrite) a standalone SQL file at <sql_dir>/<sqlId>.sql.

        JSON body:
          sqlId     — required, [A-Za-z0-9_-]{1,64}
          sql       — required, SELECT-only SQL body
          overwrite — optional bool (default true)
        """
        body = request.get_json(silent=True) or {}
        sql_id = str(body.get("sqlId") or "").strip()
        sql_text = body.get("sql")
        overwrite = bool(body.get("overwrite", True))

        client_ip = get_client_ip()
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        token_payload = verify_jwt_token(token) or {}
        actor = str(token_payload.get("username", "unknown"))

        try:
            result = backend.create_sql_file(
                sql_id, str(sql_text or ""), actor, client_ip, overwrite=overwrite,
            )
        except ValueError as error:
            return jsonify({"message": str(error)}), 400
        except FileExistsError as error:
            return jsonify({
                "message": "sql file already exists",
                "detail": str(error),
            }), 409
        return jsonify(result), 201 if result.get("created") else 200

    @app.route("/dashboard/sql-editor/<api_id>", methods=["PUT"])
    @require_auth
    @require_admin
    def dashboard_sql_editor_update(api_id: str):
        request_json = request.get_json(silent=True) or {}
        sql = request_json.get("sql")
        client_ip = get_client_ip()
        auth_header = request.headers.get("Authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        token_payload = verify_jwt_token(token) or {}
        actor = str(token_payload.get("username", "unknown"))

        try:
            result = backend.update_sql_for_api(api_id, str(sql or ""), actor, client_ip)
        except KeyError:
            return jsonify({"message": "enabled api not found"}), 404
        except SqlFileNotFoundError as error:
            return jsonify({"message": str(error), "detail": error.sql_path}), 404
        except ValueError as error:
            return jsonify({"message": str(error)}), 400
        return jsonify(result), 200

    @app.route("/dashboard/db-health/connections", methods=["GET"])
    @require_auth
    def db_health_connections():
        """Return the list of configured DB connections (id, dbType, jdbcUrl)."""
        return jsonify({"connections": backend.list_db_connections()}), 200

    @app.route("/dashboard/db-health/status", methods=["GET"])
    @require_auth
    def db_health_status():
        """Execute a diagnostic query for the given connection and category.

        Query params:
          connection_id  — required
          category       — required: slow_queries | tablespace | locks
          timeout_sec    — optional (default 10, max 60)
        """
        connection_id = (request.args.get("connection_id") or "").strip()
        category = (request.args.get("category") or "").strip()
        if not connection_id:
            return jsonify({"message": "connection_id is required"}), 400
        if category not in ("slow_queries", "tablespace", "locks"):
            return jsonify({"message": "category must be one of: slow_queries, tablespace, locks"}), 400
        try:
            timeout_sec = float(request.args.get("timeout_sec", "10"))
            timeout_sec = max(1.0, min(60.0, timeout_sec))
        except (TypeError, ValueError):
            timeout_sec = 10.0

        result = backend.get_db_health_data(connection_id, category, timeout_sec)
        return jsonify(result), 200

    @app.route("/dashboard/config", methods=["GET", "PUT"])
    @require_auth
    @require_admin
    def handle_config():
        """GET: return config.json content. PUT: write config.json and reload."""
        if request.method == "GET":
            config_path = backend.config_path
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    config_data = json.load(f)
                return jsonify(config_data), 200
            except FileNotFoundError:
                return jsonify({"message": "config.json not found"}), 404
            except Exception as e:
                return jsonify({"message": "failed to read config", "detail": str(e)}), 500

        # PUT
        client_ip = get_client_ip()
        config_data = request.get_json(silent=True)
        if not config_data or not isinstance(config_data, dict):
            return jsonify({"message": "invalid config JSON"}), 400

        config_path = backend.config_path
        try:
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump(config_data, f, indent=4, ensure_ascii=False)
            backend.logger.info("Config file updated by admin clientIp=%s", client_ip)
        except Exception as e:
            backend.logger.exception("Config write failed clientIp=%s", client_ip)
            return jsonify({"message": "failed to write config", "detail": str(e)}), 500

        try:
            backend.reload()
        except Exception as e:
            backend.logger.exception("Config reload after update failed clientIp=%s", client_ip)
            return jsonify({
                "message": "config saved but reload failed",
                "detail": str(e),
                "saved": True,
                "reloaded": False,
            }), 500

        backend.logger.info("Config updated and reloaded successfully clientIp=%s", client_ip)
        enabled_apis = [ep for ep in backend.config.apis.values() if ep.enabled]
        return jsonify({
            "message": "config updated and reloaded",
            "saved": True,
            "reloaded": True,
            "endpointCount": len(enabled_apis),
            "connectionCount": len(backend.config.connections),
        }), 200

    @app.route("/dashboard/reload-config", methods=["POST"])
    @require_auth
    def reload_config():
        client_ip = get_client_ip()
        try:
            backend.reload()
        except Exception:
            backend.logger.exception("Config reload failed clientIp=%s", client_ip)
            return jsonify({"message": "config reload failed", "detail": "internal error"}), 500
        backend.logger.info("Config reload success clientIp=%s", client_ip)
        return jsonify({"message": "config reloaded", "endpointCount": len(backend.config.apis)}), 200

    @app.route("/dashboard/cache/refresh", methods=["POST"])
    @require_auth
    def refresh_cached_endpoint():
        request_json = request.get_json(silent=True) or {}
        api_id = request_json.get("api_id")
        endpoint_value = request_json.get("endpoint")
        reset_connection = bool(request_json.get("reset_connection", False))
        client_ip = get_client_ip()

        endpoint = backend.resolve_endpoint_reference(
            api_id=str(api_id).strip() if api_id else None,
            endpoint_value=str(endpoint_value).strip() if endpoint_value else None,
        )

        if endpoint is None and (api_id or endpoint_value):
            return jsonify({"message": "enabled api not found"}), 404

        if endpoint is None:
            entries = backend.refresh_all_endpoint_caches(
                source="manual-refresh-all", client_ip=client_ip, reset_connection=reset_connection,
            )
            return jsonify({
                "message": "cache refresh completed",
                "refreshedCount": len(entries),
                "results": [
                    {"apiId": e.api_id, "path": e.path, "ok": e.data is not None,
                     "message": e.error_message, "detail": e.error_detail}
                    for e in entries
                ],
            }), 200

        entry = backend.refresh_endpoint_cache(
            endpoint, source="manual-refresh", client_ip=client_ip, reset_connection=reset_connection,
        )
        return jsonify({
            "message": "cache refresh completed",
            "apiId": entry.api_id,
            "path": entry.path,
            "ok": entry.data is not None,
            "errorMessage": entry.error_message,
            "errorDetail": entry.error_detail,
            "updatedAt": entry.updated_at,
            "durationSec": entry.last_duration_sec,
        }), 200

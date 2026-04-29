"""Dynamic catch-all endpoint that maps an arbitrary URL path to a
configured API endpoint and returns its cached response.

This handler MUST be registered last so it does not shadow any explicit
route. It also explicitly excludes the dashboard/auth/health/logs prefixes
to avoid intercepting requests handled by other route modules.
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import require_auth
from app.exceptions import CachedEndpointError, SqlFileNotFoundError
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/", defaults={"requested_path": ""}, methods=["GET"])
    @app.route("/<path:requested_path>", methods=["GET"])
    @require_auth
    @limiter.limit(rl.dynamic_endpoint)
    def execute_endpoint(requested_path: str):
        client_ip = get_client_ip()

        if not requested_path:
            backend.logger.error("API routing failed reason=empty_path clientIp=%s", client_ip)
            return jsonify({"message": "endpoint not found"}), 404

        # Skip paths handled by explicit route handlers (dashboard, auth, etc.)
        if requested_path.startswith(("dashboard/", "auth/", "health", "logs")):
            return jsonify({"message": "endpoint not found"}), 404

        endpoint = backend.get_endpoint_by_path(f"/{requested_path}")
        if endpoint is None:
            backend.logger.error(
                "API routing failed reason=unknown_path path=/%s clientIp=%s", requested_path, client_ip,
            )
            return jsonify({"message": "endpoint not found"}), 404

        # ?fresh=1 → 캐시를 우회하고 즉시 쿼리를 재실행한다.
        # 알람 판정처럼 실시간성이 필요한 호출에서 사용 (criteria 기반 알람 등).
        fresh_param = request.args.get("fresh", "").strip().lower()
        bypass_cache = fresh_param in ("1", "true", "yes")

        try:
            if bypass_cache:
                entry = backend.refresh_endpoint_cache(
                    endpoint, source="on-demand-fresh", client_ip=client_ip,
                )
                if entry.data is None:
                    raise CachedEndpointError(
                        endpoint.api_id,
                        entry.error_message or "Internal Server Error",
                        detail=entry.error_detail,
                        is_timeout=entry.is_timeout,
                    )
                data = entry.data
            else:
                data = backend.get_cached_endpoint_response(endpoint, client_ip)
        except SqlFileNotFoundError as error:
            return jsonify({
                "message": str(error), "apiId": endpoint.api_id, "detail": f"expectedPath: {error.sql_path}",
            }), 404
        except CachedEndpointError as error:
            return jsonify({
                "message": error.message, "apiId": endpoint.api_id, "detail": error.detail,
            }), 500
        except Exception:
            # str(error) often contains JDBC driver stack frames or SQL state
            # that exposes the schema. Log it server-side and return a
            # generic detail to the client.
            backend.logger.exception(
                "Dynamic endpoint failed apiId=%s path=/%s clientIp=%s",
                endpoint.api_id, requested_path, client_ip,
            )
            return jsonify({
                "message": "query execution failed",
                "apiId": endpoint.api_id,
                "detail": "internal error",
            }), 500

        return jsonify(data), 200

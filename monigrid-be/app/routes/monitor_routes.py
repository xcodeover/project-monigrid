"""Monitor target endpoints.

Admins manage the target catalog (what to probe); every authenticated
user reads the latest in-memory snapshot. This moves the per-widget
polling load off the browser and onto a single shared BE scheduler.
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import require_admin, require_auth
from app.monitor_collector_manager import snapshot_to_dict
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:

    @app.route("/dashboard/monitor-targets", methods=["GET"])
    @require_auth
    def list_monitor_targets():
        """Return the catalog of registered monitor targets.

        Credentials in `spec` (password/secret/token) are masked for
        non-admin callers; admins get the raw spec so they can edit it.
        """
        is_admin_caller = _is_admin(request)
        targets = backend.list_monitor_targets()
        if not is_admin_caller:
            targets = [_mask_spec(t) for t in targets]
        return jsonify({"targets": targets}), 200

    @app.route("/dashboard/monitor-targets", methods=["POST"])
    @require_auth
    @require_admin
    def create_monitor_target():
        body = request.get_json(silent=True) or {}
        try:
            stored = backend.upsert_monitor_target(body)
        except ValueError as err:
            return jsonify({"message": str(err)}), 400
        except Exception as err:
            backend.logger.exception(
                "Monitor target upsert failed clientIp=%s", get_client_ip(),
            )
            return jsonify({"message": "failed to save monitor target", "detail": str(err)}), 500
        backend.logger.info(
            "Monitor target created id=%s type=%s clientIp=%s",
            stored["id"], stored["type"], get_client_ip(),
        )
        return jsonify(stored), 201

    @app.route("/dashboard/monitor-targets/<target_id>", methods=["PUT"])
    @require_auth
    @require_admin
    def update_monitor_target(target_id: str):
        body = request.get_json(silent=True) or {}
        body["id"] = target_id
        try:
            stored = backend.upsert_monitor_target(body)
        except ValueError as err:
            return jsonify({"message": str(err)}), 400
        except Exception as err:
            backend.logger.exception(
                "Monitor target update failed id=%s clientIp=%s", target_id, get_client_ip(),
            )
            return jsonify({"message": "failed to update monitor target", "detail": str(err)}), 500
        backend.logger.info(
            "Monitor target updated id=%s type=%s clientIp=%s",
            stored["id"], stored["type"], get_client_ip(),
        )
        return jsonify(stored), 200

    @app.route("/dashboard/monitor-targets/<target_id>", methods=["DELETE"])
    @require_auth
    @require_admin
    def delete_monitor_target(target_id: str):
        try:
            backend.delete_monitor_target(target_id)
        except Exception as err:
            backend.logger.exception(
                "Monitor target delete failed id=%s clientIp=%s", target_id, get_client_ip(),
            )
            return jsonify({"message": "failed to delete monitor target", "detail": str(err)}), 500
        backend.logger.info(
            "Monitor target deleted id=%s clientIp=%s", target_id, get_client_ip(),
        )
        return jsonify({"message": "monitor target deleted", "id": target_id}), 200

    @app.route("/dashboard/monitor-snapshot", methods=["GET"])
    @require_auth
    def monitor_snapshot():
        """Return latest collected data for the requested targets.

        Query params:
          ids — comma-separated target ids (optional; omit for all)
        """
        ids_param = (request.args.get("ids") or "").strip()
        snapshots = backend.snapshot_monitor_entries()

        if ids_param:
            wanted = {s for s in (p.strip() for p in ids_param.split(",")) if s}
            items = [snapshots[t] for t in wanted if t in snapshots]
        else:
            items = list(snapshots.values())

        return jsonify({
            "items": [snapshot_to_dict(s) for s in items],
            "totalCount": len(items),
        }), 200

    @app.route("/dashboard/monitor-snapshot/<target_id>/refresh", methods=["POST"])
    @require_auth
    def refresh_monitor_target(target_id: str):
        snapshot = backend.refresh_monitor_target(target_id)
        if snapshot is None:
            return jsonify({"message": "monitor target not found"}), 404
        return jsonify(snapshot_to_dict(snapshot)), 200


def _is_admin(req) -> bool:
    from app.auth import verify_jwt_token, is_admin_username

    auth_header = req.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False
    payload = verify_jwt_token(auth_header[7:]) or {}
    return payload.get("role") == "admin" or is_admin_username(str(payload.get("username", "")))


def _mask_spec(target: dict) -> dict:
    from app.monitor_collector_manager import _redact_spec

    return {**target, "spec": _redact_spec(target.get("spec") or {})}

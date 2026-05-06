"""Monitor target endpoints.

Admins manage the target catalog (what to probe); every authenticated
user reads the latest in-memory snapshot. This moves the per-widget
polling load off the browser and onto a single shared BE scheduler.
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import caller_is_admin, require_admin, require_auth
from app.monitor_collector_manager import snapshot_to_dict
from app.utils import get_client_ip


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/dashboard/monitor-targets", methods=["GET"])
    @require_auth
    def list_monitor_targets():
        """Return the catalog of registered monitor targets.

        Credentials in `spec` (password/secret/token) are masked for
        non-admin callers; admins get the raw spec so they can edit it.
        """
        targets = backend.list_monitor_targets()
        if not caller_is_admin():
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
            return jsonify({"message": "failed to save monitor target"}), 500
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
            return jsonify({"message": "failed to update monitor target"}), 500
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
            return jsonify({"message": "failed to delete monitor target"}), 500
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
    @limiter.limit(rl.monitor_refresh)
    @require_admin
    def refresh_monitor_target(target_id: str):
        # Rate limit: 동일 IP/admin 의 연타 시 Flask request thread 가 SSH/HTTP/WMI
        # probe 응답을 기다리며 점거됨 (refresh 는 background pool 이 아닌 request
        # thread 에서 동기 실행). 분당 10회로 제한해 worker 고갈 방지.
        snapshot = backend.refresh_monitor_target(target_id)
        if snapshot is None:
            return jsonify({"message": "monitor target not found"}), 404
        return jsonify(snapshot_to_dict(snapshot)), 200

    @app.route("/dashboard/monitor-targets/batch", methods=["POST"])
    @require_auth
    @limiter.limit(rl.monitor_targets_batch)
    @require_admin
    def apply_monitor_targets_batch_route():
        body = request.get_json(silent=True) or {}
        creates = body.get("creates") or []
        updates = body.get("updates") or []
        deletes = body.get("deletes") or []

        if not isinstance(creates, list) or not isinstance(updates, list) or not isinstance(deletes, list):
            return jsonify({
                "success": False,
                "error": "creates, updates, deletes must be arrays",
                "failedItem": {"kind": "unknown", "index": -1, "id": None, "message": "invalid request shape"},
            }), 400

        # Empty batch → no-op (don't trigger reload for nothing)
        if not creates and not updates and not deletes:
            return jsonify({
                "success": True,
                "results": {"created": [], "updated": [], "deleted": []},
                "reloadTriggered": False,
            }), 200

        try:
            result = backend.apply_monitor_targets_batch(
                creates=creates, updates=updates, deletes=deletes,
            )
        except Exception as exc:
            backend.logger.exception(
                "Monitor targets batch failed clientIp=%s", get_client_ip(),
            )
            return jsonify({
                "success": False,
                "error": "internal error",
                "failedItem": {"kind": "unknown", "index": -1, "id": None, "message": str(exc)},
            }), 500

        if result.get("success"):
            # Phase 5B: nuclear reload 제거 → reloadTriggered 는 의미 없지만
            # FE 호환성 위해 유지 (admin manual 의 5-5 절 참조).
            result["reloadTriggered"] = True
            backend.logger.info(
                "Monitor targets batch applied creates=%d updates=%d deletes=%d "
                "applied=%d errors=%d clientIp=%s",
                len(creates), len(updates), len(deletes),
                len(result.get("applied", [])), len(result.get("errors", [])),
                get_client_ip(),
            )
            status_code = 207 if result.get("errors") else 200
            return jsonify(result), status_code
        else:
            backend.logger.warning(
                "Monitor targets batch rejected error=%s clientIp=%s",
                result.get("error"), get_client_ip(),
            )
            return jsonify(result), 400


def _mask_spec(target: dict) -> dict:
    from app.monitor_collector_manager import _redact_spec

    return {**target, "spec": _redact_spec(target.get("spec") or {})}

"""Admin-only user account management.

Creates / lists / updates / deletes `monigrid_users` rows. All handlers
sit behind `require_admin`. Passwords are hashed via bcrypt before being
persisted; raw hashes are never returned in API responses.

Self-protection: an admin cannot delete their own account, demote
themselves out of `admin`, or disable themselves. Those actions are
refused with 400 so a single fat-finger can't lock everyone out.
"""
from __future__ import annotations

from flask import jsonify, request

from app.auth import current_username, hash_password, require_admin
from app.utils import get_client_ip


_VALID_ROLES = ("admin", "user")

# Length caps protect the storage layer (column widths) and the bcrypt step
# (every byte over the per-call 72-byte limit is silently dropped, so
# accepting megabyte-sized passwords just wastes CPU on hash work that
# doesn't add security).
_MAX_USERNAME_LEN = 128
_MAX_PASSWORD_LEN = 256
_MAX_DISPLAY_NAME_LEN = 256


def _parse_body() -> dict:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def _public_user(user: dict) -> dict:
    """Strip any sensitive fields before returning to FE (defensive — the
    settings_store row shape already excludes password_hash)."""
    return {k: v for k, v in user.items() if k != "password_hash"}


def _validate_username(value: str) -> tuple[bool, str]:
    if not value:
        return False, "username is required"
    if len(value) > _MAX_USERNAME_LEN:
        return False, f"username must be {_MAX_USERNAME_LEN} characters or fewer"
    return True, ""


def _validate_password(value: str) -> tuple[bool, str]:
    if not value:
        return False, "password is required"
    if len(value) > _MAX_PASSWORD_LEN:
        return False, f"password must be {_MAX_PASSWORD_LEN} characters or fewer"
    return True, ""


def _validate_display_name(value) -> tuple[bool, str]:
    if value is None:
        return True, ""
    if not isinstance(value, str):
        return False, "display_name must be a string"
    if len(value) > _MAX_DISPLAY_NAME_LEN:
        return False, f"display_name must be {_MAX_DISPLAY_NAME_LEN} characters or fewer"
    return True, ""


def register(app, backend, limiter) -> None:

    @app.route("/admin/users", methods=["GET"])
    @require_admin
    def list_users():
        try:
            users = backend.list_users()
        except Exception as err:
            backend.logger.exception("List users failed clientIp=%s", get_client_ip())
            # str(err) can leak driver/SQL state; route detail to logs only.
            return jsonify({"message": "failed to list users"}), 500
        return jsonify({"users": [_public_user(u) for u in users]}), 200

    @app.route("/admin/users", methods=["POST"])
    @require_admin
    def create_user():
        body = _parse_body()
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        role = str(body.get("role") or "user").strip().lower()
        display_name = body.get("display_name")
        enabled = bool(body.get("enabled", True))

        ok, msg = _validate_username(username)
        if not ok:
            return jsonify({"message": msg}), 400
        ok, msg = _validate_password(password)
        if not ok:
            return jsonify({"message": msg}), 400
        if role not in _VALID_ROLES:
            return jsonify({"message": f"role must be one of {_VALID_ROLES}"}), 400
        ok, msg = _validate_display_name(display_name)
        if not ok:
            return jsonify({"message": msg}), 400

        try:
            created = backend.create_user(
                username=username,
                password_hash=hash_password(password),
                role=role,
                display_name=display_name,
                enabled=enabled,
            )
        except ValueError as err:
            return jsonify({"message": str(err)}), 400
        except Exception as err:
            backend.logger.exception(
                "Create user failed username=%s clientIp=%s", username, get_client_ip(),
            )
            return jsonify({"message": "failed to create user"}), 500

        backend.logger.info(
            "User created username=%s role=%s by=%s clientIp=%s",
            created.get("username"), created.get("role"),
            current_username(), get_client_ip(),
        )
        return jsonify({"user": _public_user(created)}), 201

    @app.route("/admin/users/<username>", methods=["PUT"])
    @require_admin
    def update_user(username: str):
        body = _parse_body()
        target = (username or "").strip().lower()
        caller = (current_username() or "").strip().lower()

        existing = backend.get_user(target)
        if existing is None:
            return jsonify({"message": "user not found"}), 404

        kwargs: dict = {}
        if "password" in body:
            pw = str(body.get("password") or "")
            ok, msg = _validate_password(pw)
            if not ok:
                return jsonify({"message": msg}), 400
            kwargs["password_hash"] = hash_password(pw)
        if "role" in body:
            role = str(body.get("role") or "").strip().lower()
            if role not in _VALID_ROLES:
                return jsonify({"message": f"role must be one of {_VALID_ROLES}"}), 400
            if target == caller and role != "admin":
                return jsonify({"message": "admins cannot demote themselves"}), 400
            kwargs["role"] = role
        if "display_name" in body:
            ok, msg = _validate_display_name(body.get("display_name"))
            if not ok:
                return jsonify({"message": msg}), 400
            kwargs["display_name"] = body.get("display_name")
        if "enabled" in body:
            enabled_value = bool(body.get("enabled"))
            if target == caller and not enabled_value:
                return jsonify({"message": "admins cannot disable themselves"}), 400
            kwargs["enabled"] = enabled_value

        try:
            updated = backend.update_user(target, **kwargs)
        except ValueError as err:
            return jsonify({"message": str(err)}), 400
        except Exception as err:
            backend.logger.exception(
                "Update user failed username=%s clientIp=%s", target, get_client_ip(),
            )
            return jsonify({"message": "failed to update user"}), 500

        backend.logger.info(
            "User updated username=%s fields=%s by=%s clientIp=%s",
            target, sorted(kwargs.keys()), caller, get_client_ip(),
        )
        return jsonify({"user": _public_user(updated)}), 200

    @app.route("/admin/users/<username>", methods=["DELETE"])
    @require_admin
    def delete_user(username: str):
        target = (username or "").strip().lower()
        caller = (current_username() or "").strip().lower()
        if target == caller:
            return jsonify({"message": "admins cannot delete themselves"}), 400
        existing = backend.get_user(target)
        if existing is None:
            return jsonify({"message": "user not found"}), 404
        try:
            backend.delete_user(target)
        except Exception as err:
            backend.logger.exception(
                "Delete user failed username=%s clientIp=%s", target, get_client_ip(),
            )
            return jsonify({"message": "failed to delete user"}), 500
        backend.logger.info(
            "User deleted username=%s by=%s clientIp=%s",
            target, caller, get_client_ip(),
        )
        return jsonify({"message": "deleted"}), 200

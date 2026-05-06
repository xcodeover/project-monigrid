"""Authentication endpoints (login / logout)."""
from __future__ import annotations

from flask import jsonify, request
from pydantic import ValidationError

from app.auth import (
    LoginRequest,
    create_jwt_token,
    is_admin_username,
    require_auth,
    verify_login_credentials,
    verify_password,
)
from app.utils import get_client_ip, get_env


def _env_admin_credentials(backend) -> tuple[str, str]:
    expected_username = (get_env("AUTH_USERNAME", "") or "").strip() or backend.config.auth_username
    expected_password = (get_env("AUTH_PASSWORD", "") or "").strip() or backend.config.auth_password
    return expected_username, expected_password


def _authenticate(backend, username: str, password: str) -> tuple[str, str] | None:
    """Return (username, role) on success, else None.

    DB-first: if an enabled user matches the given username, verify the
    stored bcrypt hash. If no admin user exists in the DB yet the env /
    config admin is honored as a bootstrap credential so operators can
    reach the FE before the first real account is provisioned.
    """
    creds = backend.get_user_credentials(username)
    if creds is not None:
        password_hash, role, enabled = creds
        if enabled and verify_password(password, password_hash):
            return username, role
        return None

    # No DB row for this username — allow env bootstrap only while no
    # admin user has been created yet. Otherwise the env creds must not
    # override the DB.
    if backend.has_admin_user():
        return None

    env_username, env_password = _env_admin_credentials(backend)
    if not env_username or not env_password:
        return None
    if verify_login_credentials(username, password, env_username, env_password):
        return username, "admin"
    return None


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/auth/login", methods=["POST"])
    @limiter.limit(rl.auth_login)
    def auth_login():
        try:
            payload = LoginRequest(**request.get_json(silent=True) or {})
        except ValidationError as e:
            return jsonify({"message": "Invalid request", "errors": e.errors()}), 400

        username = payload.username
        client_ip = get_client_ip()

        backend.logger.info("Login attempt username=%s clientIp=%s", username, client_ip)

        result = _authenticate(backend, username, payload.password)
        if result is None:
            backend.logger.warning(
                "Login failed username=%s reason=invalid_credentials clientIp=%s", username, client_ip,
            )
            return jsonify({"message": "Invalid username or password"}), 401

        authed_username, role = result
        # Admin-username shortcut still applies so AUTH_USERNAME-based
        # bootstraps stay recognized as admin even if role came back as
        # "user" from some edge case.
        effective_role = "admin" if role == "admin" or is_admin_username(authed_username) else "user"

        backend.logger.info(
            "Login success username=%s role=%s clientIp=%s",
            authed_username, effective_role, client_ip,
        )
        return jsonify({
            "token": create_jwt_token(authed_username, role=effective_role),
            "user": {
                "id": 1,
                "username": authed_username,
                "role": effective_role,
            },
        }), 200

    @app.route("/auth/logout", methods=["POST"])
    @require_auth
    def auth_logout():
        backend.logger.info("Logout success clientIp=%s", get_client_ip())
        # I-4: 다른 모든 응답이 영어이므로 일관성 위해 영어로 통일.
        # FE 가 message 를 사용자에게 그대로 노출하지 않으므로 i18n 영향 없음.
        return jsonify({"message": "Logged out"}), 200

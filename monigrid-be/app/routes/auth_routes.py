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
)
from app.utils import get_client_ip, get_env


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
        expected_username = (get_env("AUTH_USERNAME", "") or "").strip() or backend.config.auth_username
        expected_password = (get_env("AUTH_PASSWORD", "") or "").strip() or backend.config.auth_password

        backend.logger.info("Login attempt username=%s clientIp=%s", username, client_ip)

        if not verify_login_credentials(payload.username, payload.password, expected_username, expected_password):
            backend.logger.warning(
                "Login failed username=%s reason=invalid_credentials clientIp=%s", username, client_ip,
            )
            return jsonify({"message": "Invalid username or password"}), 401

        backend.logger.info("Login success username=%s clientIp=%s", username, client_ip)
        return jsonify({
            "token": create_jwt_token(username),
            "user": {
                "id": 1,
                "username": username,
                "role": "admin" if is_admin_username(username) else "user",
            },
        }), 200

    @app.route("/auth/logout", methods=["POST"])
    @require_auth
    def auth_logout():
        backend.logger.info("Logout success clientIp=%s", get_client_ip())
        return jsonify({"message": "로그아웃 되었습니다"}), 200

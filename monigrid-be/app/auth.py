"""Authentication: JWT token management and credential verification."""
from __future__ import annotations

import hmac
import logging
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Callable

import bcrypt
import jwt
from flask import jsonify, request
from pydantic import BaseModel, validator

from .utils import get_client_ip, get_env

# RFC 7518 §3.2: HS256 키는 최소 32바이트 이상이어야 함.
# .env에 JWT_SECRET_KEY가 설정되지 않은 경우를 대비해 32바이트 이상의 기본값을 둔다.
# (운영 환경에서는 반드시 .env에서 무작위 값으로 교체할 것)
_DEFAULT_JWT_SECRET = "monigrid-default-secret-key-change-me-in-production-32b+"
_MIN_JWT_KEY_BYTES = 32
_jwt_key_warned = False


def _resolve_jwt_secret() -> str:
    global _jwt_key_warned
    secret = get_env("JWT_SECRET_KEY", _DEFAULT_JWT_SECRET) or _DEFAULT_JWT_SECRET
    if len(secret.encode("utf-8")) < _MIN_JWT_KEY_BYTES:
        # 보안 경고: 32바이트 미만 키는 HS256에 부적합. 기본값으로 대체한다.
        if not _jwt_key_warned:
            logging.getLogger("monitoring_backend").warning(
                "JWT_SECRET_KEY is shorter than %d bytes; falling back to a safe default. "
                "Set a strong JWT_SECRET_KEY in .env for production.",
                _MIN_JWT_KEY_BYTES,
            )
            _jwt_key_warned = True
        secret = _DEFAULT_JWT_SECRET
    return secret


def get_admin_username() -> str:
    return (get_env("ADMIN_USERNAME", "admin") or "admin").strip() or "admin"


def is_admin_username(username: str) -> bool:
    return (username or "").strip().lower() == get_admin_username().lower()


def create_jwt_token(username: str, hours: int = 24, *, role: str | None = None) -> str:
    resolved_role = (role or ("admin" if is_admin_username(username) else "user")).strip().lower()
    payload = {
        "username": username,
        "role": resolved_role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=hours),
        "iat": datetime.now(timezone.utc),
    }
    secret = _resolve_jwt_secret()
    algo = get_env("JWT_ALGORITHM", "HS256")
    return jwt.encode(payload, secret, algorithm=algo)


def hash_password(password: str) -> str:
    """Return a bcrypt hash of the given password (UTF-8 encoded).

    Cost factor 12 is a reasonable balance for 2026-class hardware —
    ~200ms/hash on a laptop, cheap enough not to block the API yet
    expensive enough to slow down offline cracking.
    """
    if not password:
        raise ValueError("password must not be empty")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    if not password or not password_hash:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def verify_jwt_token(token: str) -> dict | None:
    try:
        secret = _resolve_jwt_secret()
        algo = get_env("JWT_ALGORITHM", "HS256")
        return jwt.decode(token, secret, algorithms=[algo])
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None


def current_username() -> str:
    """Return the JWT `username` claim of the active request, or "".

    Call only from handlers behind @require_auth — the decorator has
    already validated the token, so we can re-parse it cheaply to
    recover the claim without threading it through flask.g.
    """
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return ""
    payload = verify_jwt_token(header[7:]) or {}
    return str(payload.get("username") or "")


def caller_is_admin() -> bool:
    """Return True if the active request's JWT identifies an admin caller.

    Use this when an endpoint must remain accessible to regular users but
    needs to branch on role (e.g. masking sensitive fields, refusing
    privileged sub-operations). Routes that are admin-only should still
    use the @require_admin decorator instead — this helper is for the
    handful of cases where the route itself is mixed-role.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return False
    payload = verify_jwt_token(auth_header[7:]) or {}
    if str(payload.get("role", "")) == "admin":
        return True
    return is_admin_username(str(payload.get("username", "")))


def verify_login_credentials(
    username: str,
    password: str,
    expected_username: str,
    expected_password: str,
) -> bool:
    return hmac.compare_digest(username, expected_username) and hmac.compare_digest(
        password, expected_password
    )


class LoginRequest(BaseModel):
    username: str
    password: str

    @validator("username", "password")
    def not_empty(cls, v):
        if not v or not str(v).strip():
            raise ValueError("Field cannot be empty")
        return v.strip()


_logger = logging.getLogger("monitoring_backend")


def require_auth(f: Callable) -> Callable:
    """Decorator: rejects requests without a valid Bearer JWT token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            _logger.warning(
                "Auth rejected reason=missing_token path=%s clientIp=%s",
                request.path, get_client_ip(),
            )
            return jsonify({"message": "Missing or invalid authorization"}), 401

        token = auth_header[7:]
        payload = verify_jwt_token(token)
        if not payload:
            _logger.warning(
                "Auth rejected reason=invalid_or_expired_token path=%s clientIp=%s",
                request.path, get_client_ip(),
            )
            return jsonify({"message": "Invalid or expired token"}), 401

        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug(
                "Auth ok username=%s role=%s path=%s clientIp=%s",
                payload.get("username"), payload.get("role"),
                request.path, get_client_ip(),
            )
        return f(*args, **kwargs)
    return decorated


def require_admin(f: Callable) -> Callable:
    """Decorator: rejects requests from non-admin users."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return jsonify({"message": "Missing or invalid authorization"}), 401

        token = auth_header[7:]
        payload = verify_jwt_token(token)
        if not payload:
            return jsonify({"message": "Invalid or expired token"}), 401

        username = str(payload.get("username", ""))
        role = str(payload.get("role", ""))
        if role != "admin" and not is_admin_username(username):
            _logger.warning(
                "Admin check rejected username=%s role=%s path=%s clientIp=%s",
                username, role, request.path, get_client_ip(),
            )
            return jsonify({"message": "Admin privileges are required"}), 403

        if _logger.isEnabledFor(logging.DEBUG):
            _logger.debug(
                "Admin check ok username=%s path=%s clientIp=%s",
                username, request.path, get_client_ip(),
            )
        return f(*args, **kwargs)
    return decorated

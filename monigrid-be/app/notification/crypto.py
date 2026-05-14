"""Symmetric encryption for channel credentials (SMTP password, etc).

The master key comes from `MONIGRID_SECRET_KEY` env (urlsafe base64, 32 bytes).
If the env is missing in non-development, we refuse to start — the same
posture as the JWT secret check (see auth.py H3 patch).

In development with no key, we fall back to a deterministic dev key so
local dev DBs round-trip. NEVER ship that fallback to prod.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from typing import Any

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover — surfaced at first encrypt call
    Fernet = None  # type: ignore[assignment]
    InvalidToken = Exception  # type: ignore[assignment,misc]


_logger = logging.getLogger(__name__)
_DEV_FALLBACK_SEED = b"monigrid-dev-fallback-key-DO-NOT-USE-IN-PROD"


def _resolve_key() -> bytes:
    raw = os.environ.get("MONIGRID_SECRET_KEY")
    if raw:
        # Accept either a urlsafe-base64 32-byte Fernet key or any string we
        # hash down to 32 bytes — the latter is friendlier for ops who paste
        # an arbitrary passphrase.
        try:
            decoded = base64.urlsafe_b64decode(raw.encode("utf-8"))
        except Exception:
            decoded = b""
        if len(decoded) == 32:
            return raw.encode("utf-8")
        digest = hashlib.sha256(raw.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest)

    if os.environ.get("FLASK_ENV") == "development":
        _logger.warning(
            "MONIGRID_SECRET_KEY not set; using a deterministic dev fallback. "
            "Do NOT run this configuration in production."
        )
        digest = hashlib.sha256(_DEV_FALLBACK_SEED).digest()
        return base64.urlsafe_b64encode(digest)

    raise RuntimeError(
        "MONIGRID_SECRET_KEY environment variable must be set outside "
        "FLASK_ENV=development. Use a 32-byte urlsafe-base64 key or any "
        "passphrase (it will be hashed)."
    )


_KEY: bytes | None = None


def _fernet() -> "Fernet":
    if Fernet is None:
        raise RuntimeError(
            "cryptography package is required for notification credential "
            "encryption. Add it to requirements."
        )
    global _KEY
    if _KEY is None:
        _KEY = _resolve_key()
    return Fernet(_KEY)


def encrypt_dict(payload: dict[str, Any]) -> str:
    """Serialize + encrypt a config dict. Output is a urlsafe-ascii string
    suitable for storage in monigrid_notification_channels.config_encrypted."""
    blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return _fernet().encrypt(blob).decode("ascii")


def decrypt_dict(token: str) -> dict[str, Any]:
    """Reverse of encrypt_dict. Raises ValueError on tamper / wrong key."""
    if not token:
        return {}
    try:
        blob = _fernet().decrypt(token.encode("ascii"))
    except InvalidToken as exc:
        raise ValueError(
            "channel config decryption failed (master key changed or data tampered)"
        ) from exc
    return json.loads(blob.decode("utf-8"))

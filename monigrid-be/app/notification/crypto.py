"""Symmetric encryption for channel credentials (SMTP password, etc).

Key resolution (priority order):
  1. ``MONIGRID_SECRET_KEYS`` — comma-separated list of keys for rotation.
     The FIRST key is the active key (used for encrypt). All keys are tried
     in order when decrypting; the first one that succeeds wins. This lets
     operators introduce a new key without breaking previously-encrypted
     payloads — write a new value, redeploy, then later rotate stale rows
     by issuing a save through the API (which re-encrypts with the active
     key).
  2. ``MONIGRID_SECRET_KEY`` — single key. Equivalent to KEYS with one
     element. Kept for backward compatibility with existing .env files.
  3. ``FLASK_ENV=development`` — deterministic dev fallback. NEVER prod.

If neither env var is set outside development we refuse to start.

A key value may be either:
  - a urlsafe-base64 32-byte Fernet key (cryptography's native format), or
  - any passphrase (sha256 → base64) — operator-friendly for arbitrary strings.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from typing import Any

try:
    from cryptography.fernet import Fernet, InvalidToken, MultiFernet
except ImportError:  # pragma: no cover — surfaced at first encrypt call
    Fernet = None  # type: ignore[assignment]
    MultiFernet = None  # type: ignore[assignment]
    InvalidToken = Exception  # type: ignore[assignment,misc]


_logger = logging.getLogger(__name__)
_DEV_FALLBACK_SEED = b"monigrid-dev-fallback-key-DO-NOT-USE-IN-PROD"


def _normalize_key(raw: str) -> bytes:
    """Coerce a raw key string into a 32-byte urlsafe-base64 Fernet key."""
    try:
        decoded = base64.urlsafe_b64decode(raw.encode("utf-8"))
    except Exception:
        decoded = b""
    if len(decoded) == 32:
        return raw.encode("utf-8")
    digest = hashlib.sha256(raw.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _resolve_keys() -> list[bytes]:
    """Return the ordered list of usable Fernet keys.

    First element is the ACTIVE key (used to encrypt). All elements are
    tried in order when decrypting.
    """
    raws: list[str] = []
    multi = os.environ.get("MONIGRID_SECRET_KEYS", "").strip()
    if multi:
        # Comma-separated, trim each, drop blanks. Preserve order — operators
        # explicitly arrange "new,old,older" to control re-encrypt cadence.
        raws = [r.strip() for r in multi.split(",") if r.strip()]
    else:
        single = os.environ.get("MONIGRID_SECRET_KEY", "").strip()
        if single:
            raws = [single]

    if raws:
        return [_normalize_key(r) for r in raws]

    if os.environ.get("FLASK_ENV") == "development":
        _logger.warning(
            "MONIGRID_SECRET_KEY(S) not set; using a deterministic dev fallback. "
            "Do NOT run this configuration in production."
        )
        digest = hashlib.sha256(_DEV_FALLBACK_SEED).digest()
        return [base64.urlsafe_b64encode(digest)]

    raise RuntimeError(
        "MONIGRID_SECRET_KEY or MONIGRID_SECRET_KEYS environment variable must "
        "be set outside FLASK_ENV=development. Use a 32-byte urlsafe-base64 "
        "key, any passphrase (it will be hashed), or a comma-separated list "
        "(first = active, others = decrypt-only for rotation)."
    )


_KEYS: list[bytes] | None = None


def _ensure_loaded() -> None:
    global _KEYS
    if _KEYS is None:
        _KEYS = _resolve_keys()


def _active_fernet() -> "Fernet":
    """Fernet wrapper using the ACTIVE (first) key only — for encrypt."""
    if Fernet is None:
        raise RuntimeError(
            "cryptography package is required for notification credential "
            "encryption. Add it to requirements."
        )
    _ensure_loaded()
    return Fernet(_KEYS[0])


def _multi_fernet() -> "MultiFernet":
    """MultiFernet across all configured keys — for decrypt (rotation)."""
    if Fernet is None or MultiFernet is None:
        raise RuntimeError(
            "cryptography package is required for notification credential "
            "encryption. Add it to requirements."
        )
    _ensure_loaded()
    return MultiFernet([Fernet(k) for k in _KEYS])


def encrypt_dict(payload: dict[str, Any]) -> str:
    """Serialize + encrypt a config dict with the ACTIVE key.

    Output is a urlsafe-ascii string suitable for storage in
    ``monigrid_notification_channels.config_encrypted``.
    """
    blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return _active_fernet().encrypt(blob).decode("ascii")


def decrypt_dict(token: str) -> dict[str, Any]:
    """Reverse of ``encrypt_dict``. Tries each configured key in order
    (active first, then rotation keys).

    Raises ValueError on tamper / wrong key for ALL configured keys.
    Callers MUST surface this — the previous bug (silent overwrite of
    password with empty string in the merge-prior code path) traced to a
    caller that swallowed this exception.
    """
    if not token:
        return {}
    try:
        blob = _multi_fernet().decrypt(token.encode("ascii"))
    except InvalidToken as exc:
        raise ValueError(
            "channel config decryption failed — master key rotated past all "
            "configured keys, or data tampered. Add the previous key to "
            "MONIGRID_SECRET_KEYS (CSV) to recover."
        ) from exc
    return json.loads(blob.decode("utf-8"))

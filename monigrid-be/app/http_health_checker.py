"""Outbound HTTP health-check helper.

Pure helper used by the health-check-proxy endpoints. Performs an HTTP GET
on a target URL and returns a normalised result dict, never raising.

Prefers `requests` when available; falls back to `urllib` so the helper
remains importable in stripped-down environments (test fixtures, etc.).
"""
from __future__ import annotations

import time as _time
import warnings as _warnings
from typing import Any


_BODY_BYTES_LIMIT = 4096


def _empty_failure(elapsed_ms: int, error: str, http_status: int | None = None) -> dict[str, Any]:
    return {
        "ok": False,
        "httpStatus": http_status,
        "responseTimeMs": elapsed_ms,
        "body": None,
        "error": error,
    }


def _check_with_requests(target_url: str, timeout_sec: float) -> dict[str, Any]:
    import requests
    from urllib3.exceptions import InsecureRequestWarning

    started = _time.monotonic()
    try:
        with _warnings.catch_warnings():
            _warnings.filterwarnings("ignore", category=InsecureRequestWarning)
            with requests.get(
                target_url, timeout=timeout_sec, verify=False, allow_redirects=True, stream=False,
            ) as resp:
                elapsed_ms = int((_time.monotonic() - started) * 1000)
                try:
                    body = resp.text[:_BODY_BYTES_LIMIT]
                except Exception:
                    body = None
                status_code = resp.status_code
        return {
            "ok": 200 <= status_code < 400,
            "httpStatus": status_code,
            "responseTimeMs": elapsed_ms,
            "body": body,
            "error": None,
        }
    except Exception as e:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        return _empty_failure(elapsed_ms, str(e))


def _check_with_urllib(target_url: str, timeout_sec: float) -> dict[str, Any]:
    from urllib.request import urlopen, Request
    from urllib.error import HTTPError

    started = _time.monotonic()
    try:
        req = Request(target_url, method="GET")
        with urlopen(req, timeout=timeout_sec) as resp:
            body_bytes = resp.read(_BODY_BYTES_LIMIT)
            elapsed_ms = int((_time.monotonic() - started) * 1000)
            try:
                body = body_bytes.decode("utf-8")
            except Exception:
                body = None
            return {
                "ok": 200 <= resp.status < 400,
                "httpStatus": resp.status,
                "responseTimeMs": elapsed_ms,
                "body": body,
                "error": None,
            }
    except HTTPError as e:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        return _empty_failure(elapsed_ms, str(e), http_status=e.code)
    except Exception as e:
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        return _empty_failure(elapsed_ms, str(e))


def check_http_url(target_url: str, timeout_sec: float = 10.0) -> dict[str, Any]:
    """Probe `target_url` with an HTTP GET and return a normalised result.

    Returns: {ok, httpStatus, responseTimeMs, body, error}
    Never raises.
    """
    try:
        import requests as _requests  # noqa: F401
        return _check_with_requests(target_url, timeout_sec)
    except ImportError:
        return _check_with_urllib(target_url, timeout_sec)

"""Outbound HTTP health-check proxy endpoints (single + batch).

These exist so the frontend can run cross-origin health checks without
hitting browser CORS restrictions. Both endpoints delegate to
`app.http_health_checker.check_http_url`.
"""
from __future__ import annotations

import ipaddress
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

from flask import jsonify, request

from app.auth import require_auth
from app.http_health_checker import check_http_url


# Hard cap on URL length — anything longer is almost certainly an attack
# payload (path-traversal, header injection) rather than a real endpoint.
_MAX_URL_LEN = 2048
_ALLOWED_SCHEMES = frozenset({"http", "https"})

# Operators in tightly-segmented networks can flip this to "1" to refuse
# private/loopback targets entirely (an SSRF defense that's only safe when
# you don't need to monitor anything internal).
_BLOCK_PRIVATE = (os.environ.get("HEALTHCHECK_BLOCK_PRIVATE", "0").strip() == "1")


def _validate_target_url(target_url: str) -> str | None:
    """Return None if URL is acceptable, or a short error string otherwise.

    Always rejects: file://, gopher://, javascript: and similar schemes that
    have no business being proxied through an HTTP-only checker — these
    were the original SSRF vectors. http/https are accepted regardless of
    target host because this is a monitoring tool that legitimately probes
    LAN services; flip HEALTHCHECK_BLOCK_PRIVATE=1 to lock that down.
    """
    if not target_url:
        return "url is required"
    if len(target_url) > _MAX_URL_LEN:
        return f"url is too long (max {_MAX_URL_LEN})"
    try:
        parsed = urlparse(target_url)
    except ValueError:
        return "url is malformed"
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        return "url scheme must be http or https"
    if not parsed.hostname:
        return "url must include a host"
    if _BLOCK_PRIVATE:
        try:
            ip = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            ip = None
        if ip is not None and (ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved):
            return "private or loopback hosts are not allowed"
    return None


def _clamp_timeout(value, default: float = 10.0) -> float:
    try:
        return max(1.0, min(30.0, float(value if value is not None else default)))
    except (TypeError, ValueError):
        return default


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/dashboard/health-check-proxy", methods=["POST"])
    @require_auth
    @limiter.limit(rl.health_check)
    def health_check_proxy():
        """Proxy an HTTP GET to an external URL and return the result.

        JSON body:
          url     — target URL (required)
          timeout — seconds (default 10, clamped 1..30)
        """
        request_json = request.get_json(silent=True) or {}
        target_url = str(request_json.get("url", "")).strip()
        validation_error = _validate_target_url(target_url)
        if validation_error:
            return jsonify({"message": validation_error}), 400
        timeout_sec = _clamp_timeout(request_json.get("timeout"), default=10.0)
        return jsonify(check_http_url(target_url, timeout_sec)), 200

    @app.route("/dashboard/health-check-proxy-batch", methods=["POST"])
    @require_auth
    @limiter.limit(rl.health_check_batch)
    def health_check_proxy_batch():
        """Proxy HTTP GET to multiple external URLs and return all results at once.

        JSON body:
          urls — list of { id, url, timeout }
        """
        body = request.get_json(silent=True) or {}
        urls = body.get("urls") or []
        if not isinstance(urls, list) or len(urls) == 0:
            return jsonify({"message": "urls array is required"}), 400
        if len(urls) > 50:
            return jsonify({"message": "too many urls (max 50)"}), 400

        def _check_one(item):
            target_url = str(item.get("url", "")).strip()
            item_id = item.get("id", target_url)
            validation_error = _validate_target_url(target_url)
            if validation_error:
                return {
                    "id": item_id, "ok": False, "httpStatus": None,
                    "responseTimeMs": 0, "body": None, "error": validation_error,
                }
            timeout_sec = _clamp_timeout(item.get("timeout"), default=10.0)
            result = check_http_url(target_url, timeout_sec)
            result["id"] = item_id
            return result

        max_workers = min(len(urls), 10)
        results = [None] * len(urls)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_to_idx = {
                pool.submit(_check_one, item): idx
                for idx, item in enumerate(urls)
            }
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    results[idx] = future.result()
                except Exception as exc:
                    results[idx] = {
                        "id": urls[idx].get("id", ""),
                        "ok": False, "httpStatus": None,
                        "responseTimeMs": 0, "body": None,
                        "error": str(exc),
                    }

        return jsonify({"results": results}), 200

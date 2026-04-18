"""Outbound HTTP health-check proxy endpoints (single + batch).

These exist so the frontend can run cross-origin health checks without
hitting browser CORS restrictions. Both endpoints delegate to
`app.http_health_checker.check_http_url`.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import jsonify, request

from app.auth import require_auth
from app.http_health_checker import check_http_url


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
        if not target_url:
            return jsonify({"message": "url is required"}), 400
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
            if not target_url:
                return {
                    "id": item_id, "ok": False, "httpStatus": None,
                    "responseTimeMs": 0, "body": None, "error": "url is required",
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

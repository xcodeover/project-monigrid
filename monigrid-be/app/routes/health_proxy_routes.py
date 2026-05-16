"""Outbound HTTP health-check proxy endpoints (single + batch).

These exist so the frontend can run cross-origin health checks without
hitting browser CORS restrictions. Both endpoints delegate to
`app.http_health_checker.check_http_url`.

Security model (SSRF defense):

  1. Always reject non-http(s) schemes.
  2. Always reject cloud metadata endpoints (`169.254.169.254`,
     `metadata.google.internal`, Alibaba's `100.100.100.200`, AWS IPv6
     `fd00:ec2::254`). These are never legitimate monitor targets and
     leaking instance credentials is the highest-impact SSRF outcome.
  3. Always resolve the hostname to its IP(s) BEFORE checking, so an
     attacker who points `evil.example.com` at `169.254.169.254` (or any
     private range) is caught — hostname-only filtering is bypassable.
  4. By default (HEALTHCHECK_BLOCK_PRIVATE=1), reject private / loopback /
     link-local / reserved IPs. Operators who genuinely need to monitor
     internal LAN endpoints must opt out with HEALTHCHECK_BLOCK_PRIVATE=0
     — that escape hatch is preserved.

There is a small TOCTOU window between our DNS resolution and `requests`'
own resolution at connect time (DNS rebinding). Mitigating that requires
patching socket creation, which we defer until it's an observed problem.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

from flask import jsonify, request

from app.auth import require_auth
from app.http_health_checker import check_http_url


_logger = logging.getLogger(__name__)

# Hard cap on URL length — anything longer is almost certainly an attack
# payload (path-traversal, header injection) rather than a real endpoint.
_MAX_URL_LEN = 2048
_ALLOWED_SCHEMES = frozenset({"http", "https"})

# Cloud metadata services across the major providers. Hitting these from a
# server-side fetcher leaks short-lived instance credentials → full account
# compromise. Block unconditionally regardless of HEALTHCHECK_BLOCK_PRIVATE.
_METADATA_HOSTNAMES = frozenset({
    "metadata.google.internal",
    "metadata",  # GCP short form
})
_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),       # AWS / Azure / GCP / OCI / DO / IBM / OpenStack
    ipaddress.ip_address("100.100.100.200"),       # Alibaba Cloud
    ipaddress.ip_address("fd00:ec2::254"),         # AWS IMDSv2 IPv6
})

# Default is "1" (block private) so a fresh install is safe by default.
# Operators who need to monitor internal LAN endpoints must opt OUT with
# HEALTHCHECK_BLOCK_PRIVATE=0. This is a behavior change from the prior
# default of "0"; documented in README §11.3 / ADMIN_MANUAL §13.3.
_BLOCK_PRIVATE = (os.environ.get("HEALTHCHECK_BLOCK_PRIVATE", "1").strip() == "1")

if not _BLOCK_PRIVATE:
    _logger.warning(
        "HEALTHCHECK_BLOCK_PRIVATE=0 — health-check proxy will permit private "
        "/ loopback / link-local targets. Cloud metadata IPs remain blocked. "
        "Confirm this matches your network segmentation policy."
    )


def _resolve_host_ips(hostname: str) -> list[ipaddress._BaseAddress]:
    """Resolve hostname to all IP addresses via getaddrinfo. Returns []
    on resolution failure (caller treats as 'cannot validate' → refuse).
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return []
    out: list[ipaddress._BaseAddress] = []
    seen: set = set()
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        # IPv6 addresses can include zone id (e.g. "fe80::1%eth0") — strip.
        if "%" in ip_str:
            ip_str = ip_str.split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if ip in seen:
            continue
        seen.add(ip)
        out.append(ip)
    return out


def _validate_target_url(target_url: str) -> str | None:
    """Return None if URL is acceptable, or a short error string otherwise."""
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
    hostname = parsed.hostname
    if not hostname:
        return "url must include a host"

    # 1) Metadata hostnames are never legitimate.
    if hostname.lower() in _METADATA_HOSTNAMES:
        return "cloud metadata hostname is forbidden"

    # 2) Resolve to IP(s). If hostname is a literal IP, use it directly.
    try:
        direct_ip = ipaddress.ip_address(hostname)
        ips_to_check = [direct_ip]
    except ValueError:
        ips_to_check = _resolve_host_ips(hostname)
        if not ips_to_check:
            return "hostname could not be resolved"

    # 3) Metadata IPs blocked unconditionally — even when BLOCK_PRIVATE=0.
    for ip in ips_to_check:
        if ip in _METADATA_IPS:
            return f"cloud metadata endpoint is forbidden ({ip})"

    # 4) Private/loopback/link-local/reserved — conditional on env flag.
    if _BLOCK_PRIVATE:
        for ip in ips_to_check:
            if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
                return (
                    f"private or loopback host is not allowed ({ip}). "
                    f"Set HEALTHCHECK_BLOCK_PRIVATE=0 if you intend to monitor "
                    f"internal LAN endpoints."
                )

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

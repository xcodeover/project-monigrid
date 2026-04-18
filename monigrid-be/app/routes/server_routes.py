"""Server resource monitoring endpoints (single + batch).

Both endpoints are thin HTTP adapters that delegate the actual collection
work to `app.server_resource_collector.collect_server_resources`. This keeps
the route module small and avoids the 600-line duplication that previously
existed between the single and batch handlers.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import jsonify, request

from app.auth import require_auth
from app.server_resource_collector import collect_server_resources


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/dashboard/server-resources", methods=["POST"])
    @require_auth
    @limiter.limit(rl.server_resources)
    def server_resources():
        """Collect CPU/Memory/Disk usage from a remote (or local) server.

        JSON body:
          os_type   — "windows" | "windows-ssh" | "windows-winrm" | "linux-rhel8" | "linux-rhel7" | "linux-generic"
          host      — hostname/IP (optional; omit or "localhost" for this machine)
          username  — SSH/WMI/WinRM username (required for remote)
          password  — SSH/WMI/WinRM password (required for remote)
          port      — SSH port (default 22) or WinRM port (default 5985)
          domain    — Windows domain (WMI / WinRM)
          transport — WinRM transport: "ntlm" (default), "basic", "kerberos", "credssp"
        """
        body = request.get_json(silent=True) or {}
        if not str(body.get("os_type", "")).strip():
            return jsonify({
                "message": "os_type is required (windows, windows-ssh, windows-winrm, linux-ubuntu24, linux-rhel8, linux-rhel7, linux-generic)"
            }), 400
        return jsonify(collect_server_resources(body, backend.logger)), 200

    @app.route("/dashboard/server-resources-batch", methods=["POST"])
    @require_auth
    @limiter.limit(rl.server_resources_batch)
    def server_resources_batch():
        """Collect CPU/Memory/Disk usage from multiple servers in one request.

        JSON body:
          servers — list of { os_type, host, username, password, port, domain }
        Returns:
          results — list of per-server results in the same order
        """
        body = request.get_json(silent=True) or {}
        servers = body.get("servers") or []
        if not isinstance(servers, list) or len(servers) == 0:
            return jsonify({"message": "servers array is required"}), 400
        if len(servers) > 50:
            return jsonify({"message": "too many servers (max 50)"}), 400

        max_workers = min(len(servers), 10)
        results = [None] * len(servers)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_to_idx = {
                pool.submit(collect_server_resources, srv, backend.logger): idx
                for idx, srv in enumerate(servers)
            }
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    results[idx] = future.result()
                except Exception as exc:
                    results[idx] = {
                        "osType": servers[idx].get("os_type", ""),
                        "host": servers[idx].get("host", ""),
                        "cpu": {"usedPct": None},
                        "memory": {"totalGb": None, "usedGb": None, "usedPct": None},
                        "disks": [],
                        "error": str(exc),
                    }
        return jsonify({"results": results}), 200

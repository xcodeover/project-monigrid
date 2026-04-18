"""Network diagnostic endpoints (Ping / Telnet) — single + batch.

Both handlers delegate to `app.network_tester.run_network_test`. The route
layer only owns HTTP request parsing and validation; the diagnostic logic
lives in the testable helper module.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import jsonify, request

from app.auth import require_auth
from app.network_tester import run_network_test


def register(app, backend, limiter) -> None:
    rl = backend.config.rate_limits

    @app.route("/dashboard/network-test", methods=["POST"])
    @require_auth
    @limiter.limit(rl.network_test)
    def network_test():
        """Run a single ping or TCP-connect test against a target host.

        JSON body:
          type    — "ping" | "telnet"
          host    — target hostname or IP (required)
          port    — required for telnet (integer)
          count   — ping count (default 4, max 10)
          timeout — seconds (default 5, max 30)
        """
        body = request.get_json(silent=True) or {}
        if not str(body.get("host", "")).strip():
            return jsonify({"message": "host is required"}), 400
        return jsonify(run_network_test(body)), 200

    @app.route("/dashboard/network-test-batch", methods=["POST"])
    @require_auth
    @limiter.limit(rl.network_test_batch)
    def network_test_batch():
        """Run ping or TCP-connect tests for multiple targets in one request.

        JSON body:
          targets — list of { type, host, port, count, timeout }
        """
        body = request.get_json(silent=True) or {}
        targets = body.get("targets") or []
        if not isinstance(targets, list) or len(targets) == 0:
            return jsonify({"message": "targets array is required"}), 400
        if len(targets) > 50:
            return jsonify({"message": "too many targets (max 50)"}), 400

        max_workers = min(len(targets), 10)
        results = [None] * len(targets)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            future_to_idx = {
                pool.submit(run_network_test, tgt): idx
                for idx, tgt in enumerate(targets)
            }
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    results[idx] = future.result()
                except Exception as exc:
                    results[idx] = {"error": str(exc)}
        return jsonify({"results": results}), 200

"""Network connectivity tests (ping / telnet).

Pure helper functions used by both single and batch network-test endpoints.
Each helper takes a `spec` dict and returns a result dict in a fixed shape,
never raising. This keeps the route layer thin and lets us test the
diagnostic logic without spinning up Flask.
"""
from __future__ import annotations

import platform
import socket
import subprocess
import time as _time
from typing import Any


# ── Spec normalisation ────────────────────────────────────────────────────────

def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _normalise_count(value: Any) -> int:
    return _clamp(int(value if value is not None else 4), 1, 10)


def _normalise_timeout(value: Any) -> float:
    return _clamp(float(value if value is not None else 5), 1.0, 30.0)


# ── Telnet (TCP connect) ──────────────────────────────────────────────────────

def run_telnet_test(host: str, port: int, timeout: float) -> dict[str, Any]:
    """Open a TCP socket to (host, port) and return the result.

    Returns: {type, host, port, success, responseTimeMs, message}
    """
    started = _time.monotonic()
    sock: socket.socket | None = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result_code = sock.connect_ex((host, port))
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        success = result_code == 0
        return {
            "type": "telnet", "host": host, "port": port,
            "success": success, "responseTimeMs": elapsed_ms,
            "message": "Connection successful" if success else f"Connection failed (code={result_code})",
        }
    except socket.timeout:
        return {
            "type": "telnet", "host": host, "port": port,
            "success": False,
            "responseTimeMs": int((_time.monotonic() - started) * 1000),
            "message": f"Connection timed out ({timeout}s)",
        }
    except Exception as e:
        return {
            "type": "telnet", "host": host, "port": port,
            "success": False,
            "responseTimeMs": int((_time.monotonic() - started) * 1000),
            "message": str(e),
        }
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


# ── Ping ──────────────────────────────────────────────────────────────────────

def run_ping_test(host: str, count: int, timeout: float) -> dict[str, Any]:
    """Run a system ping and return the result.

    Returns: {type, host, count, success, responseTimeMs, output, message}
    """
    is_windows = platform.system().lower() == "windows"
    ping_cmd = (
        ["ping", "-n", str(count), "-w", str(int(timeout * 1000)), host]
        if is_windows
        else ["ping", "-c", str(count), "-W", str(int(timeout)), host]
    )
    started = _time.monotonic()
    try:
        result = subprocess.run(
            ping_cmd, capture_output=True, text=True, timeout=timeout * count + 5,
        )
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        output = result.stdout + result.stderr
        success = result.returncode == 0
        return {
            "type": "ping", "host": host, "count": count,
            "success": success, "responseTimeMs": elapsed_ms,
            "output": output.strip(),
            "message": "Ping successful" if success else "Ping failed",
        }
    except subprocess.TimeoutExpired:
        return {
            "type": "ping", "host": host, "count": count,
            "success": False,
            "responseTimeMs": int((_time.monotonic() - started) * 1000),
            "output": "",
            "message": f"Ping timed out ({timeout * count + 5}s)",
        }
    except Exception as e:
        return {
            "type": "ping", "host": host, "count": count,
            "success": False,
            "responseTimeMs": int((_time.monotonic() - started) * 1000),
            "output": "", "message": str(e),
        }


# ── Public dispatcher ─────────────────────────────────────────────────────────

def run_network_test(spec: dict[str, Any]) -> dict[str, Any]:
    """Run a single network test based on `spec`.

    spec keys:
        type    — "ping" | "telnet"  (default "ping")
        host    — required
        port    — required for telnet
        count   — ping count (default 4, clamped 1..10)
        timeout — seconds (default 5, clamped 1..30)

    Returns the result dict (never raises). On validation failures returns
    a dict containing `success: False` and a `message` field.
    """
    test_type = str(spec.get("type", "ping")).strip().lower()
    host = str(spec.get("host", "")).strip()

    if not host:
        return {"type": test_type, "host": "", "success": False,
                "responseTimeMs": 0, "message": "host is required"}

    timeout = _normalise_timeout(spec.get("timeout", 5))

    if test_type == "telnet":
        port_value = spec.get("port")
        if port_value is None:
            return {"type": "telnet", "host": host, "success": False,
                    "responseTimeMs": 0, "message": "port is required for telnet test"}
        return run_telnet_test(host, int(port_value), timeout)

    count = _normalise_count(spec.get("count", 4))
    return run_ping_test(host, count, timeout)

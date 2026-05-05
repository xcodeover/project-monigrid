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

# ── Safety ceilings for ping ──────────────────────────────────────────────────
# Batch ping (up to 50 targets × 10 workers) must not let any single subprocess
# hold a collector/thread-pool worker for more than MAX_PING_WALL_SEC seconds.
# A 3-packet ping to a reachable host finishes in well under 10 s, so the caps
# do not affect normal monitoring use-cases.
MAX_PING_COUNT: int = 3       # max ICMP packets sent per ping invocation
MAX_PING_WALL_SEC: float = 30.0  # hard ceiling on subprocess wall time (seconds)

# ── Spec normalisation ────────────────────────────────────────────────────────

def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def _normalise_count(value: Any) -> int:
    return _clamp(int(value if value is not None else 4), 1, MAX_PING_COUNT)


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

    `count` and the subprocess wall time are capped at MAX_PING_COUNT and
    MAX_PING_WALL_SEC regardless of caller-supplied values.  When either cap is
    hit the response includes ``"limited": True`` so callers can surface that
    the test ran under reduced parameters.

    Returns: {type, host, count, success, responseTimeMs, output, message[, limited]}
    """
    # ── Apply safety ceilings ────────────────────────────────────────────────
    # Guard against zero/negative inputs (e.g. count=-1 from a crafted request)
    # before capping at MAX_PING_COUNT.
    safe_count = min(max(int(count), 1), MAX_PING_COUNT)
    raw_wall = timeout * safe_count + 5
    safe_wall = min(raw_wall, MAX_PING_WALL_SEC)
    limited = (safe_count < count) or (safe_wall < raw_wall)

    is_windows = platform.system().lower() == "windows"
    # Windows -w expects milliseconds; Linux -W expects whole seconds.
    ping_cmd = (
        ["ping", "-n", str(safe_count), "-w", str(int(timeout * 1000)), host]
        if is_windows
        else ["ping", "-c", str(safe_count), "-W", str(int(timeout)), host]
    )
    started = _time.monotonic()
    try:
        # safe_wall 은 OS 레벨 hard kill. ping 의 per-packet -W 는 일부러 변경하지
        # 않음 — 정상 도달 가능 host 의 측정 의미를 보존하고, wall ceiling 으로만
        # 악성/오용 케이스를 차단.
        result = subprocess.run(
            ping_cmd, capture_output=True, text=True, timeout=safe_wall,
        )
        elapsed_ms = int((_time.monotonic() - started) * 1000)
        output = result.stdout + result.stderr
        success = result.returncode == 0
        out: dict[str, Any] = {
            "type": "ping", "host": host, "count": safe_count,
            "success": success, "responseTimeMs": elapsed_ms,
            "output": output.strip(),
            "message": "Ping successful" if success else "Ping failed",
        }
        if limited:
            out["limited"] = True
        return out
    except subprocess.TimeoutExpired:
        out = {
            "type": "ping", "host": host, "count": safe_count,
            "success": False,
            "responseTimeMs": int((_time.monotonic() - started) * 1000),
            "output": "",
            "message": f"Ping timed out ({safe_wall}s)",
        }
        if limited:
            out["limited"] = True
        return out
    except Exception as e:
        out = {
            "type": "ping", "host": host, "count": safe_count,
            "success": False,
            "responseTimeMs": int((_time.monotonic() - started) * 1000),
            "output": "", "message": str(e),
        }
        if limited:
            out["limited"] = True
        return out


# ── Public dispatcher ─────────────────────────────────────────────────────────

def run_network_test(spec: dict[str, Any]) -> dict[str, Any]:
    """Run a single network test based on `spec`.

    spec keys:
        type    — "ping" | "telnet"  (default "ping")
        host    — required
        port    — required for telnet
        count   — ping count (default 4, clamped 1..MAX_PING_COUNT)
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

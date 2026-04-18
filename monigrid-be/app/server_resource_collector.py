"""Server resource collector — collects CPU/Memory/Disk usage from a server.

Handles four OS strategies via local commands, SSH, or WinRM:
    windows        — local WMI / remote WMI via /node:
    windows-ssh    — PowerShell over SSH (paramiko)
    windows-winrm  — PowerShell over WinRM (pywinrm)
    linux-*        — top + /proc/meminfo + df, locally or via SSH

The collector is intentionally pure: it takes a `spec` dict and returns a
result dict in a fixed shape, raising no exceptions to the caller.

Output shape:
    {
        "osType": <str>,
        "host":   <str>,
        "cpu":    {"usedPct": <float|None>},
        "memory": {"totalGb": <float|None>, "usedGb": <float|None>, "usedPct": <float|None>},
        "disks":  [ {"mount": <str>, "totalGb": <float>, "usedGb": <float>, "usedPct": <float>}, ... ],
        "error":  <str|None>,
    }

Why this lives outside the route handler (SRP / DIP):
    - Route file becomes a thin HTTP adapter (input parsing + jsonify).
    - Collection logic is testable in isolation without spinning up Flask.
    - The single and batch endpoints both call collect_server_resources(spec)
      so they cannot drift apart.
"""
from __future__ import annotations

import base64
import contextlib
import logging
import platform
import re
import subprocess
from typing import Any


_LocalCmd = subprocess.run  # alias to make tests easier to monkeypatch if needed


@contextlib.contextmanager
def _noop_ctx():
    """No-op context manager used when SSH is not needed."""
    yield None


def _make_local_runner(timeout: int = 15):
    def _run(cmd, shell: bool = True) -> str:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, shell=shell)
            return r.stdout.strip()
        except Exception as e:
            return f"ERROR: {e}"
    return _run


class _SshRunner:
    """Reusable SSH connection — connects once, executes many commands, then closes.

    Used as a context manager so the connection is always cleaned up:

        with _SshRunner(host, port, user, pw) as run:
            cpu  = run("top -bn1 ...")
            mem  = run("cat /proc/meminfo")
            disk = run("df -BG ...")
    """

    def __init__(self, host: str, port: int, username: str, password: str, timeout: int = 5):
        self._host = host
        self._port = port
        self._username = username
        self._password = password
        self._timeout = timeout
        self._client = None

    def __enter__(self):
        try:
            import paramiko
        except ImportError:
            self._import_error = True
            return self
        self._import_error = False
        try:
            self._client = paramiko.SSHClient()
            self._client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            self._client.connect(
                self._host, port=self._port,
                username=self._username, password=self._password,
                timeout=self._timeout,
            )
        except Exception as e:
            self._connect_error = str(e)
            self._client = None
        else:
            self._connect_error = None
        return self

    def __exit__(self, *exc):
        if self._client is not None:
            try:
                self._client.close()
            except Exception:
                pass
        return False

    def __call__(self, cmd: str) -> str:
        if getattr(self, "_import_error", False):
            return "ERROR: paramiko not installed (pip install paramiko)"
        if self._connect_error is not None:
            return f"ERROR: {self._connect_error}"
        try:
            _, stdout, _stderr = self._client.exec_command(cmd, timeout=self._timeout)
            return stdout.read().decode("utf-8", errors="replace").strip()
        except Exception as e:
            return f"ERROR: {e}"


def _ps_encoded(script: str) -> str:
    """Build a PowerShell -EncodedCommand string (Base64 UTF-16LE).

    Avoids quoting issues when cmd.exe is the default SSH shell on Windows.
    """
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return f"powershell -NoProfile -EncodedCommand {encoded}"


# ── Parsers (pure functions) ──────────────────────────────────────────────────

def _parse_first_float(text: str) -> float | None:
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            return float(line)
        except ValueError:
            continue
    return None


def _parse_kv_lines(text: str, *keys: str) -> dict[str, float | None]:
    result: dict[str, float | None] = {k: None for k in keys}
    for line in text.splitlines():
        for key in keys:
            prefix = f"{key}="
            if prefix in line:
                try:
                    result[key] = float(line.split("=", 1)[1].strip())
                except (ValueError, IndexError):
                    pass
    return result


def _bytes_to_gb(num: float | None) -> float | None:
    return round(num / 1073741824, 2) if num else None


def _kb_to_gb(num: float | None) -> float | None:
    return round(num / 1048576, 2) if num else None


def _empty_metrics() -> dict[str, Any]:
    return {
        "cpu": {"usedPct": None},
        "memory": {"totalGb": None, "usedGb": None, "usedPct": None},
        "disks": [],
    }


# ── OS-specific collection strategies ─────────────────────────────────────────

def _collect_windows_ssh(run_cmd) -> dict[str, Any]:
    """Collect resources from a Windows host via SSH + PowerShell."""
    metrics = _empty_metrics()
    error: str | None = None

    cpu_raw = run_cmd(_ps_encoded(
        "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"
    ))
    if "ERROR" in cpu_raw:
        error = cpu_raw
    else:
        metrics["cpu"]["usedPct"] = _parse_first_float(cpu_raw)

    mem_raw = run_cmd(_ps_encoded(
        "$o=Get-CimInstance Win32_OperatingSystem;"
        " 'TotalVisibleMemorySize='+$o.TotalVisibleMemorySize;"
        " 'FreePhysicalMemory='+$o.FreePhysicalMemory"
    ))
    if "ERROR" in mem_raw:
        error = error or mem_raw
    else:
        kv = _parse_kv_lines(mem_raw, "TotalVisibleMemorySize", "FreePhysicalMemory")
        total_kb, free_kb = kv["TotalVisibleMemorySize"], kv["FreePhysicalMemory"]
        metrics["memory"]["totalGb"] = _kb_to_gb(total_kb)
        if total_kb and free_kb:
            metrics["memory"]["usedGb"] = round((total_kb - free_kb) / 1048576, 2)
            metrics["memory"]["usedPct"] = round((total_kb - free_kb) / total_kb * 100, 1)

    disk_raw = run_cmd(_ps_encoded(
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'"
        " | ForEach-Object { $_.DeviceID+','+$_.Size+','+$_.FreeSpace }"
    ))
    if "ERROR" in disk_raw:
        error = error or disk_raw
    else:
        for line in disk_raw.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3 and parts[0]:
                try:
                    device_id = parts[0]
                    total_size = float(parts[1]) if parts[1] else 0
                    free_space = float(parts[2]) if parts[2] else 0
                    used = total_size - free_space
                    metrics["disks"].append({
                        "mount": device_id,
                        "totalGb": round(total_size / 1073741824, 2),
                        "usedGb": round(used / 1073741824, 2),
                        "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                    })
                except (ValueError, IndexError):
                    pass

    metrics["error"] = error
    return metrics


def _collect_windows_winrm(host: str, port: int, username: str, password: str,
                           domain: str, transport: str = "ntlm",
                           timeout: int = 8) -> dict[str, Any]:
    """Collect resources from a Windows host via WinRM (pywinrm).

    Uses PowerShell remoting over HTTP/HTTPS. Default port 5985 (HTTP).
    Supported transports: ntlm (default), basic, kerberos, credssp.
    """
    try:
        import winrm  # local import: optional dep
    except ImportError:
        return {**_empty_metrics(), "error": "pywinrm not installed (pip install pywinrm)"}

    metrics = _empty_metrics()
    error: str | None = None

    scheme = "https" if port == 5986 else "http"
    endpoint = f"{scheme}://{host}:{port}/wsman"
    user = f"{domain}\\{username}" if domain else username

    try:
        session = winrm.Session(
            endpoint,
            auth=(user, password),
            transport=transport,
            server_cert_validation="ignore",
            operation_timeout_sec=timeout,
            read_timeout_sec=timeout + 5,
        )
    except Exception as e:
        return {**_empty_metrics(), "error": f"WinRM session init failed: {e}"}

    def _run_ps(script: str) -> str:
        try:
            result = session.run_ps(script)
            if result.status_code != 0:
                stderr = result.std_err.decode("utf-8", errors="replace").strip()
                return f"ERROR: {stderr}" if stderr else "ERROR: non-zero exit"
            return result.std_out.decode("utf-8", errors="replace").strip()
        except Exception as e:
            return f"ERROR: {e}"

    # CPU
    cpu_raw = _run_ps(
        "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"
    )
    if "ERROR" in cpu_raw:
        error = cpu_raw
    else:
        metrics["cpu"]["usedPct"] = _parse_first_float(cpu_raw)

    # Memory
    mem_raw = _run_ps(
        "$o=Get-CimInstance Win32_OperatingSystem;"
        " 'TotalVisibleMemorySize='+$o.TotalVisibleMemorySize;"
        " 'FreePhysicalMemory='+$o.FreePhysicalMemory"
    )
    if "ERROR" in mem_raw:
        error = error or mem_raw
    else:
        kv = _parse_kv_lines(mem_raw, "TotalVisibleMemorySize", "FreePhysicalMemory")
        total_kb, free_kb = kv["TotalVisibleMemorySize"], kv["FreePhysicalMemory"]
        metrics["memory"]["totalGb"] = _kb_to_gb(total_kb)
        if total_kb and free_kb:
            metrics["memory"]["usedGb"] = round((total_kb - free_kb) / 1048576, 2)
            metrics["memory"]["usedPct"] = round((total_kb - free_kb) / total_kb * 100, 1)

    # Disk
    disk_raw = _run_ps(
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'"
        " | ForEach-Object { $_.DeviceID+','+$_.Size+','+$_.FreeSpace }"
    )
    if "ERROR" in disk_raw:
        error = error or disk_raw
    else:
        for line in disk_raw.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3 and parts[0]:
                try:
                    device_id = parts[0]
                    total_size = float(parts[1]) if parts[1] else 0
                    free_space = float(parts[2]) if parts[2] else 0
                    used = total_size - free_space
                    metrics["disks"].append({
                        "mount": device_id,
                        "totalGb": round(total_size / 1073741824, 2),
                        "usedGb": round(used / 1073741824, 2),
                        "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                    })
                except (ValueError, IndexError):
                    pass

    metrics["error"] = error
    return metrics


def _collect_windows_wmi(run_cmd, host: str, is_local: bool, username: str, password: str, domain: str) -> dict[str, Any]:
    """Collect resources from Windows via wmic, locally or with /node:."""
    metrics = _empty_metrics()

    wmi_auth = ""
    if not is_local and username:
        user_str = f"{domain}\\{username}" if domain else username
        wmi_auth = f' /user:"{user_str}" /password:"{password}"'

    # CPU
    cpu_cmd = (
        'wmic cpu get LoadPercentage /format:value'
        if is_local
        else f'wmic /node:"{host}"{wmi_auth} cpu get LoadPercentage /format:value'
    )
    cpu_raw = run_cmd(cpu_cmd)
    kv = _parse_kv_lines(cpu_raw, "LoadPercentage")
    metrics["cpu"]["usedPct"] = kv["LoadPercentage"]

    # Memory
    mem_cmd = (
        'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:value'
        if is_local
        else f'wmic /node:"{host}"{wmi_auth} OS get FreePhysicalMemory,TotalVisibleMemorySize /format:value'
    )
    mem_raw = run_cmd(mem_cmd)
    mem_kv = _parse_kv_lines(mem_raw, "TotalVisibleMemorySize", "FreePhysicalMemory")
    total_kb, free_kb = mem_kv["TotalVisibleMemorySize"], mem_kv["FreePhysicalMemory"]
    metrics["memory"]["totalGb"] = _kb_to_gb(total_kb)
    if total_kb and free_kb:
        metrics["memory"]["usedGb"] = round((total_kb - free_kb) / 1048576, 2)
        metrics["memory"]["usedPct"] = round((total_kb - free_kb) / total_kb * 100, 1)

    # Disk
    disk_cmd = (
        'wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv'
        if is_local
        else f'wmic /node:"{host}"{wmi_auth} logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv'
    )
    disk_raw = run_cmd(disk_cmd)
    for line in disk_raw.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4 and parts[1] not in ("", "DeviceID"):
            try:
                device_id = parts[1]
                free_space = float(parts[2]) if parts[2] else 0
                total_size = float(parts[3]) if parts[3] else 0
                used = total_size - free_space
                metrics["disks"].append({
                    "mount": device_id,
                    "totalGb": round(total_size / 1073741824, 2),
                    "usedGb": round(used / 1073741824, 2),
                    "usedPct": round(used / total_size * 100, 1) if total_size > 0 else 0,
                })
            except (ValueError, IndexError):
                pass

    metrics["error"] = None
    return metrics


def _collect_linux(run_cmd) -> dict[str, Any]:
    """Collect resources from Linux (works on RHEL 7/8 and generic Linux)."""
    metrics = _empty_metrics()

    cpu_raw = run_cmd("top -bn1 | grep 'Cpu(s)' | head -1")
    if "ERROR" not in cpu_raw:
        try:
            idle_match = re.search(r'(\d+\.?\d*)\s*(?:%?\s*)?id', cpu_raw)
            if idle_match:
                metrics["cpu"]["usedPct"] = round(100.0 - float(idle_match.group(1)), 1)
        except Exception:
            pass

    mem_raw = run_cmd("cat /proc/meminfo")
    mem_total_kb = mem_available_kb = None
    if "ERROR" not in mem_raw:
        for line in mem_raw.splitlines():
            if line.startswith("MemTotal:"):
                try:
                    mem_total_kb = float(line.split()[1])
                except (ValueError, IndexError):
                    pass
            if line.startswith("MemAvailable:"):
                try:
                    mem_available_kb = float(line.split()[1])
                except (ValueError, IndexError):
                    pass

    metrics["memory"]["totalGb"] = _kb_to_gb(mem_total_kb)
    if mem_total_kb:
        metrics["memory"]["usedGb"] = round((mem_total_kb - (mem_available_kb or 0)) / 1048576, 2)
        metrics["memory"]["usedPct"] = round((mem_total_kb - (mem_available_kb or 0)) / mem_total_kb * 100, 1)

    disk_raw = run_cmd("df -BG --output=target,size,used,pcent -x tmpfs -x devtmpfs 2>/dev/null || df -h")
    if "ERROR" not in disk_raw:
        for line in disk_raw.splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 4:
                try:
                    metrics["disks"].append({
                        "mount":   parts[0],
                        "totalGb": float(parts[1].replace("G", "").replace(",", ".")),
                        "usedGb":  float(parts[2].replace("G", "").replace(",", ".")),
                        "usedPct": float(parts[3].replace("%", "")),
                    })
                except (ValueError, IndexError):
                    pass

    metrics["error"] = None
    return metrics


# ── Public entry point ────────────────────────────────────────────────────────

def collect_server_resources(spec: dict[str, Any], logger: logging.Logger | None = None) -> dict[str, Any]:
    """Collect CPU/Memory/Disk metrics for one server based on `spec`.

    spec keys (all optional except os_type):
        os_type   — "windows" | "windows-ssh" | "windows-winrm" | "linux-rhel8" | "linux-rhel7" | "linux-generic"
        host      — hostname/IP (default "localhost")
        username  — SSH/WMI/WinRM username
        password  — SSH/WMI/WinRM password
        domain    — Windows domain (WMI / WinRM)
        port      — SSH port (default 22) or WinRM port (default 5985)
        transport — WinRM transport: "ntlm" (default), "basic", "kerberos", "credssp"

    Returns the result dict (never raises).
    """
    os_type = str(spec.get("os_type", "")).strip().lower()
    host = str(spec.get("host", "localhost")).strip()
    username = str(spec.get("username", "")).strip()
    password = str(spec.get("password", "")).strip()
    domain = str(spec.get("domain", "")).strip()
    ssh_port = int(spec.get("port", 22))
    is_local = host in ("localhost", "127.0.0.1", "", platform.node())

    if not os_type:
        return {
            "osType": os_type, "host": host,
            **_empty_metrics(),
            "error": "os_type is required",
        }

    local_runner = _make_local_runner()
    needs_ssh = (not is_local) and (os_type.startswith("linux") or os_type == "windows-ssh")
    transport = str(spec.get("transport", "ntlm")).strip().lower()

    try:
        # Use a single SSH connection for all commands (context manager ensures cleanup)
        with _SshRunner(host, ssh_port, username, password) if needs_ssh else _noop_ctx() as ssh_runner:
            def run_cmd(cmd, shell: bool = True) -> str:
                if is_local:
                    return local_runner(cmd, shell=shell)
                if needs_ssh:
                    return ssh_runner(cmd if isinstance(cmd, str) else " ".join(cmd))
                return local_runner(cmd, shell=shell)

            if os_type == "windows-winrm":
                if is_local and (not username or not password):
                    metrics = _collect_windows_wmi(run_cmd, host, True, username, password, domain)
                    return {"osType": "windows-winrm", "host": host, **metrics}
                winrm_port = int(spec.get("port", 5985))
                metrics = _collect_windows_winrm(
                    host, winrm_port, username, password, domain, transport,
                )
                return {"osType": "windows-winrm", "host": host, **metrics}

            if os_type == "windows-ssh":
                metrics = _collect_windows_ssh(run_cmd)
                return {"osType": "windows-ssh", "host": host, **metrics}

            if os_type == "windows":
                metrics = _collect_windows_wmi(run_cmd, host, is_local, username, password, domain)
                return {"osType": "windows", "host": host, **metrics}

            # Linux
            metrics = _collect_linux(run_cmd)
            return {"osType": os_type, "host": host, **metrics}

    except Exception as e:
        if logger is not None:
            logger.exception("Server resource collection failed host=%s", host)
        return {
            "osType": os_type, "host": host,
            **_empty_metrics(),
            "error": str(e),
        }

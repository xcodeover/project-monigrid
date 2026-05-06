"""Monitor collector manager.

Owns the background collection of server-resource / network targets.
Each enabled target gets its own refresh thread (mirroring the pattern
used by `EndpointCacheManager`) so slow/failing targets can't delay
healthy ones. Latest results are kept in an in-memory snapshot dict
and served to the frontend via the monitor routes.

Why this exists:
    The previous design had the frontend POST each server/network probe
    spec to the BE every N seconds — with many users watching the same
    dashboard, that multiplied load against the monitored hosts. We now
    centralize collection in the BE: operators register targets once,
    every A-A node polls them independently, and all users share the
    same snapshot.

Dependencies on the rest of the system are inverted (DIP):
    - `target_loader() -> list[dict]`        — SettingsStore
    - `executor_provider() -> Executor`      — async layer

The manager is intentionally decoupled from Flask: the collection
logic is testable in isolation by passing fake loaders/collectors.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from time import perf_counter
from typing import Any, Callable

from .http_health_checker import check_http_url
from .network_tester import run_network_test
from .server_resource_collector import (
    collect_server_resources,
    clear_ssh_pool,
    clear_ssh_pool_for_host,
)


TargetLoader = Callable[[], list[dict[str, Any]]]


@dataclass
class MonitorSnapshot:
    target_id: str
    type: str
    label: str | None
    data: Any | None
    error_message: str | None
    updated_at: str | None
    last_refresh_started_at: str | None
    last_duration_sec: float | None
    source: str
    interval_sec: int
    enabled: bool
    spec_echo: dict[str, Any] = field(default_factory=dict)


class MonitorCollectorManager:
    """Collects monitor target snapshots on a per-target schedule."""

    def __init__(
        self,
        *,
        target_loader: TargetLoader,
        executor_provider: Callable[[], ThreadPoolExecutor],
        logger: logging.Logger,
    ) -> None:
        self._target_loader = target_loader
        self._executor_provider = executor_provider
        self._logger = logger

        self._snapshots: dict[str, MonitorSnapshot] = {}
        self._snapshot_lock = threading.RLock()
        # Phase 5B: per-target stop_event + thread → 변경된 target 만 재생성 가능.
        self._stop_events: dict[str, threading.Event] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._targets_by_id: dict[str, dict[str, Any]] = {}
        self._targets_lock = threading.RLock()

    # ── lifecycle ─────────────────────────────────────────────────────────

    def start(self) -> None:
        self._stop_events.clear()
        self._threads.clear()
        try:
            targets = self._target_loader() or []
        except Exception as exc:
            self._logger.error("Monitor target load failed at startup: %s", exc)
            targets = []

        enabled_targets = [t for t in targets if t.get("enabled", True)]

        with self._targets_lock:
            self._targets_by_id = {t["id"]: t for t in targets}

        # Prime snapshots (disabled or enabled) so FE can display zero-state cards
        for target in targets:
            with self._snapshot_lock:
                if target["id"] not in self._snapshots:
                    self._snapshots[target["id"]] = _initial_snapshot(target)

        if enabled_targets:
            self._logger.info(
                "Starting initial monitor collection for %d targets...",
                len(enabled_targets),
            )
            executor = self._executor_provider()
            futures = {
                executor.submit(self._collect_target, target, "startup"): target["id"]
                for target in enabled_targets
            }
            # as_completed: 완료된 future 부터 즉시 처리 → wall time = max(개별) + overhead
            # (기존 for future in futures: 는 dict 삽입 순서대로 순차 대기 → worst N×60s)
            overall_timeout = max(120, len(futures) * 5)
            completed = 0
            try:
                for future in as_completed(futures, timeout=overall_timeout):
                    target_id = futures[future]
                    try:
                        future.result()
                        completed += 1
                    except Exception as exc:
                        completed += 1
                        self._logger.error(
                            "Initial monitor collection failed targetId=%s: %s",
                            target_id, exc,
                        )
            except FutureTimeoutError:
                pending = len(futures) - completed
                self._logger.warning(
                    "Initial monitor collection overall timeout after %.0fs — "
                    "%d/%d completed, %d skipped. Boot continues.",
                    overall_timeout, completed, len(futures), pending,
                )
            self._logger.info(
                "Initial monitor collection completed (%d/%d targets).",
                completed, len(futures),
            )

        for target in enabled_targets:
            self._spawn_target_thread(target["id"])

    def _spawn_target_thread(self, target_id: str) -> None:
        """Internal: create per-target stop_event + start refresh thread.

        No-op if a thread for this target_id is already running.
        """
        if target_id in self._threads:
            return
        stop_event = threading.Event()
        self._stop_events[target_id] = stop_event
        thread = threading.Thread(
            target=self._refresh_loop,
            args=(target_id,),
            name=f"monitor-collect-{target_id}",
            daemon=True,
        )
        thread.start()
        self._threads[target_id] = thread

    def stop(self) -> None:
        for ev in list(self._stop_events.values()):
            ev.set()
        for thread in list(self._threads.values()):
            thread.join(timeout=1.5)
        self._stop_events.clear()
        self._threads.clear()

    def clear(self) -> None:
        with self._snapshot_lock:
            self._snapshots.clear()

    def reload(self) -> None:
        """Stop current threads, re-read targets, restart from scratch.

        Phase 5B: nuclear path retained as escape hatch (full state reset
        on demand). New code paths use add_target / remove_target /
        update_target_in_place for surgical updates.
        """
        self.stop()
        self.clear()
        # Drain SSH session pool — rotated credentials or removed targets
        # would otherwise leave stale auth lingering across the reload.
        clear_ssh_pool()
        self.start()

    def add_target(self, target: dict[str, Any]) -> None:
        """Phase 5B: spawn collector thread for a newly-added target.

        Synchronously runs initial collection so the FE sees a real value
        on the next snapshot poll. Other targets are unaffected.
        """
        target_id = str(target["id"])
        with self._targets_lock:
            self._targets_by_id[target_id] = target
        with self._snapshot_lock:
            if target_id not in self._snapshots:
                self._snapshots[target_id] = _initial_snapshot(target)
        if not target.get("enabled", True):
            return
        try:
            self._collect_target(target, "add")
        except Exception:
            self._logger.exception(
                "Initial collection failed for added target — will retry on next tick targetId=%s",
                target_id,
            )
        self._spawn_target_thread(target_id)

    def remove_target(self, target_id: str) -> None:
        """Phase 5B: stop collector thread for a deleted target.

        Drains SSH session for that target's host. Other hosts unaffected.
        """
        target_id = str(target_id)
        with self._targets_lock:
            target = self._targets_by_id.pop(target_id, None)
        with self._snapshot_lock:
            self._snapshots.pop(target_id, None)
        stop_event = self._stop_events.pop(target_id, None)
        thread = self._threads.pop(target_id, None)
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=1.5)
        if target is not None:
            host = (target.get("spec") or {}).get("host") or target.get("host")
            if host:
                clear_ssh_pool_for_host(str(host))

    def update_target_in_place(
        self,
        target: dict[str, Any],
        *,
        ssh_credentials_changed: bool = False,
    ) -> None:
        """Phase 5B: mutate target dict in place. Existing collector thread
        picks up changes on next sleep (interval/threshold/enabled toggle).
        If SSH credentials/host changed, also drain that host's SSH session
        so the next collect uses fresh credentials.
        """
        target_id = str(target["id"])
        with self._targets_lock:
            self._targets_by_id[target_id] = target
        if ssh_credentials_changed:
            host = (target.get("spec") or {}).get("host") or target.get("host")
            if host:
                clear_ssh_pool_for_host(str(host))

    def forget_target(self, target_id: str) -> None:
        """Drop a deleted target's snapshot + memoised entry.

        Defensive companion to ``reload()`` on delete: even if a future
        refactor short-circuits the full reload, this guarantees the
        snapshot dict no longer carries the dead id (the FE would otherwise
        keep rendering its zero-state card) and the doomed refresh thread
        exits cleanly on its next tick once it observes the missing entry.
        """
        with self._snapshot_lock:
            self._snapshots.pop(target_id, None)
        with self._targets_lock:
            self._targets_by_id.pop(target_id, None)

    # ── public API ────────────────────────────────────────────────────────

    def snapshot_entries(self) -> dict[str, MonitorSnapshot]:
        with self._snapshot_lock:
            return dict(self._snapshots)

    def get_snapshot(self, target_id: str) -> MonitorSnapshot | None:
        with self._snapshot_lock:
            return self._snapshots.get(target_id)

    def refresh_target(self, target_id: str) -> MonitorSnapshot | None:
        """On-demand collect, bypassing the schedule. Returns updated snapshot."""
        with self._targets_lock:
            target = self._targets_by_id.get(target_id)
        if target is None:
            # Cache miss — try to (re)load the target from the settings DB.
            # A loader failure used to be swallowed silently, leaving the
            # caller staring at a generic 404 even though the underlying
            # cause was a DB outage. Log the exception and return None so
            # the caller still gets a 404 (no usable target) but operators
            # can see what happened in the logs.
            try:
                targets = self._target_loader() or []
            except Exception:
                self._logger.exception(
                    "Failed to reload monitor targets for on-demand refresh targetId=%s",
                    target_id,
                )
                return None
            target = next(
                (t for t in targets if isinstance(t, dict) and str(t.get("id")) == target_id),
                None,
            )
            if target is None:
                return None
            with self._targets_lock:
                self._targets_by_id[target_id] = target
        return self._collect_target(target, source="manual")

    # ── background loop ──────────────────────────────────────────────────

    def _refresh_loop(self, target_id: str) -> None:
        stop_event = self._stop_events.get(target_id)
        if stop_event is None:
            return  # spawn 직후 remove 된 race
        with self._targets_lock:
            target = self._targets_by_id.get(target_id)
        if target is None or not target.get("enabled", True):
            return
        interval = max(1, int(target.get("interval_sec") or 30))
        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug(
                "Monitor scheduler started targetId=%s intervalSec=%s",
                target_id, interval,
            )
        while not stop_event.wait(interval):
            with self._targets_lock:
                current = self._targets_by_id.get(target_id)
            if current is None or not current.get("enabled", True):
                break
            # Pick up an interval edit on the next sleep — without this, a
            # target whose interval was raised stays on the old (faster)
            # cadence until the process restarts.
            interval = max(1, int(current.get("interval_sec") or 30))
            self._collect_target(current, source="scheduler")
        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug("Monitor scheduler exited targetId=%s", target_id)

    # ── collection ────────────────────────────────────────────────────────

    def _collect_target(self, target: dict[str, Any], source: str) -> MonitorSnapshot:
        target_id = str(target["id"])
        target_type = str(target.get("type") or "").strip().lower()
        spec = target.get("spec") or {}
        label = target.get("label")
        interval_sec = int(target.get("interval_sec") or 30)
        enabled = bool(target.get("enabled", True))

        started_at = datetime.now(timezone.utc).isoformat()
        started_timer = perf_counter()
        data: Any = None
        error_message: str | None = None

        try:
            if target_type == "server_resource":
                data = collect_server_resources(spec, self._logger)
                if isinstance(data, dict) and data.get("error"):
                    error_message = str(data.get("error"))
            elif target_type == "network":
                data = run_network_test(spec)
                if isinstance(data, dict) and data.get("success") is False:
                    error_message = str(data.get("message") or "probe failed")
            elif target_type == "http_status":
                # Replaces the per-request /health-check-proxy-batch fan-out:
                # one BE-side probe per target on its own schedule, and every
                # widget reads the same in-memory snapshot. Spec is intentionally
                # narrow — `url` (required) and `timeout_sec` (clamped) — so the
                # proxy SSRF rules don't have to live in two places.
                url = str(spec.get("url") or "").strip()
                if not url:
                    error_message = "http_status target requires spec.url"
                else:
                    timeout_sec = _clamp_http_timeout(spec.get("timeout_sec"))
                    data = check_http_url(url, timeout_sec)
                    if isinstance(data, dict) and not data.get("ok"):
                        error_message = str(data.get("error") or f"HTTP {data.get('httpStatus')}")
            else:
                error_message = f"unknown target type: {target_type}"
        except Exception as exc:
            error_message = str(exc)
            self._logger.exception(
                "Monitor collection raised targetId=%s type=%s",
                target_id, target_type,
            )

        duration_sec = perf_counter() - started_timer
        snapshot = MonitorSnapshot(
            target_id=target_id,
            type=target_type,
            label=label,
            data=data,
            error_message=error_message,
            updated_at=datetime.now(timezone.utc).isoformat(),
            last_refresh_started_at=started_at,
            last_duration_sec=round(duration_sec, 3),
            source=source,
            interval_sec=interval_sec,
            enabled=enabled,
            spec_echo=_redact_spec(spec),
        )
        with self._snapshot_lock:
            self._snapshots[target_id] = snapshot

        if self._logger.isEnabledFor(logging.DEBUG):
            self._logger.debug(
                "Monitor collected targetId=%s type=%s source=%s durationSec=%.3f hasError=%s",
                target_id, target_type, source, duration_sec, error_message is not None,
            )
        return snapshot


# ── helpers ──────────────────────────────────────────────────────────────


def _initial_snapshot(target: dict[str, Any]) -> MonitorSnapshot:
    return MonitorSnapshot(
        target_id=str(target["id"]),
        type=str(target.get("type") or ""),
        label=target.get("label"),
        data=None,
        error_message=None,
        updated_at=None,
        last_refresh_started_at=None,
        last_duration_sec=None,
        source="pending",
        interval_sec=int(target.get("interval_sec") or 30),
        enabled=bool(target.get("enabled", True)),
        spec_echo=_redact_spec(target.get("spec") or {}),
    )


_HTTP_TIMEOUT_MIN_SEC = 1.0
_HTTP_TIMEOUT_MAX_SEC = 30.0
_HTTP_TIMEOUT_DEFAULT_SEC = 10.0


def _clamp_http_timeout(value: Any) -> float:
    """Clamp a user-supplied timeout to the same envelope the proxy enforces.

    The HTTP proxy route already clamps inbound `timeout` to [1, 30] seconds;
    we mirror that here so an admin can't set spec.timeout_sec=600 in the
    settings DB and stall the collector pool on a single slow target.
    """
    try:
        n = float(value if value is not None else _HTTP_TIMEOUT_DEFAULT_SEC)
    except (TypeError, ValueError):
        return _HTTP_TIMEOUT_DEFAULT_SEC
    return max(_HTTP_TIMEOUT_MIN_SEC, min(_HTTP_TIMEOUT_MAX_SEC, n))


_SECRET_KEYS = ("password", "passwd", "secret", "token")


def _redact_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy of `spec` with credential fields masked.

    The snapshot goes to every authenticated user, so raw SSH/WinRM
    passwords stored on the target spec must not leak through the API.
    """
    out: dict[str, Any] = {}
    for key, value in spec.items():
        if any(secret in key.lower() for secret in _SECRET_KEYS):
            out[key] = "***" if value else ""
        else:
            out[key] = value
    return out


def snapshot_to_dict(snapshot: MonitorSnapshot) -> dict[str, Any]:
    return {
        "targetId":             snapshot.target_id,
        "type":                 snapshot.type,
        "label":                snapshot.label,
        "data":                 snapshot.data,
        "errorMessage":         snapshot.error_message,
        "updatedAt":            snapshot.updated_at,
        "lastRefreshStartedAt": snapshot.last_refresh_started_at,
        "lastDurationSec":      snapshot.last_duration_sec,
        "source":               snapshot.source,
        "intervalSec":          snapshot.interval_sec,
        "enabled":              snapshot.enabled,
        "spec":                 snapshot.spec_echo,
    }

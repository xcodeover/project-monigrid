"""NotificationDispatcher.

Bridges AlertEvaluator → notification queue. Sits on the evaluator hot path
but performs only constant-time work: enqueue an event into an in-process
queue and return. Heavy work (rule matching, silence/cooldown lookup,
template render, DB INSERT into the queue table) runs in the worker thread
that drains that in-process queue.

Five-layer isolation guarantees so the monitoring loop never blocks on
notification:
  L1 — evaluator try/except wrapping the on_event call (in alert_evaluator.py).
  L2 — on_event only puts onto the in-process queue and returns (microseconds).
  L3 — _route() runs in a single dedicated thread; it never raises out.
  L4 — overflow protection: in-process queue is bounded; full → drop + warn.
  L5 — fault injection env honored so we can stress-test L1..L4 in dev.
"""
from __future__ import annotations

import logging
import os
import queue
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .crypto import decrypt_dict


_logger = logging.getLogger(__name__)
_FAULT = os.environ.get("MONIGRID_NOTIFICATION_FAULT", "").strip().lower()
# fault modes: 'raise' | 'hang' | 'fail' | '' (off)


@dataclass
class _Event:
    source_type: str
    source_id: str
    metric: str | None
    severity: str
    level: str | None
    label: str | None
    message: str | None
    payload: dict[str, Any]
    created_at: datetime  # UTC aware


@dataclass
class _Cooldown:
    """Per-(rule_id, key) sliding window: last_sent_ts + count of suppressed
    events since then. Reset on next non-suppressed send."""
    last_sent: datetime
    suppressed: int = 0


@dataclass
class _Stats:
    received: int = 0
    enqueued: int = 0
    dropped_overflow: int = 0
    suppressed_global_off: int = 0
    suppressed_silence: int = 0
    suppressed_cooldown: int = 0
    suppressed_min_level: int = 0
    suppressed_send_on_clear: int = 0
    matched_rules: int = 0
    enqueue_errors: int = 0


class NotificationDispatcher:
    """Lifecycle: created once at service start, given a SettingsStore handle
    plus a callable that returns the live channel registry. ``start()`` spins
    up the routing thread; ``stop()`` joins it.
    """

    _LEVEL_RANK = {"warn": 1, "critical": 2}
    _MAX_INFLIGHT = 1000  # L4 backpressure cap

    def __init__(
        self,
        store: Any,  # SettingsStore — typed as Any to avoid circular import
        *,
        get_app_url: Callable[[], str] | None = None,
        app_name: str = "MoniGrid",
    ) -> None:
        self._store = store
        self._app_name = app_name
        self._get_app_url = get_app_url or (lambda: "")
        self._inflight: queue.Queue[_Event | None] = queue.Queue(maxsize=self._MAX_INFLIGHT)
        self._cooldowns: dict[tuple[int, str, str, str | None], _Cooldown] = {}
        self._cooldowns_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_evt = threading.Event()
        self._stats = _Stats()
        self._stats_lock = threading.Lock()
        # Set lazily by service.py after both evaluator + dispatcher exist.
        # Used only for the "other alarms firing right now" enrichment in
        # the email body — None is fine, it just omits that section.
        self._evaluator: Any = None

    def set_evaluator(self, evaluator: Any) -> None:
        self._evaluator = evaluator

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_evt.clear()
        t = threading.Thread(
            target=self._run, name="notification-dispatcher", daemon=True,
        )
        t.start()
        self._thread = t
        _logger.info("notification dispatcher started")

    def stop(self, *, timeout: float = 5.0) -> None:
        self._stop_evt.set()
        try:
            self._inflight.put_nowait(None)  # sentinel to wake the loop
        except queue.Full:
            pass
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        _logger.info("notification dispatcher stopped")

    def stats(self) -> dict[str, int]:
        with self._stats_lock:
            return {
                "received": self._stats.received,
                "enqueued": self._stats.enqueued,
                "droppedOverflow": self._stats.dropped_overflow,
                "suppressedGlobalOff": self._stats.suppressed_global_off,
                "suppressedSilence": self._stats.suppressed_silence,
                "suppressedCooldown": self._stats.suppressed_cooldown,
                "suppressedMinLevel": self._stats.suppressed_min_level,
                "suppressedSendOnClear": self._stats.suppressed_send_on_clear,
                "matchedRules": self._stats.matched_rules,
                "enqueueErrors": self._stats.enqueue_errors,
                "inflight": self._inflight.qsize(),
            }

    # ── L1/L2 entry from evaluator ───────────────────────────────────────
    def on_event(self, event: dict[str, Any]) -> None:
        """Called from AlertEvaluator._record_safe inside try/except.
        Returns in microseconds — only queue.put_nowait + counter inc."""
        if _FAULT == "raise":
            raise RuntimeError("MONIGRID_NOTIFICATION_FAULT=raise (test)")
        with self._stats_lock:
            self._stats.received += 1
        try:
            ev = _coerce_event(event)
        except Exception as exc:
            _logger.warning("dispatcher on_event coerce failed: %s", exc)
            return
        try:
            self._inflight.put_nowait(ev)
        except queue.Full:
            with self._stats_lock:
                self._stats.dropped_overflow += 1
            _logger.warning(
                "notification dispatcher queue full (>%d); dropping event %s/%s",
                self._MAX_INFLIGHT, ev.source_type, ev.source_id,
            )

    # ── L3: routing thread ───────────────────────────────────────────────
    def _run(self) -> None:
        while not self._stop_evt.is_set():
            try:
                ev = self._inflight.get(timeout=1.0)
            except queue.Empty:
                continue
            if ev is None:
                break
            if _FAULT == "hang":
                # Test-only: simulate a wedged dispatcher. evaluator hot path
                # is unaffected because L1/L2 is sync put_nowait.
                time.sleep(60.0)
                continue
            try:
                self._route(ev)
            except Exception:
                _logger.exception("dispatcher _route failed for %s/%s",
                                  ev.source_type, ev.source_id)

    def _route(self, ev: _Event) -> None:
        # Global off?
        if not self._global_enabled():
            with self._stats_lock:
                self._stats.suppressed_global_off += 1
            return

        # Silence?
        if self._silenced(ev):
            with self._stats_lock:
                self._stats.suppressed_silence += 1
            return

        # Find matching rules
        rules = self._matching_rules(ev)
        if not rules:
            return
        with self._stats_lock:
            self._stats.matched_rules += len(rules)

        # Channel registry — built once per route (cheap; small set)
        channels_by_id = self._channels_by_id()

        for rule in rules:
            # min_level gate
            if not self._level_meets(ev.level, rule.get("minLevel")):
                with self._stats_lock:
                    self._stats.suppressed_min_level += 1
                continue
            # clear gate
            if ev.severity == "clear" and not rule.get("sendOnClear", False):
                with self._stats_lock:
                    self._stats.suppressed_send_on_clear += 1
                continue
            # cooldown
            cooldown_sec = int(rule.get("cooldownSec") or 0)
            cooldown_count = 0
            if cooldown_sec > 0:
                key = (int(rule["id"]), ev.source_type, ev.source_id, ev.metric)
                hit = self._cooldown_hit(key, cooldown_sec, ev.created_at)
                if hit > 0:
                    with self._stats_lock:
                        self._stats.suppressed_cooldown += 1
                    continue
                cooldown_count = self._cooldown_take(key, ev.created_at)
            # channel
            channel_id = int(rule["channelId"])
            channel_meta = channels_by_id.get(channel_id)
            if channel_meta is None or not channel_meta.get("enabled"):
                _logger.info(
                    "rule %s skipped — channel %s missing/disabled",
                    rule.get("id"), channel_id,
                )
                continue
            # recipients
            recipients = self._recipients_for(int(rule["recipientGroupId"]))
            if not recipients:
                continue
            # render + enqueue per recipient
            for r in recipients:
                try:
                    self._render_and_enqueue(
                        rule=rule, channel_id=channel_id, recipient=r,
                        event=ev, cooldown_recent_count=cooldown_count,
                    )
                except Exception:
                    with self._stats_lock:
                        self._stats.enqueue_errors += 1
                    _logger.exception(
                        "enqueue failed for rule %s recipient %s",
                        rule.get("id"), r.get("address"),
                    )

    # ── helpers ──────────────────────────────────────────────────────────
    def _global_enabled(self) -> bool:
        try:
            kv = self._store.get_config_value("notification.global") \
                if hasattr(self._store, "get_config_value") else None
            if kv is None:
                # fall back to direct settings_kv access via load_scalar
                kv = self._get_global_via_kv()
            return bool(kv.get("enabled")) if isinstance(kv, dict) else False
        except Exception:
            return False

    def _get_global_via_kv(self) -> dict[str, Any] | None:
        # Use the public scalar loader; section is not part of _KV_SECTIONS so
        # we fall back to a direct query helper if available, else None.
        try:
            scalars = self._store.load_scalar_sections()
            return scalars.get("notification.global")
        except Exception:
            return None

    def _silenced(self, ev: _Event) -> bool:
        try:
            actives = self._store.list_active_silence_rules(at_utc=ev.created_at)
        except Exception:
            return False
        for s in actives:
            if not _match_pattern(ev.source_type, s.get("sourceType")):
                continue
            if not _match_pattern(ev.source_id, s.get("sourceIdPattern")):
                continue
            if not _match_pattern(ev.metric or "", s.get("metricPattern")):
                continue
            return True
        return False

    def _matching_rules(self, ev: _Event) -> list[dict[str, Any]]:
        try:
            rules = self._store.list_notification_rules(only_enabled=True)
        except Exception:
            return []
        out = []
        for rule in rules:
            if not _match_pattern(ev.source_type, rule.get("sourceType")):
                continue
            if not _match_pattern(ev.source_id, rule.get("sourceIdPattern")):
                continue
            if not _match_pattern(ev.metric or "", rule.get("metricPattern")):
                continue
            out.append(rule)
        return out

    def _level_meets(self, ev_level: str | None, min_level: str | None) -> bool:
        ev_rank = self._LEVEL_RANK.get((ev_level or "warn").lower(), 1)
        min_rank = self._LEVEL_RANK.get((min_level or "warn").lower(), 1)
        return ev_rank >= min_rank

    def _cooldown_hit(
        self, key: tuple, cooldown_sec: int, now: datetime,
    ) -> int:
        with self._cooldowns_lock:
            cd = self._cooldowns.get(key)
            if cd is None:
                return 0
            if (now - cd.last_sent).total_seconds() < cooldown_sec:
                cd.suppressed += 1
                return cd.suppressed
            return 0

    def _cooldown_take(self, key: tuple, now: datetime) -> int:
        with self._cooldowns_lock:
            cd = self._cooldowns.get(key)
            count = cd.suppressed if cd else 0
            self._cooldowns[key] = _Cooldown(last_sent=now, suppressed=0)
            return count

    def _channels_by_id(self) -> dict[int, dict[str, Any]]:
        try:
            chans = self._store.list_notification_channels()
        except Exception:
            return {}
        return {int(c["id"]): c for c in chans}

    def _recipients_for(self, group_id: int) -> list[dict[str, Any]]:
        try:
            recs = self._store.list_notification_recipients(group_id=group_id)
        except Exception:
            return []
        # Also need to honor the group's own enabled flag.
        try:
            groups = {int(g["id"]): g for g in self._store.list_notification_groups()}
        except Exception:
            groups = {}
        g = groups.get(group_id)
        if g is not None and not g.get("enabled", True):
            return []
        return [r for r in recs if r.get("enabled", True)]

    def _render_and_enqueue(
        self, *, rule: dict[str, Any], channel_id: int,
        recipient: dict[str, Any], event: _Event,
        cooldown_recent_count: int,
    ) -> None:
        # Local import: templates pulls in jinja2; keep the dispatcher
        # importable in unit tests that monkeypatch it.
        from .templates import render_alert_email

        event_dict = {
            "source_type": event.source_type,
            "source_id": event.source_id,
            "metric": event.metric,
            "severity": event.severity,
            "level": event.level,
            "label": event.label,
            "message": event.message,
            "payload": event.payload,
            "created_at": event.created_at,
        }

        dashboard_url, timemachine_url = self._build_links(event)
        subject, html, text = render_alert_email(
            event=event_dict,
            related_active=self._related_active(event),
            sparkline_svg=None,  # P5 enrichment slot (see worker for fetch)
            dashboard_url=dashboard_url,
            timemachine_url=timemachine_url,
            cooldown_recent_count=cooldown_recent_count,
            app_name=self._app_name,
        )

        self._store.enqueue_notification(
            channel_id=channel_id,
            recipient_address=str(recipient["address"]),
            subject=subject,
            body_html=html,
            body_text=text,
            rule_id=int(rule["id"]),
            alert_event_id=None,  # see settings_store note: id not surfaced today
        )
        with self._stats_lock:
            self._stats.enqueued += 1

    def _related_active(self, event: _Event) -> list[dict[str, Any]]:
        """Pull the rest of the in-memory active alarms via the evaluator
        snapshot route. Failures degrade silently — body just omits the
        'related' section."""
        evaluator = self._evaluator
        if evaluator is None or not hasattr(evaluator, "snapshot_active"):
            return []
        try:
            actives = evaluator.snapshot_active()
        except Exception:
            return []
        # Exclude the firing event itself and cap to 5 entries.
        my_key = (event.source_type, event.source_id, event.metric)
        out = []
        for a in actives:
            if (a.get("sourceType"), a.get("sourceId"), a.get("metric")) == my_key:
                continue
            out.append(a)
            if len(out) >= 5:
                break
        return out

    def _build_links(self, event: _Event) -> tuple[str, str]:
        base = (self._get_app_url() or "").rstrip("/")
        if not base:
            return "", ""
        ts_iso = event.created_at.astimezone(timezone.utc).isoformat()
        sid = event.source_id
        return (
            f"{base}/dashboard",
            f"{base}/timemachine?at={ts_iso}&sourceType={event.source_type}&sourceId={sid}",
        )


# ── module-level helpers ─────────────────────────────────────────────────


def _coerce_event(event: dict[str, Any]) -> _Event:
    created = event.get("created_at")
    if isinstance(created, str):
        # Tolerate ISO strings round-tripped from the route layer.
        created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
    elif isinstance(created, datetime):
        created_dt = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
    else:
        created_dt = datetime.now(timezone.utc)
    payload = event.get("payload")
    if not isinstance(payload, dict):
        payload = {} if payload is None else {"raw": payload}
    return _Event(
        source_type=str(event.get("source_type") or ""),
        source_id=str(event.get("source_id") or ""),
        metric=event.get("metric"),
        severity=str(event.get("severity") or "raise"),
        level=event.get("level"),
        label=event.get("label"),
        message=event.get("message"),
        payload=payload,
        created_at=created_dt,
    )


def _match_pattern(value: str, pattern: str | None) -> bool:
    """Glob-style pattern: NULL/empty pattern = match any. '*' = wildcard.
    Otherwise treated as a regex (anchored)."""
    if pattern is None or pattern == "" or pattern == "*":
        return True
    try:
        return re.fullmatch(pattern, value) is not None
    except re.error:
        # Not a valid regex — fall back to literal equality.
        return value == pattern

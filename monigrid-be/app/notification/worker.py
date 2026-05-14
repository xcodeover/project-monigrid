"""NotificationWorker.

Drains `monigrid_notification_queue` (status='pending') on a fixed interval
and submits each row to its channel via a small `ThreadPoolExecutor`. Lives
on a *separate* pool from `jdbc_executor` / `monitor_executor` so a slow SMTP
relay can never starve the monitoring path (L3 isolation).

Backoff is exponential (30s → 2m → 8m → 30m) for 4 attempts; the 5th failure
is marked 'dead' and surfaces via `count_dead_notifications_in_window` to
the meta-alarm loop.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, Future
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from .channels import Channel, ChannelSendError


_logger = logging.getLogger(__name__)
_FAULT = os.environ.get("MONIGRID_NOTIFICATION_FAULT", "").strip().lower()


_BACKOFF_SCHEDULE_SEC = (30, 120, 480, 1800)  # 30s, 2m, 8m, 30m
_MAX_ATTEMPTS = len(_BACKOFF_SCHEDULE_SEC) + 1  # initial + retries


class NotificationWorker:
    """ChannelProvider is any callable returning the live channel registry
    keyed by channel id (so 'reload settings' can rebuild the registry
    without touching the worker)."""

    def __init__(
        self,
        store: Any,  # SettingsStore
        *,
        channel_provider: Callable[[], dict[int, Channel]],
        poll_interval_sec: float = 30.0,
        max_workers: int = 4,
        batch_limit: int = 50,
    ) -> None:
        self._store = store
        self._channel_provider = channel_provider
        self._poll_interval_sec = float(poll_interval_sec)
        self._batch_limit = int(batch_limit)
        self._executor = ThreadPoolExecutor(
            max_workers=int(max_workers),
            thread_name_prefix="notif-worker",
        )
        self._stop_evt = threading.Event()
        self._loop_thread: threading.Thread | None = None

    def start(self) -> None:
        if self._loop_thread and self._loop_thread.is_alive():
            return
        self._stop_evt.clear()
        t = threading.Thread(
            target=self._loop, name="notification-worker-loop", daemon=True,
        )
        t.start()
        self._loop_thread = t
        _logger.info(
            "notification worker started (poll=%.1fs, batch=%d)",
            self._poll_interval_sec, self._batch_limit,
        )

    def stop(self, *, timeout: float = 5.0) -> None:
        self._stop_evt.set()
        if self._loop_thread is not None:
            self._loop_thread.join(timeout=timeout)
        # ThreadPoolExecutor.shutdown waits for in-flight tasks; cap is
        # the channel timeout (~15s) per task.
        self._executor.shutdown(wait=True, cancel_futures=True)
        _logger.info("notification worker stopped")

    # ── loop ─────────────────────────────────────────────────────────────
    def _loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                self._tick()
            except Exception:
                _logger.exception("notification worker tick failed")
            # Sleep in small slices so stop() is responsive.
            slept = 0.0
            while slept < self._poll_interval_sec and not self._stop_evt.is_set():
                time.sleep(min(0.5, self._poll_interval_sec - slept))
                slept += 0.5

    def _tick(self) -> None:
        try:
            batch = self._store.claim_pending_notifications(limit=self._batch_limit)
        except Exception:
            _logger.exception("claim_pending_notifications failed")
            return
        if not batch:
            return
        channels = self._channel_provider() or {}
        futures: list[Future] = []
        for item in batch:
            futures.append(self._executor.submit(self._deliver, item, channels))
        # We don't wait for futures — they update the queue row themselves.
        # Logging only: count submissions.
        _logger.info("notification worker submitted %d delivery tasks", len(futures))

    def _deliver(self, item: dict[str, Any], channels: dict[int, Channel]) -> None:
        queue_id = int(item["id"])
        channel_id = int(item["channelId"])
        attempt = int(item.get("attempt") or 0)
        try:
            if _FAULT == "fail":
                raise ChannelSendError("MONIGRID_NOTIFICATION_FAULT=fail (test)")
            channel = channels.get(channel_id)
            if channel is None:
                raise ChannelSendError(f"channel id {channel_id} not registered")
            channel.send(
                recipient_address=str(item["recipientAddress"]),
                subject=str(item["subject"]),
                body_html=str(item.get("bodyHtml") or ""),
                body_text=str(item.get("bodyText") or ""),
            )
            self._store.mark_notification_sent(queue_id)
            _logger.info(
                "notification %d sent to %s (channel %d, attempt %d)",
                queue_id, item["recipientAddress"], channel_id, attempt + 1,
            )
        except ChannelSendError as exc:
            self._handle_failure(queue_id, attempt, str(exc))
        except Exception as exc:
            # Unexpected — treat as a transport failure but log loudly.
            _logger.exception("notification %d delivery raised unexpectedly", queue_id)
            self._handle_failure(queue_id, attempt, f"unexpected: {exc}")

    def _handle_failure(self, queue_id: int, attempt: int, error: str) -> None:
        next_attempt_idx = attempt  # 0-indexed: attempt 0 done → use schedule[0]
        if next_attempt_idx >= len(_BACKOFF_SCHEDULE_SEC):
            try:
                self._store.mark_notification_failed(
                    queue_id, error=error, mark_dead=True, next_attempt_at=None,
                )
            except Exception:
                _logger.exception("failed to mark notification %d dead", queue_id)
            _logger.warning(
                "notification %d marked DEAD after %d attempts: %s",
                queue_id, attempt + 1, error,
            )
            return
        backoff = _BACKOFF_SCHEDULE_SEC[next_attempt_idx]
        next_at = datetime.now(timezone.utc) + timedelta(seconds=backoff)
        try:
            self._store.mark_notification_failed(
                queue_id, error=error, next_attempt_at=next_at, mark_dead=False,
            )
        except Exception:
            _logger.exception("failed to mark notification %d failed", queue_id)
        _logger.info(
            "notification %d retry scheduled in %ds (attempt %d/%d): %s",
            queue_id, backoff, attempt + 1, _MAX_ATTEMPTS, error,
        )

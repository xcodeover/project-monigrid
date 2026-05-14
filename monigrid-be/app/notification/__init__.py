"""Outbound notification subsystem.

Wires alert events emitted by `alert_evaluator` to external delivery channels
(SMTP today; Slack/Teams/Webhook are future adapters that plug into the same
`Channel` interface).

Layered for strict isolation from the monitoring hot path:

  AlertEvaluator._record_safe
        │ (fire-and-forget call, wrapped in try/except)
        ▼
  NotificationDispatcher.on_event
        │ (in-memory enqueue only, returns in microseconds)
        ▼
  NotificationWorker (separate ThreadPoolExecutor)
        │ rule match → silence/cooldown → INSERT into monigrid_notification_queue
        ▼
  Channel.send (SMTP/...) with hard 15s timeout, exponential backoff
"""

from .dispatcher import NotificationDispatcher
from .worker import NotificationWorker

__all__ = ["NotificationDispatcher", "NotificationWorker"]

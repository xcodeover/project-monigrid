"""Channel abstract base + result/error types.

A Channel takes a fully-rendered message (subject/body) plus a single
recipient address and either delivers it or raises. The dispatcher/worker
own retries, cooldown, and queue state — channels are pure transports.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any


class ChannelConfigError(Exception):
    """Raised when a channel's stored config is missing/invalid (e.g. SMTP
    host blank). Surfaces to UI as a 400 — operator action required."""


class ChannelSendError(Exception):
    """Raised when delivery itself fails (timeout, auth refused, 5xx).
    Surfaces to the worker which decides retry vs dead-letter."""


@dataclass(frozen=True)
class SendResult:
    ok: bool
    detail: str = ""


class Channel(abc.ABC):
    """One channel = one transport. Instantiated once at service start with
    decrypted config, reused by the worker pool."""

    kind: str = ""  # subclass MUST override (e.g. 'smtp')

    @abc.abstractmethod
    def send(
        self,
        *,
        recipient_address: str,
        subject: str,
        body_html: str,
        body_text: str,
        headers: dict[str, str] | None = None,
    ) -> SendResult:
        """Deliver one message. Raise ChannelSendError on transport failure."""
        raise NotImplementedError

    def health_check(self) -> SendResult:
        """Optional: verify config without sending (e.g. SMTP connect+QUIT).
        Default impl returns ok=True so subclasses opt in."""
        return SendResult(ok=True, detail="health check not implemented")

    @classmethod
    @abc.abstractmethod
    def from_config(cls, config: dict[str, Any]) -> "Channel":
        """Build a channel from decrypted config dict.
        Raise ChannelConfigError on missing/invalid fields."""
        raise NotImplementedError

"""SMTP channel adapter.

Plain stdlib (no extra deps). Hard 15s socket timeout — beyond that the
worker treats the attempt as a transport failure and retries on backoff.
Each send opens a fresh connection: SMTP is cheap relative to the 5-min
cooldown floor, and connection reuse adds reconnect-on-stale logic that
isn't worth the surface area.
"""
from __future__ import annotations

import logging
import smtplib
import socket
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any

from .base import Channel, ChannelConfigError, ChannelSendError, SendResult


_logger = logging.getLogger(__name__)
_DEFAULT_TIMEOUT_SEC = 15.0


class SmtpChannel(Channel):
    kind = "smtp"

    def __init__(
        self,
        *,
        host: str,
        port: int,
        use_tls: bool,
        use_ssl: bool,
        username: str | None,
        password: str | None,
        from_address: str,
        from_name: str | None,
        reply_to: str | None,
        timeout_sec: float = _DEFAULT_TIMEOUT_SEC,
    ) -> None:
        if not host:
            raise ChannelConfigError("smtp host is empty")
        if not from_address:
            raise ChannelConfigError("smtp from_address is empty")
        if use_tls and use_ssl:
            raise ChannelConfigError("smtp use_tls and use_ssl are mutually exclusive")
        self._host = host
        self._port = int(port)
        self._use_tls = bool(use_tls)
        self._use_ssl = bool(use_ssl)
        self._username = username or None
        self._password = password or None
        self._from_address = from_address
        self._from_name = from_name or None
        self._reply_to = reply_to or None
        self._timeout_sec = float(timeout_sec)

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "SmtpChannel":
        try:
            return cls(
                host=str(config.get("host", "")).strip(),
                port=int(config.get("port") or 587),
                use_tls=bool(config.get("use_tls", True)),
                use_ssl=bool(config.get("use_ssl", False)),
                username=config.get("username"),
                password=config.get("password"),
                from_address=str(config.get("from_address", "")).strip(),
                from_name=config.get("from_name"),
                reply_to=config.get("reply_to"),
                timeout_sec=float(config.get("timeout_sec") or _DEFAULT_TIMEOUT_SEC),
            )
        except ChannelConfigError:
            raise
        except Exception as exc:  # pragma: no cover — type coercion failure
            raise ChannelConfigError(f"invalid smtp config: {exc}") from exc

    def _from_header(self) -> str:
        if self._from_name:
            return formataddr((self._from_name, self._from_address))
        return self._from_address

    def _open(self) -> smtplib.SMTP:
        if self._use_ssl:
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                self._host, self._port, timeout=self._timeout_sec
            )
        else:
            client = smtplib.SMTP(self._host, self._port, timeout=self._timeout_sec)
        if self._use_tls and not self._use_ssl:
            client.starttls()
        if self._username:
            client.login(self._username, self._password or "")
        return client

    def health_check(self) -> SendResult:
        try:
            client = self._open()
        except (socket.timeout, OSError, smtplib.SMTPException) as exc:
            return SendResult(ok=False, detail=f"connect failed: {exc}")
        try:
            client.noop()
        except smtplib.SMTPException as exc:
            return SendResult(ok=False, detail=f"NOOP failed: {exc}")
        finally:
            try:
                client.quit()
            except Exception:
                pass
        return SendResult(ok=True, detail=f"connected to {self._host}:{self._port}")

    def send(
        self,
        *,
        recipient_address: str,
        subject: str,
        body_html: str,
        body_text: str,
        headers: dict[str, str] | None = None,
    ) -> SendResult:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = self._from_header()
        msg["To"] = recipient_address
        msg["Message-ID"] = make_msgid(domain=self._from_address.split("@")[-1] or None)
        if self._reply_to:
            msg["Reply-To"] = self._reply_to
        for k, v in (headers or {}).items():
            msg[k] = v
        msg.set_content(body_text or "")
        if body_html:
            msg.add_alternative(body_html, subtype="html")

        try:
            client = self._open()
        except (socket.timeout, OSError, smtplib.SMTPException) as exc:
            raise ChannelSendError(f"smtp connect failed: {exc}") from exc
        try:
            client.send_message(msg)
        except smtplib.SMTPException as exc:
            raise ChannelSendError(f"smtp send failed: {exc}") from exc
        finally:
            try:
                client.quit()
            except Exception:
                pass
        return SendResult(ok=True, detail=f"sent to {recipient_address}")

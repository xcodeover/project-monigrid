"""Notification subsystem endpoints (Phase 6).

Surface area:
    GET/PUT  /dashboard/notifications/global        — master enable toggle
    GET/PUT  /dashboard/notifications/channels[/kind]
    GET      /dashboard/notifications/channels/<kind>/config (admin)
    POST     /dashboard/notifications/channels/<kind>/test (admin)
    GET/POST /dashboard/notifications/groups
    PUT/DEL  /dashboard/notifications/groups/<id>
    GET/POST /dashboard/notifications/groups/<id>/recipients
    PUT/DEL  /dashboard/notifications/recipients/<id>
    GET/POST /dashboard/notifications/rules
    GET/PUT/DEL /dashboard/notifications/rules/<id>
    GET/POST /dashboard/notifications/silences
    GET      /dashboard/notifications/silences/active
    DEL      /dashboard/notifications/silences/<id>
    GET      /dashboard/notifications/queue
    POST     /dashboard/notifications/queue/<id>/retry|cancel
    GET      /dashboard/notifications/stats
    POST     /dashboard/notifications/send-now (admin)

All mutations are admin-only. Reads are auth-only. Channel config GET strips
the password field — the UI re-supplies it on PUT (empty string = leave the
stored password alone).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from flask import jsonify, request

from app.auth import require_admin, require_auth
from app.notification.crypto import decrypt_dict


# ── ReDoS guard ─────────────────────────────────────────────────────────────
#
# The dispatcher worker thread evaluates user-supplied patterns
# (`sourceIdPattern`, `metricPattern`) against every alert event via
# ``re.fullmatch``. A catastrophic pattern like ``(a+)+$`` against a long
# input stalls the worker for seconds-to-minutes; with `max_workers=4`,
# four such patterns freeze the entire notification pipeline (TLO-class).
#
# Defense in depth: validate at save time so the bad pattern never reaches
# the dispatcher. Cheap heuristics catch the common footgun shapes; an
# in-thread regex timeout would be ideal but Python's `re` doesn't support
# one without C-level monkey-patching.

_REGEX_MAX_LEN = 128

# Nested unbounded quantifier — group containing `+`/`*`/`{...}` followed by
# another outer `+`/`*`/`{...}`. Examples caught: `(a+)+`, `(.*)+`, `(\w+)*`,
# `(x{1,})+`. False-positive risk: `(a{3})+` (bounded inner) is also rejected
# even though it's safe — acceptable trade-off given that bounded-bounded
# nesting is rarely intentional in monitoring patterns. Operators can flatten
# to `a{3}{0,}` form or remove the outer quantifier.
_NESTED_QUANTIFIER = re.compile(r"\([^)]*[*+{][^)]*\)\s*[*+{]")


def _validate_regex_pattern(value, *, field: str):
    """Validate a user-supplied regex going into a rule. Returns the trimmed
    string (or None for empty/None input). Raises ``ValueError`` on reject.

    Pre-flight pattern hygiene — applied at every rule create/update site.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) > _REGEX_MAX_LEN:
        raise ValueError(
            f"{field}: 패턴이 너무 깁니다 (최대 {_REGEX_MAX_LEN}자, 현재 {len(s)})"
        )
    if _NESTED_QUANTIFIER.search(s):
        raise ValueError(
            f"{field}: 중첩된 반복 한정자 (catastrophic backtracking 위험) — "
            "예: (a+)+, (.*)+. 단순한 형태로 다시 작성하세요."
        )
    try:
        re.compile(s)
    except re.error as exc:
        raise ValueError(f"{field}: 유효하지 않은 정규식 — {exc}")
    return s


# ── helpers ───────────────────────────────────────────────────────────────────


def _json_body() -> dict:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def _str_or_none(value) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _bool_or_default(value, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    s = str(value).strip().lower()
    return s in ("1", "true", "yes", "on")


def _int_or_default(value, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _actor_username(backend) -> str:
    from app.auth import current_username
    try:
        return current_username() or ""
    except Exception:
        return ""


def _strip_secrets_from_config(plain: dict) -> dict:
    safe = dict(plain)
    if "password" in safe:
        safe["password"] = ""
    return safe


def _parse_iso(value) -> datetime | None:
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def register(app, backend, limiter) -> None:
    # ── global toggle ────────────────────────────────────────────────
    @app.route("/dashboard/notifications/global", methods=["GET"])
    @require_auth
    def get_notification_global():
        try:
            return jsonify(backend.get_notification_global()), 200
        except Exception:
            backend.logger.exception("get_notification_global failed")
            return jsonify({"message": "global toggle read failed"}), 500

    @app.route("/dashboard/notifications/global", methods=["PUT"])
    @require_admin
    def put_notification_global():
        body = _json_body()
        if "enabled" not in body:
            return jsonify({"message": "field 'enabled' required"}), 400
        try:
            result = backend.set_notification_global(
                enabled=bool(body.get("enabled")),
                actor=_actor_username(backend),
            )
            return jsonify(result), 200
        except Exception as exc:
            backend.logger.exception("set_notification_global failed")
            return jsonify({"message": f"global toggle write failed: {exc}"}), 500

    # ── channels ─────────────────────────────────────────────────────
    @app.route("/dashboard/notifications/channels", methods=["GET"])
    @require_auth
    def list_notification_channels():
        try:
            rows = backend.settings_store.list_notification_channels()
        except Exception:
            backend.logger.exception("list_notification_channels failed")
            return jsonify({"message": "channel list failed"}), 500
        # Strip the encrypted blob — UI doesn't need it for the list.
        for r in rows:
            r.pop("configEncrypted", None)
        return jsonify({"channels": rows}), 200

    @app.route("/dashboard/notifications/channels/<kind>/config", methods=["GET"])
    @require_admin
    def get_notification_channel_config(kind):
        try:
            row = backend.settings_store.get_notification_channel(kind)
        except Exception:
            backend.logger.exception("get_notification_channel failed kind=%s", kind)
            return jsonify({"message": "channel read failed"}), 500
        if row is None:
            return jsonify({"message": "channel not configured"}), 404
        try:
            cfg = decrypt_dict(row.get("configEncrypted") or "")
        except Exception:
            backend.logger.exception("channel decrypt failed kind=%s", kind)
            return jsonify({"message": "channel decrypt failed"}), 500
        return jsonify({
            "kind": kind,
            "enabled": bool(row.get("enabled")),
            "config": _strip_secrets_from_config(cfg),
            "updatedAt": row.get("updatedAt"),
            "updatedBy": row.get("updatedBy"),
        }), 200

    @app.route("/dashboard/notifications/channels/<kind>", methods=["PUT"])
    @require_admin
    def put_notification_channel(kind):
        body = _json_body()
        cfg_in = body.get("config") if isinstance(body.get("config"), dict) else {}
        enabled = bool(body.get("enabled", True))
        # Empty password means "keep existing" — fetch current and merge.
        # IMPORTANT: if decrypt fails (master key rotated past all configured
        # keys, or DB tampered), we MUST refuse the save — silently writing
        # an empty password was a real bug that broke SMTP for ops who
        # rotated MONIGRID_SECRET_KEY without supplying the old key via
        # MONIGRID_SECRET_KEYS. Return 409 with a clear remediation path.
        if cfg_in.get("password", None) == "":
            try:
                existing = backend.settings_store.get_notification_channel(kind)
                if existing and existing.get("configEncrypted"):
                    try:
                        prior = decrypt_dict(existing["configEncrypted"])
                    except ValueError as exc:
                        backend.logger.warning(
                            "channel save refused kind=%s — prior decrypt failed: %s",
                            kind, exc,
                        )
                        return jsonify({
                            "message": "기존 채널 설정의 비밀번호를 복호화할 수 없습니다. "
                                       "마스터 키(MONIGRID_SECRET_KEY) 가 회전된 것 같습니다. "
                                       "이전 키를 MONIGRID_SECRET_KEYS=신규,이전 형태로 추가한 뒤 "
                                       "재시도하거나, 비밀번호 필드에 새 값을 직접 입력하세요.",
                            "code": "PRIOR_DECRYPT_FAILED",
                        }), 409
                    cfg_in = dict(cfg_in)
                    cfg_in["password"] = prior.get("password", "")
            except Exception:
                backend.logger.exception("merge prior channel password failed kind=%s", kind)
                return jsonify({"message": "기존 채널 설정 조회에 실패했습니다."}), 500
        try:
            result = backend.save_notification_channel(
                kind=kind, enabled=enabled,
                plain_config=cfg_in, actor=_actor_username(backend),
            )
            return jsonify(result), 200
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("save_notification_channel failed kind=%s", kind)
            return jsonify({"message": f"channel write failed: {exc}"}), 500

    @app.route("/dashboard/notifications/channels/<kind>/test", methods=["POST"])
    @require_admin
    def test_notification_channel(kind):
        body = _json_body()
        recipient = _str_or_none(body.get("recipient"))
        if not recipient:
            return jsonify({"message": "field 'recipient' required"}), 400
        try:
            result = backend.send_test_email(channel_kind=kind, recipient=recipient)
            status = 200 if result.get("ok") else 502
            return jsonify(result), status
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("test_notification_channel failed kind=%s", kind)
            return jsonify({"message": f"test send failed: {exc}"}), 500

    # ── groups ───────────────────────────────────────────────────────
    @app.route("/dashboard/notifications/groups", methods=["GET"])
    @require_auth
    def list_notification_groups():
        try:
            return jsonify({"groups": backend.settings_store.list_notification_groups()}), 200
        except Exception:
            backend.logger.exception("list_notification_groups failed")
            return jsonify({"message": "group list failed"}), 500

    @app.route("/dashboard/notifications/groups", methods=["POST"])
    @require_admin
    def create_notification_group():
        body = _json_body()
        try:
            new_id = backend.settings_store.create_notification_group(
                name=str(body.get("name") or "").strip(),
                description=_str_or_none(body.get("description")),
                enabled=bool(body.get("enabled", True)),
                actor=_actor_username(backend),
            )
            return jsonify({"id": new_id}), 201
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("create_notification_group failed")
            return jsonify({"message": f"group create failed: {exc}"}), 500

    @app.route("/dashboard/notifications/groups/<int:group_id>", methods=["PUT"])
    @require_admin
    def update_notification_group(group_id):
        body = _json_body()
        try:
            backend.settings_store.update_notification_group(
                group_id,
                name=body.get("name") if "name" in body else None,
                description=body.get("description") if "description" in body else None,
                enabled=body.get("enabled") if "enabled" in body else None,
                actor=_actor_username(backend),
            )
            return jsonify({"id": group_id}), 200
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("update_notification_group failed id=%s", group_id)
            return jsonify({"message": f"group update failed: {exc}"}), 500

    @app.route("/dashboard/notifications/groups/<int:group_id>", methods=["DELETE"])
    @require_admin
    def delete_notification_group(group_id):
        try:
            # Refuse if any rule still points at this group.
            rules = backend.settings_store.list_notification_rules()
            in_use = [r for r in rules if int(r.get("recipientGroupId") or 0) == group_id]
            if in_use:
                return jsonify({
                    "message": "group still referenced by rules",
                    "ruleIds": [r["id"] for r in in_use],
                }), 409
            backend.settings_store.delete_notification_group(group_id)
            return ("", 204)
        except Exception as exc:
            backend.logger.exception("delete_notification_group failed id=%s", group_id)
            return jsonify({"message": f"group delete failed: {exc}"}), 500

    # ── recipients ───────────────────────────────────────────────────
    @app.route("/dashboard/notifications/groups/<int:group_id>/recipients", methods=["GET"])
    @require_auth
    def list_notification_recipients(group_id):
        try:
            return jsonify({
                "recipients": backend.settings_store.list_notification_recipients(group_id=group_id),
            }), 200
        except Exception:
            backend.logger.exception("list_notification_recipients failed")
            return jsonify({"message": "recipient list failed"}), 500

    @app.route("/dashboard/notifications/groups/<int:group_id>/recipients", methods=["POST"])
    @require_admin
    def create_notification_recipient(group_id):
        body = _json_body()
        try:
            new_id = backend.settings_store.create_notification_recipient(
                group_id=group_id,
                kind=str(body.get("kind") or "email"),
                address=str(body.get("address") or "").strip(),
                display_name=_str_or_none(body.get("displayName")),
                enabled=bool(body.get("enabled", True)),
            )
            return jsonify({"id": new_id}), 201
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("create_notification_recipient failed")
            return jsonify({"message": f"recipient create failed: {exc}"}), 500

    @app.route("/dashboard/notifications/recipients/<int:recipient_id>", methods=["PUT"])
    @require_admin
    def update_notification_recipient(recipient_id):
        body = _json_body()
        try:
            backend.settings_store.update_notification_recipient(
                recipient_id,
                kind=body.get("kind") if "kind" in body else None,
                address=body.get("address") if "address" in body else None,
                display_name=body.get("displayName") if "displayName" in body else None,
                enabled=body.get("enabled") if "enabled" in body else None,
            )
            return jsonify({"id": recipient_id}), 200
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("update_notification_recipient failed id=%s", recipient_id)
            return jsonify({"message": f"recipient update failed: {exc}"}), 500

    @app.route("/dashboard/notifications/recipients/<int:recipient_id>", methods=["DELETE"])
    @require_admin
    def delete_notification_recipient(recipient_id):
        try:
            backend.settings_store.delete_notification_recipient(recipient_id)
            return ("", 204)
        except Exception as exc:
            backend.logger.exception("delete_notification_recipient failed id=%s", recipient_id)
            return jsonify({"message": f"recipient delete failed: {exc}"}), 500

    # ── rules ────────────────────────────────────────────────────────
    @app.route("/dashboard/notifications/rules", methods=["GET"])
    @require_auth
    def list_notification_rules():
        try:
            return jsonify({"rules": backend.settings_store.list_notification_rules()}), 200
        except Exception:
            backend.logger.exception("list_notification_rules failed")
            return jsonify({"message": "rule list failed"}), 500

    @app.route("/dashboard/notifications/rules/<int:rule_id>", methods=["GET"])
    @require_auth
    def get_notification_rule(rule_id):
        try:
            row = backend.settings_store.get_notification_rule(rule_id)
        except Exception:
            backend.logger.exception("get_notification_rule failed id=%s", rule_id)
            return jsonify({"message": "rule read failed"}), 500
        if row is None:
            return jsonify({"message": "rule not found"}), 404
        return jsonify(row), 200

    @app.route("/dashboard/notifications/rules", methods=["POST"])
    @require_admin
    def create_notification_rule():
        body = _json_body()
        try:
            new_id = backend.settings_store.create_notification_rule(
                name=str(body.get("name") or "").strip(),
                source_type=_str_or_none(body.get("sourceType")),
                source_id_pattern=_validate_regex_pattern(
                    body.get("sourceIdPattern"), field="sourceIdPattern",
                ),
                metric_pattern=_validate_regex_pattern(
                    body.get("metricPattern"), field="metricPattern",
                ),
                min_level=str(body.get("minLevel") or "warn"),
                recipient_group_id=int(body.get("recipientGroupId") or 0),
                channel_id=int(body.get("channelId") or 0),
                cooldown_sec=_int_or_default(body.get("cooldownSec"), 300),
                digest_window_sec=_int_or_default(body.get("digestWindowSec"), 0),
                send_on_clear=bool(body.get("sendOnClear", False)),
                enabled=bool(body.get("enabled", True)),
                actor=_actor_username(backend),
            )
            return jsonify({"id": new_id}), 201
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("create_notification_rule failed")
            return jsonify({"message": f"rule create failed: {exc}"}), 500

    @app.route("/dashboard/notifications/rules/<int:rule_id>", methods=["PUT"])
    @require_admin
    def update_notification_rule(rule_id):
        body = _json_body()
        kwargs = {}
        for src, dst in (
            ("name", "name"),
            ("enabled", "enabled"),
            ("sourceType", "source_type"),
            ("sourceIdPattern", "source_id_pattern"),
            ("metricPattern", "metric_pattern"),
            ("minLevel", "min_level"),
            ("recipientGroupId", "recipient_group_id"),
            ("channelId", "channel_id"),
            ("cooldownSec", "cooldown_sec"),
            ("digestWindowSec", "digest_window_sec"),
            ("sendOnClear", "send_on_clear"),
        ):
            if src in body:
                kwargs[dst] = body[src]
        # ReDoS guard on pattern fields (only when present in the patch).
        try:
            if "source_id_pattern" in kwargs:
                kwargs["source_id_pattern"] = _validate_regex_pattern(
                    kwargs["source_id_pattern"], field="sourceIdPattern",
                )
            if "metric_pattern" in kwargs:
                kwargs["metric_pattern"] = _validate_regex_pattern(
                    kwargs["metric_pattern"], field="metricPattern",
                )
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        try:
            backend.settings_store.update_notification_rule(
                rule_id, actor=_actor_username(backend), **kwargs,
            )
            return jsonify({"id": rule_id}), 200
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("update_notification_rule failed id=%s", rule_id)
            return jsonify({"message": f"rule update failed: {exc}"}), 500

    @app.route("/dashboard/notifications/rules/<int:rule_id>", methods=["DELETE"])
    @require_admin
    def delete_notification_rule(rule_id):
        try:
            backend.settings_store.delete_notification_rule(rule_id)
            return ("", 204)
        except Exception as exc:
            backend.logger.exception("delete_notification_rule failed id=%s", rule_id)
            return jsonify({"message": f"rule delete failed: {exc}"}), 500

    # ── silence rules ────────────────────────────────────────────────
    @app.route("/dashboard/notifications/silences", methods=["GET"])
    @require_auth
    def list_silence_rules():
        try:
            return jsonify({"silences": backend.settings_store.list_silence_rules()}), 200
        except Exception:
            backend.logger.exception("list_silence_rules failed")
            return jsonify({"message": "silence list failed"}), 500

    @app.route("/dashboard/notifications/silences/active", methods=["GET"])
    @require_auth
    def list_active_silence_rules():
        try:
            return jsonify({
                "silences": backend.settings_store.list_active_silence_rules(),
            }), 200
        except Exception:
            backend.logger.exception("list_active_silence_rules failed")
            return jsonify({"message": "active silence list failed"}), 500

    @app.route("/dashboard/notifications/silences", methods=["POST"])
    @require_admin
    def create_silence_rule():
        body = _json_body()
        starts = _parse_iso(body.get("startsAt"))
        ends = _parse_iso(body.get("endsAt"))
        # Convenience: { hours: N } creates a starts=now, ends=now+N silence.
        if (starts is None or ends is None) and body.get("hours") is not None:
            try:
                hours = float(body["hours"])
            except (TypeError, ValueError):
                return jsonify({"message": "field 'hours' must be a number"}), 400
            starts = datetime.now(timezone.utc)
            from datetime import timedelta as _td
            ends = starts + _td(hours=hours)
        if starts is None or ends is None:
            return jsonify({
                "message": "either (startsAt, endsAt) or hours must be provided",
            }), 400
        try:
            new_id = backend.settings_store.create_silence_rule(
                name=str(body.get("name") or "").strip(),
                source_type=_str_or_none(body.get("sourceType")),
                source_id_pattern=_validate_regex_pattern(
                    body.get("sourceIdPattern"), field="sourceIdPattern",
                ),
                metric_pattern=_validate_regex_pattern(
                    body.get("metricPattern"), field="metricPattern",
                ),
                starts_at=starts, ends_at=ends,
                reason=_str_or_none(body.get("reason")),
                actor=_actor_username(backend),
            )
            return jsonify({"id": new_id}), 201
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("create_silence_rule failed")
            return jsonify({"message": f"silence create failed: {exc}"}), 500

    @app.route("/dashboard/notifications/silences/<int:silence_id>", methods=["DELETE"])
    @require_admin
    def delete_silence_rule(silence_id):
        try:
            backend.settings_store.delete_silence_rule(silence_id)
            return ("", 204)
        except Exception as exc:
            backend.logger.exception("delete_silence_rule failed id=%s", silence_id)
            return jsonify({"message": f"silence delete failed: {exc}"}), 500

    # ── queue ────────────────────────────────────────────────────────
    # admin-only: queue rows expose recipient_address + subject + (stripped)
    # body + last_error per item. Even with body stripped, the recipient
    # address list is a sensitive internal contacts disclosure and the
    # subject can leak alarm content / metric values. Restrict to admin so
    # regular users can't enumerate who got notified about what.
    @app.route("/dashboard/notifications/queue", methods=["GET"])
    @require_admin
    def list_notification_queue():
        args = request.args
        status = _str_or_none(args.get("status"))
        try:
            result = backend.settings_store.list_notification_queue(
                status=status,
                limit=_int_or_default(args.get("limit"), 200),
                offset=_int_or_default(args.get("offset"), 0),
            )
            # Strip body fields from list response — they can be huge. Caller
            # can fetch a single item if it needs the full body.
            for it in result.get("items", []):
                it["bodyHtml"] = ""
                it["bodyText"] = ""
            return jsonify(result), 200
        except Exception:
            backend.logger.exception("list_notification_queue failed")
            return jsonify({"message": "queue list failed"}), 500

    @app.route("/dashboard/notifications/queue/<int:queue_id>/retry", methods=["POST"])
    @require_admin
    def retry_notification_queue_item(queue_id):
        try:
            updated = backend.settings_store.retry_notification_queue_item(queue_id)
            return jsonify({"id": queue_id, "retried": updated}), 200
        except Exception as exc:
            backend.logger.exception("retry queue item failed id=%s", queue_id)
            return jsonify({"message": f"retry failed: {exc}"}), 500

    @app.route("/dashboard/notifications/queue/<int:queue_id>/cancel", methods=["POST"])
    @require_admin
    def cancel_notification_queue_item(queue_id):
        try:
            updated = backend.settings_store.cancel_notification_queue_item(queue_id)
            return jsonify({"id": queue_id, "cancelled": updated}), 200
        except Exception as exc:
            backend.logger.exception("cancel queue item failed id=%s", queue_id)
            return jsonify({"message": f"cancel failed: {exc}"}), 500

    # ── stats ────────────────────────────────────────────────────────
    @app.route("/dashboard/notifications/stats", methods=["GET"])
    @require_auth
    def notification_stats():
        try:
            disp = backend.get_notification_dispatcher_stats()
        except Exception:
            backend.logger.exception("dispatcher stats failed")
            disp = {}
        # Window/threshold come from the meta-monitor (env-tunable). FE uses
        # these to draw the "dead alert" banner with the same numbers BE is
        # actually evaluating against, instead of a hard-coded 24h / 100.
        dead_window_sec = int(getattr(backend, "_NOTIF_META_WINDOW_SEC", 24 * 3600))
        dead_threshold = int(getattr(backend, "_NOTIF_META_THRESHOLD", 100))
        try:
            dead_24h = backend.settings_store.count_dead_notifications_in_window(
                window_seconds=dead_window_sec,
            )
        except Exception:
            backend.logger.exception("dead count failed")
            dead_24h = 0
        try:
            queue_counts = {}
            for s in ("pending", "sending", "sent", "failed", "dead", "cancelled"):
                queue_counts[s] = backend.settings_store.list_notification_queue(
                    status=s, limit=1, offset=0,
                ).get("totalCount", 0)
        except Exception:
            backend.logger.exception("queue counts failed")
            queue_counts = {}
        return jsonify({
            "dispatcher": disp,
            "queueCounts": queue_counts,
            "deadIn24h": dead_24h,
            "deadWindowSec": dead_window_sec,
            "deadThreshold": dead_threshold,
        }), 200

    # ── send-now (one-shot, bypass rules) ────────────────────────────
    @app.route("/dashboard/notifications/send-now", methods=["POST"])
    @require_admin
    def send_notification_now():
        """Operator escape hatch — immediately enqueue an alert to specific
        recipients, bypassing rule matching / cooldown / silence.

        Security posture:
        - Recipients MUST be a subset of currently enabled rows in
          ``monigrid_notification_recipients``. Without this guard, an
          attacker holding an admin token (or a malicious insider) can turn
          the configured SMTP server into an open relay branded with
          ``from_address``. We refuse arbitrary recipients even for admins.
        - Every accepted send is audit-logged (actor + addresses + count)
          so post-incident forensics has a trail. The log goes to the
          standard backend logger at INFO level (already daily-rotated +
          tail-able via /logs) — no new DB table required.
        """
        body = _json_body()
        event = body.get("event") if isinstance(body.get("event"), dict) else None
        channel_id = body.get("channelId")
        recipients = body.get("recipients") if isinstance(body.get("recipients"), list) else []
        if not event:
            return jsonify({"message": "field 'event' required"}), 400
        if not channel_id:
            return jsonify({"message": "field 'channelId' required"}), 400
        addresses = [str(a).strip() for a in recipients if str(a).strip()]
        if not addresses:
            return jsonify({"message": "field 'recipients' must contain at least one address"}), 400

        # ── recipient allowlist enforcement ──────────────────────────────
        # Build allowlist from enabled rows across ALL groups. /send-now is
        # not scoped to a single group (the operator may want a cross-group
        # one-shot), so enabled-anywhere is the right grain.
        try:
            all_recipients = backend.settings_store.list_notification_recipients()
        except Exception:
            backend.logger.exception("send_notification_now: recipient list lookup failed")
            return jsonify({"message": "recipient allowlist lookup failed"}), 500
        allowlist = {
            str(r.get("address", "")).strip().lower()
            for r in all_recipients
            if r.get("enabled") and str(r.get("address", "")).strip()
        }
        rejected = [a for a in addresses if a.lower() not in allowlist]
        if rejected:
            backend.logger.warning(
                "send_notification_now refused — recipient(s) not in allowlist: "
                "actor=%s rejected=%s channel=%s",
                _actor_username(backend), rejected, channel_id,
            )
            return jsonify({
                "message": "one or more recipients are not in the enabled "
                           "recipient table; refusing to send",
                "rejected": rejected,
            }), 403

        actor = _actor_username(backend)
        try:
            result = backend.send_notification_now(
                alert_event=event,
                channel_id=int(channel_id),
                recipient_addresses=addresses,
            )
            # Audit log AFTER successful enqueue so failures don't pollute
            # the trail with non-deliveries.
            backend.logger.info(
                "send_notification_now AUDIT actor=%s channel=%s recipients=%s "
                "alarmSource=%s/%s queued=%s",
                actor or "(unknown)", channel_id, addresses,
                event.get("source_type"), event.get("source_id"),
                result.get("count"),
            )
            return jsonify(result), 202
        except ValueError as exc:
            return jsonify({"message": str(exc)}), 400
        except Exception as exc:
            backend.logger.exception("send_notification_now failed")
            return jsonify({"message": f"send-now failed: {exc}"}), 500

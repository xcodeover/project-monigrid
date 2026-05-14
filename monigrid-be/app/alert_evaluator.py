"""Backend alert evaluator.

Phase 1 scope: monitor target collector emits a snapshot, this evaluator
classifies it as healthy / violating per metric and records raise/clear
transitions to the settings DB. Same-state ticks are deduped in-memory
(``_active``) so the alert table stays a transition log, not a sample log.

Future phases (post Phase 1) will extend this to data API widgets once
those thresholds are centralised in the BE config.

Wiring contract:
    - The collector calls ``evaluate(snapshot)`` on the same thread that
      just produced the snapshot. Evaluation is light (just comparisons +
      one INSERT per transition) so this stays cheap.
    - Failures inside the evaluator MUST NOT propagate up to the
      collector — the collector's own metrics path is the source of
      truth and should not crash on alert-store hiccups.
    - ``forget(source_id)`` is called from ``remove_target`` so a deleted
      target doesn't sit in ``_active`` forever. We deliberately do NOT
      emit a clear event on delete — operator-driven removal isn't a
      "recovery" signal.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
import threading
from typing import Any

from .monitor_collector_manager import MonitorSnapshot


# ── violation detection ───────────────────────────────────────────────────────

# Sentinel returned by the per-type evaluators when the data shape is
# unrecognised — distinct from "no violations" (= empty list) so we don't
# emit spurious clear events while a probe is bootstrapping.
_INDETERMINATE = None


def _server_resource_violations(
    *, data: Any, criteria: dict[str, Any] | None,
) -> list[dict[str, Any]] | None:
    """Return list of metric violations for server_resource snapshot data.

    Each violation: {metric, value, threshold, message}.
    metric examples: "cpu", "memory", "disk:/", "disk:C:".
    Returns None if data is not yet usable (probe pending / error).
    """
    if not isinstance(data, dict):
        return _INDETERMINATE
    if data.get("error"):
        # Probe-level error is reported by the network/http path separately;
        # for server_resource we treat it as indeterminate so we don't fire
        # spurious threshold alarms when SSH isn't even reachable.
        return _INDETERMINATE
    crit = criteria or {}
    out: list[dict[str, Any]] = []
    cpu = data.get("cpu") or {}
    mem = data.get("memory") or {}
    disks = data.get("disks") or []

    cpu_pct = cpu.get("usedPct") if isinstance(cpu, dict) else None
    cpu_th = crit.get("cpu")
    if cpu_pct is not None and cpu_th is not None:
        try:
            if float(cpu_pct) >= float(cpu_th):
                out.append({
                    "metric": "cpu",
                    "value": float(cpu_pct),
                    "threshold": float(cpu_th),
                    "message": f"CPU {cpu_pct}% ≥ {cpu_th}%",
                })
        except (TypeError, ValueError):
            pass

    mem_pct = mem.get("usedPct") if isinstance(mem, dict) else None
    mem_th = crit.get("memory")
    if mem_pct is not None and mem_th is not None:
        try:
            if float(mem_pct) >= float(mem_th):
                out.append({
                    "metric": "memory",
                    "value": float(mem_pct),
                    "threshold": float(mem_th),
                    "message": f"Memory {mem_pct}% ≥ {mem_th}%",
                })
        except (TypeError, ValueError):
            pass

    disk_th = crit.get("disk")
    if disk_th is not None and isinstance(disks, list):
        for dk in disks:
            if not isinstance(dk, dict):
                continue
            mount = dk.get("mount") or "/"
            pct = dk.get("usedPct")
            if pct is None:
                continue
            try:
                if float(pct) >= float(disk_th):
                    out.append({
                        "metric": f"disk:{mount}",
                        "value": float(pct),
                        "threshold": float(disk_th),
                        "message": f"Disk {mount} {pct}% ≥ {disk_th}%",
                    })
            except (TypeError, ValueError):
                continue
    return out


def _network_violations(*, data: Any) -> list[dict[str, Any]] | None:
    if not isinstance(data, dict):
        return _INDETERMINATE
    success = data.get("success")
    if success is None:
        return _INDETERMINATE
    if success is False:
        msg = data.get("message") or data.get("error") or "probe failed"
        return [{
            "metric": "probe",
            "value": None,
            "threshold": None,
            "message": str(msg),
        }]
    return []


def _http_status_violations(*, data: Any) -> list[dict[str, Any]] | None:
    if not isinstance(data, dict):
        return _INDETERMINATE
    ok = data.get("ok")
    if ok is None:
        return _INDETERMINATE
    if ok is False:
        msg = data.get("error") or f"HTTP {data.get('httpStatus')}"
        return [{
            "metric": "probe",
            "value": data.get("httpStatus"),
            "threshold": None,
            "message": str(msg),
        }]
    return []


# ── data API row evaluation ───────────────────────────────────────────────────
#
# Phase 2: evaluate the rows returned by a data API endpoint against the
# widget_configs.thresholds list. A "row violates" if the threshold's
# operator/value matches the cell at threshold.column.
#
# Operators: =, !=, >, >=, <, <=, contains.
# Numeric ops fall back to string compare on TypeError so non-numeric
# columns (status codes, labels) still work with "=" and "contains".


def _coerce_pair_for_compare(cell: Any, threshold_value: Any) -> tuple[float, float] | None:
    try:
        return float(cell), float(threshold_value)
    except (TypeError, ValueError):
        return None


def _row_matches_threshold(cell: Any, operator: str, threshold_value: Any) -> bool:
    """Return True if the cell satisfies the threshold's operator/value."""
    if cell is None:
        return False
    op = (str(operator) if operator is not None else "").strip()

    if op in (">", ">=", "<", "<="):
        pair = _coerce_pair_for_compare(cell, threshold_value)
        if pair is None:
            return False
        c, t = pair
        if op == ">":
            return c > t
        if op == ">=":
            return c >= t
        if op == "<":
            return c < t
        if op == "<=":
            return c <= t
    if op in ("=", "==", "eq"):
        pair = _coerce_pair_for_compare(cell, threshold_value)
        if pair is not None:
            return pair[0] == pair[1]
        return str(cell) == str(threshold_value)
    if op in ("!=", "<>", "ne"):
        pair = _coerce_pair_for_compare(cell, threshold_value)
        if pair is not None:
            return pair[0] != pair[1]
        return str(cell) != str(threshold_value)
    if op == "contains":
        if threshold_value is None:
            return False
        return str(threshold_value) in str(cell)
    return False


def _data_api_violations(
    *, rows: Any, thresholds: list[dict[str, Any]],
) -> list[dict[str, Any]] | None:
    """Return the list of metric violations or None when shape is unusable.

    A threshold violates if ANY row in ``rows`` satisfies its predicate.
    The first offending row's value is captured for reporting.
    """
    if not isinstance(rows, list):
        # Data APIs usually return list[dict]. Non-list shapes (e.g. {"updated": N})
        # are not row-oriented and Phase 2 thresholds don't have semantics for
        # them — treat as indeterminate so we don't fire spurious clears.
        return _INDETERMINATE
    out: list[dict[str, Any]] = []
    for th in thresholds:
        if not isinstance(th, dict):
            continue
        column = th.get("column")
        operator = th.get("operator")
        threshold_value = th.get("value")
        if not column or not operator:
            continue
        offending_row: dict[str, Any] | None = None
        for r in rows:
            if not isinstance(r, dict):
                continue
            cell = r.get(column)
            if _row_matches_threshold(cell, operator, threshold_value):
                offending_row = r
                break
        if offending_row is None:
            continue
        cell_value = offending_row.get(column)
        message = th.get("message") or (
            f"{column} {cell_value} {operator} {threshold_value}"
        )
        out.append({
            "metric": str(column),
            "operator": str(operator),
            "value": cell_value,
            "threshold": threshold_value,
            "level": str(th.get("level") or "warn"),
            "message": str(message),
            "row": offending_row,
        })
    return out


# ── evaluator ─────────────────────────────────────────────────────────────────


class AlertEvaluator:
    """In-memory transition tracker + settings-DB writer.

    Active set is keyed by ``(source_type, source_id, metric)``. The first
    time a violation appears we emit a "raise" event and remember the key;
    the first sample without that violation emits a "clear" event and drops
    the key. This keeps the alert table a transition log even if the
    collector ticks every 5 s for a target stuck in alarm for hours.
    """

    def __init__(
        self,
        *,
        settings_store,
        logger: logging.Logger,
        notify_sink=None,
    ) -> None:
        self._store = settings_store
        self._logger = logger
        self._active: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._lock = threading.RLock()
        # Optional fire-and-forget callable invoked after a transition is
        # successfully recorded. Wrapped in try/except so notification
        # subsystem failures never affect the monitoring hot path. See
        # notification/dispatcher.py for the receiver side.
        self._notify_sink = notify_sink

    def set_notify_sink(self, sink) -> None:
        """Late binding — service.py wires the dispatcher in after both
        evaluator and dispatcher are constructed."""
        self._notify_sink = sink

    # ── public API ────────────────────────────────────────────────────────

    def evaluate(self, snapshot: MonitorSnapshot) -> None:
        """Classify a snapshot and emit raise/clear events for transitions.

        Safe to call from collector hot path: any internal failure (DB
        outage, schema mismatch) is logged and swallowed — the caller's
        metrics path stays unaffected.
        """
        try:
            self._evaluate_inner(snapshot)
        except Exception:
            self._logger.exception(
                "AlertEvaluator failed targetId=%s type=%s — alert side-effects skipped",
                snapshot.target_id, snapshot.type,
            )

    def forget(self, source_id: str) -> None:
        """Drop all active alerts for ``source_id`` without emitting clears.

        Called when an operator deletes a monitor target — operator-driven
        removal isn't a recovery signal, so the dangling raise events stay
        in the history without paired clears (acceptable; the FE filter
        can show "deleted target" state if needed).
        """
        if not source_id:
            return
        with self._lock:
            keys = [k for k in self._active if k[1] == str(source_id)]
            for k in keys:
                self._active.pop(k, None)

    def clear_all_active(self, source_id: str, *, reason: str = "disabled") -> None:
        """Emit clear events for all active alerts on ``source_id``.

        Used when a target is disabled — we treat that as an explicit
        recovery so charts and history pages don't show ghost alarms.
        """
        if not source_id:
            return
        with self._lock:
            keys = [k for k in self._active if k[1] == str(source_id)]
            for k in keys:
                meta = self._active.pop(k, None)
                if meta is None:
                    continue
                self._record_safe(
                    source_type=k[0],
                    source_id=k[1],
                    metric=k[2],
                    severity="clear",
                    label=meta.get("label"),
                    message=f"cleared ({reason})",
                    payload={"reason": reason},
                )

    def list_active(self) -> list[dict[str, Any]]:
        """Snapshot of currently-raised (un-cleared) alarms.

        Used by ``GET /dashboard/alerts/active`` so the FE can highlight
        widgets without polling the full transition log. Each entry mirrors
        the row that was inserted on raise + a derived ``key`` field for
        the FE to track liveness across polls.
        """
        with self._lock:
            out: list[dict[str, Any]] = []
            for (source_type, source_id, metric), meta in self._active.items():
                out.append({
                    "sourceType": source_type,
                    "sourceId": source_id,
                    "metric": metric,
                    "label": meta.get("label"),
                    "message": meta.get("message"),
                    "payload": meta.get("payload"),
                    "key": f"{source_type}|{source_id}|{metric}",
                })
            return out

    # ── data API evaluation (Phase 2) ─────────────────────────────────────

    def evaluate_data_api(self, endpoint, data: Any) -> None:
        """Classify a data API refresh result and emit transitions.

        Pulls the central widget_configs row(s) for this endpoint's api_id —
        each (api_id, widget_type) gets its own dedupe space because the
        same column may have different operators per visualisation. The
        source_type carries the widget_type so the alert UI can group by
        visualisation if needed.

        Sink contract: ``EndpointCacheManager`` calls this as
        ``sink(endpoint, data)`` — POSITIONAL — to mirror
        ``MonitorCollectorManager`` 's ``sink(snapshot)`` and
        ``service._tm_archive_data_api(endpoint, data)``. Do NOT make these
        keyword-only; the cache hot path swallows TypeError so a regression
        here would silently drop every data-API alert event.

        Failures here are logged and swallowed (same contract as
        ``evaluate``) so a single corrupt config row cannot derail the
        endpoint cache refresh path.
        """
        try:
            self._evaluate_data_api_inner(endpoint=endpoint, data=data)
        except Exception:
            self._logger.exception(
                "AlertEvaluator data API failed apiId=%s — alert side-effects skipped",
                getattr(endpoint, "api_id", None),
            )

    # data API thresholds 의 storage widget_type. FE 는 임계치 모달에서 항상
    # 이 한 곳에만 저장한다. 다른 widget_type 행이 historical 로 남아 있어도
    # 평가에는 사용하지 않는다 (사용자 요구: widget_type 무관 단일 thresholds).
    _DATA_API_PRIMARY_WIDGET_TYPE = "table"

    def _evaluate_data_api_inner(self, *, endpoint, data: Any) -> None:
        api_id = str(getattr(endpoint, "api_id", "") or "").strip()
        if not api_id:
            return
        # If endpoint is disabled, skip — same convention as monitor-side.
        if getattr(endpoint, "enabled", True) is False:
            return

        try:
            configs = self._store.list_widget_configs_by_api_id(api_id)
        except Exception:
            self._logger.exception(
                "list_widget_configs_by_api_id failed apiId=%s", api_id,
            )
            return
        if not configs:
            return

        # 단일 thresholds 출처: ``table`` widget_type 행만 평가에 사용. 비어
        # 있으면 backward-compat 로 어떤 widget_type 행이든 첫 번째 thresholds
        # 가 있는 것을 fallback 사용한다 (Phase 2 step 2a 시기에 line-chart /
        # bar-chart 로 저장된 historical row 가 남아 있을 수 있음).
        primary = next(
            (c for c in configs
             if str(c.get("widgetType") or "") == self._DATA_API_PRIMARY_WIDGET_TYPE),
            None,
        )
        thresholds = None
        if primary is not None:
            cfg = primary.get("config") or {}
            t = cfg.get("thresholds") if isinstance(cfg, dict) else None
            if isinstance(t, list) and t:
                thresholds = t
        if thresholds is None:
            for cfg_row in configs:
                cfg = cfg_row.get("config") or {}
                t = cfg.get("thresholds") if isinstance(cfg, dict) else None
                if isinstance(t, list) and t:
                    thresholds = t
                    break
        if not thresholds:
            # 정의된 임계치가 없는 API — 알람 평가 건너뜀 (clear transition 도
            # 발생시키지 않는다; 운영자가 임계치를 모두 지웠다면 이전에 raise
            # 된 것은 별도 운영 정리로 마감해야 한다.)
            return

        violations = _data_api_violations(rows=data, thresholds=thresholds)
        if violations is _INDETERMINATE:
            return

        label = getattr(endpoint, "title", None) or getattr(endpoint, "rest_api_path", None)
        # source_type 단일화 — widget_type 분리 폐기. 사용자 화면에서는 단순히
        # "데이터 API" 한 그룹으로 보인다.
        source_type = "data_api"
        current_metrics = {v["metric"]: v for v in violations}

        with self._lock:
            existing_keys = {
                k for k in self._active
                if k[0] == source_type and k[1] == api_id
            }
            current_keys = {
                (source_type, api_id, m) for m in current_metrics
            }

            for k in current_keys - existing_keys:
                v = current_metrics[k[2]]
                payload = {
                    "value": v.get("value"),
                    "threshold": v.get("threshold"),
                    "operator": v.get("operator"),
                    "row": v.get("row"),
                }
                self._active[k] = {
                    "label": label,
                    "message": v.get("message"),
                    "payload": payload,
                }
                self._record_safe(
                    source_type=source_type,
                    source_id=api_id,
                    metric=k[2],
                    severity="raise",
                    level=str(v.get("level") or "warn"),
                    label=label,
                    message=v.get("message"),
                    payload=payload,
                )

            for k in existing_keys - current_keys:
                meta = self._active.pop(k, None)
                if meta is None:
                    continue
                self._record_safe(
                    source_type=source_type,
                    source_id=api_id,
                    metric=k[2],
                    severity="clear",
                    label=label,
                    message="recovered",
                    payload={"previous": meta.get("payload")},
                )

    # ── internals ─────────────────────────────────────────────────────────

    def _evaluate_inner(self, snapshot: MonitorSnapshot) -> None:
        target_type = (snapshot.type or "").strip().lower()
        if target_type not in ("server_resource", "network", "http_status"):
            return

        # Disabled targets shouldn't generate alerts. The collector also
        # short-circuits before we get here, but defence in depth.
        if not snapshot.enabled:
            return

        spec = snapshot.spec_echo or {}
        criteria = spec.get("criteria") if isinstance(spec, dict) else None

        if target_type == "server_resource":
            violations = _server_resource_violations(data=snapshot.data, criteria=criteria)
        elif target_type == "network":
            violations = _network_violations(data=snapshot.data)
        else:  # http_status
            violations = _http_status_violations(data=snapshot.data)

        if violations is _INDETERMINATE:
            # Probe is still bootstrapping or returned an unparseable shape.
            # Don't fire raise events (we don't know yet) and don't fire
            # clear events (we don't want to clear a real alarm just
            # because one tick was malformed).
            return

        current_metrics = {v["metric"]: v for v in violations}
        host = (
            spec.get("host") or spec.get("url")
            if isinstance(spec, dict) else None
        )

        with self._lock:
            existing_keys = {
                k for k in self._active if k[0] == target_type and k[1] == snapshot.target_id
            }
            current_keys = {
                (target_type, snapshot.target_id, m) for m in current_metrics
            }

            # ── raises (newly violating) ─────────────────────────────
            for k in current_keys - existing_keys:
                v = current_metrics[k[2]]
                payload = {
                    "value": v.get("value"),
                    "threshold": v.get("threshold"),
                    "host": host,
                }
                self._active[k] = {
                    "label": snapshot.label,
                    "message": v.get("message"),
                    "payload": payload,
                }
                self._record_safe(
                    source_type=target_type,
                    source_id=snapshot.target_id,
                    metric=k[2],
                    severity="raise",
                    label=snapshot.label,
                    level=_severity_level(v),
                    message=v.get("message"),
                    payload=payload,
                )

            # ── clears (no longer violating) ─────────────────────────
            for k in existing_keys - current_keys:
                meta = self._active.pop(k, None)
                if meta is None:
                    continue
                self._record_safe(
                    source_type=target_type,
                    source_id=snapshot.target_id,
                    metric=k[2],
                    severity="clear",
                    label=snapshot.label,
                    message="recovered",
                    payload={"host": host, "previous": meta.get("payload")},
                )

    def _record_safe(
        self,
        *,
        source_type: str,
        source_id: str,
        metric: str | None,
        severity: str,
        level: str | None = None,
        label: str | None = None,
        message: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        try:
            self._store.record_alert_event(
                source_type=source_type,
                source_id=source_id,
                metric=metric,
                severity=severity,
                level=level,
                label=label,
                message=message,
                payload=payload,
            )
        except Exception:
            self._logger.exception(
                "record_alert_event failed sourceType=%s sourceId=%s severity=%s",
                source_type, source_id, severity,
            )
            return
        # Fire-and-forget notification dispatch. Hard-isolated: any failure
        # here MUST NOT propagate back into the collector loop.
        sink = self._notify_sink
        if sink is None:
            return
        try:
            sink({
                "source_type": source_type,
                "source_id": source_id,
                "metric": metric,
                "severity": severity,
                "level": level,
                "label": label,
                "message": message,
                "payload": payload or {},
                "created_at": datetime.now(timezone.utc),
            })
        except Exception:
            self._logger.exception(
                "notify_sink raised — suppressed; collector path unaffected",
            )

    def snapshot_active(self) -> list[dict[str, Any]]:
        """Return a stable snapshot of currently raised alarms.

        Used by the notification dispatcher to enrich the email body with
        'other alarms firing right now'. Cheap copy under the lock so callers
        can iterate without races.
        """
        with self._lock:
            return [
                {
                    "sourceType": k[0],
                    "sourceId": k[1],
                    "metric": k[2] or None,
                    "label": v.get("label"),
                    "level": v.get("level"),
                    "message": v.get("message"),
                }
                for k, v in self._active.items()
            ]


def _severity_level(violation: dict[str, Any]) -> str:
    """Classify violation magnitude into warn/critical.

    Phase 1 keeps this simple — value/threshold ratio for percentile
    metrics, "critical" otherwise. The FE only renders the level as a
    badge today; promoting this into per-target ops policy is a Phase 2
    concern alongside data-API thresholds.
    """
    value = violation.get("value")
    threshold = violation.get("threshold")
    if isinstance(value, (int, float)) and isinstance(threshold, (int, float)) and threshold > 0:
        ratio = float(value) / float(threshold)
        if ratio >= 1.15:
            return "critical"
        return "warn"
    return "critical"

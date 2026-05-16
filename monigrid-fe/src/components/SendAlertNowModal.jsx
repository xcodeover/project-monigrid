import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { alertService } from "../services/dashboardService";
import {
    notificationChannelService,
    notificationGroupService,
    notificationRecipientService,
    notificationSendNowService,
} from "../services/notificationService";
import { IconClose } from "./icons";
import "./SendAlertNowModal.css";

/**
 * "Send currently-firing alarms to operator now" modal.
 *
 * Listed activeAlerts come from the same /dashboard/alerts/active that the
 * AlarmBanner polls. The user picks (a) a channel, (b) a recipient group,
 * (c) which alarms to include — then we enqueue (alarm × recipient) pairs
 * via notificationSendNowService. Bypasses rules/cooldown/silence by
 * design (this is the operator-driven escape hatch).
 *
 * Chrome (overlay / popup / header / footer) is aligned with the project's
 * canonical widget-settings modal family (`.settings-overlay`,
 * `.settings-popup`, `.close-settings-btn`, `.primary-btn`, `.secondary-btn`).
 * createPortal + Esc + scroll-lock + autofocus follow WidgetSettingsModal.
 */
export default function SendAlertNowModal({ open, onClose }) {
    const [alerts, setAlerts] = useState([]);
    const [selected, setSelected] = useState(() => new Set());
    const [channels, setChannels] = useState([]);
    const [groups, setGroups] = useState([]);
    const [channelId, setChannelId] = useState(null);
    const [groupId, setGroupId] = useState(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const popupRef = useRef(null);

    // Esc-to-close + background scroll lock — matches WidgetSettingsModal.
    useEffect(() => {
        if (!open) return undefined;
        const handleKeyDown = (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                onClose?.();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = previousOverflow;
        };
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setResult(null);
        Promise.all([
            alertService.listActive().catch(() => ({ items: [] })),
            notificationChannelService.list().catch(() => []),
            notificationGroupService.list().catch(() => []),
        ]).then(([activeRes, ch, gs]) => {
            if (cancelled) return;
            const items = activeRes?.items || [];
            setAlerts(items);
            setSelected(new Set(items.map((_, i) => i)));
            setChannels(ch);
            setGroups(gs);
            const enabledCh = ch.find((c) => c.enabled);
            setChannelId(enabledCh ? enabledCh.id : null);
            setGroupId(gs[0]?.id || null);
        });
        return () => { cancelled = true; };
    }, [open]);

    // Autofocus: defer focus until the portal renders.
    useEffect(() => {
        if (!open) return;
        const node = popupRef.current;
        if (!node) return;
        const focusable = node.querySelector(
            "select:not([disabled]), input:not([disabled]), button:not([disabled])",
        );
        (focusable ?? node).focus({ preventScroll: true });
    }, [open]);

    const toggle = (idx) => {
        const next = new Set(selected);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        setSelected(next);
    };

    const toggleAll = (checked) => {
        if (checked) setSelected(new Set(alerts.map((_, i) => i)));
        else setSelected(new Set());
    };

    const send = async () => {
        if (!channelId) { setResult({ ok: false, detail: "채널을 선택하세요." }); return; }
        if (!groupId) { setResult({ ok: false, detail: "수신자 그룹을 선택하세요." }); return; }
        if (selected.size === 0) { setResult({ ok: false, detail: "최소 1건의 알람을 선택하세요." }); return; }
        setBusy(true);
        setResult(null);
        try {
            const recipients = await notificationRecipientService.listForGroup(groupId);
            const addresses = recipients.filter((r) => r.enabled).map((r) => r.address);
            if (addresses.length === 0) {
                throw new Error("선택한 그룹에 활성 수신자가 없습니다.");
            }
            const picked = [...selected].map((i) => alerts[i]).filter(Boolean);
            let totalQueued = 0;
            for (const a of picked) {
                const event = {
                    source_type: a.sourceType,
                    source_id: a.sourceId,
                    metric: a.metric,
                    severity: "raise",
                    level: a.level || "warn",
                    label: a.label,
                    message: a.message,
                    payload: a.payload || {},
                    created_at: new Date().toISOString(),
                };
                const r = await notificationSendNowService.send({
                    event, channelId, recipients: addresses,
                });
                totalQueued += r.count || 0;
            }
            setResult({
                ok: true,
                detail: `${totalQueued}건 큐 적재 완료. 발송은 워커가 즉시 진행합니다.`,
            });
        } catch (err) {
            setResult({
                ok: false,
                detail: err?.response?.data?.detail
                    || err?.response?.data?.message
                    || err?.message
                    || "전송 실패",
            });
        } finally {
            setBusy(false);
        }
    };

    if (!open) return null;

    const titleId = "send-alert-now-title";
    const allSelected = alerts.length > 0 && selected.size === alerts.length;
    const someSelected = selected.size > 0 && !allSelected;

    const modal = (
        <div className="settings-overlay">
            <div
                ref={popupRef}
                className="settings-popup san-popup"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="settings-popup-header">
                    <div>
                        <h5 id={titleId}>활성 알람 즉시 메일 전송</h5>
                        <p>규칙 / 쿨다운 / 억제 규칙을 무시하고 선택한 수신자에게 즉시 발송합니다.</p>
                    </div>
                    <button
                        type="button"
                        className="close-settings-btn"
                        onClick={onClose}
                        aria-label="닫기"
                    >
                        <IconClose size={14} />
                    </button>
                </div>

                <div className="settings-popup-body san-body">
                    <section className="san-section">
                        <h6>발송 대상</h6>
                        <div className="san-form">
                            <label className="san-field">
                                <span>채널</span>
                                <select
                                    value={channelId || ""}
                                    onChange={(e) => setChannelId(parseInt(e.target.value, 10) || null)}
                                >
                                    <option value="">(선택)</option>
                                    {channels.map((c) => (
                                        <option key={c.id} value={c.id} disabled={!c.enabled}>
                                            #{c.id} · {c.kind}{c.enabled ? "" : " (꺼짐)"}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="san-field">
                                <span>수신자 그룹</span>
                                <select
                                    value={groupId || ""}
                                    onChange={(e) => setGroupId(parseInt(e.target.value, 10) || null)}
                                >
                                    <option value="">(선택)</option>
                                    {groups.map((g) => (
                                        <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                </select>
                            </label>
                        </div>
                    </section>

                    <section className="san-section">
                        <div className="san-section-head">
                            <h6>발송할 알람</h6>
                            <span className="san-section-meta">
                                {selected.size} / {alerts.length}건 선택
                            </span>
                        </div>

                        {alerts.length === 0 ? (
                            <div className="san-empty">활성 알람이 없습니다.</div>
                        ) : (
                            <>
                                <label className="san-check-all">
                                    <input
                                        type="checkbox"
                                        checked={allSelected}
                                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                                        onChange={(e) => toggleAll(e.target.checked)}
                                    />
                                    <span>전체 선택</span>
                                </label>
                                <ul className="san-alarms">
                                    {alerts.map((a, i) => {
                                        const isChecked = selected.has(i);
                                        return (
                                            <li
                                                key={i}
                                                className={`san-alarm ${isChecked ? "is-selected" : ""}`}
                                            >
                                                <label className="san-alarm-label">
                                                    <input
                                                        type="checkbox"
                                                        checked={isChecked}
                                                        onChange={() => toggle(i)}
                                                    />
                                                    <div className="san-alarm-body">
                                                        <div className="san-alarm-title">
                                                            <span className={`san-severity san-severity-${(a.level || "warn").toLowerCase()}`}>
                                                                {(a.level || "warn").toUpperCase()}
                                                            </span>
                                                            <span className="san-alarm-name">
                                                                {a.label || a.sourceId}
                                                            </span>
                                                        </div>
                                                        <div className="san-alarm-meta">
                                                            <span>{a.sourceType || "-"}</span>
                                                            <span className="san-sep">·</span>
                                                            <span>{a.metric || "-"}</span>
                                                            <span className="san-sep">·</span>
                                                            <span className="san-alarm-source">{a.sourceId}</span>
                                                        </div>
                                                        {a.message && (
                                                            <div className="san-alarm-message">{a.message}</div>
                                                        )}
                                                    </div>
                                                </label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                    </section>
                </div>

                <div className="san-footer">
                    {result && (
                        <div className={`san-result ${result.ok ? "san-result-ok" : "san-result-err"}`}>
                            {result.ok ? "✔ " : "✘ "}{result.detail}
                        </div>
                    )}
                    <button
                        type="button"
                        className="secondary-btn san-footer-btn"
                        onClick={onClose}
                    >
                        닫기
                    </button>
                    <button
                        type="button"
                        className="primary-btn san-footer-btn"
                        onClick={send}
                        disabled={busy || alerts.length === 0}
                    >
                        {busy ? "전송 중…" : "지금 발송"}
                    </button>
                </div>
            </div>
        </div>
    );

    return createPortal(modal, document.body);
}

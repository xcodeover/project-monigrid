import React, { useEffect, useMemo, useState } from "react";
import { alertService } from "../services/dashboardService";
import {
    notificationChannelService,
    notificationGroupService,
    notificationRecipientService,
    notificationSendNowService,
} from "../services/notificationService";

/**
 * "Send currently-firing alarms to operator now" modal.
 *
 * Listed activeAlerts come from the same /dashboard/alerts/active that the
 * AlarmBanner polls. The user picks (a) a channel, (b) a recipient group,
 * (c) which alarms to include — then we enqueue (alarm × recipient) pairs
 * via notificationSendNowService. Bypasses rules/cooldown/silence by
 * design (this is the operator-driven escape hatch).
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

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
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

    const toggle = (idx) => {
        const next = new Set(selected);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        setSelected(next);
    };

    const send = async () => {
        if (!channelId) { alert("채널을 선택하세요."); return; }
        if (!groupId) { alert("수신자 그룹을 선택하세요."); return; }
        if (selected.size === 0) { alert("최소 1건의 알람을 선택하세요."); return; }
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
            setResult({ ok: true, detail: `${totalQueued}건 큐 적재 완료. 발송은 워커가 즉시 진행합니다.` });
        } catch (err) {
            setResult({ ok: false, detail: err?.response?.data?.message || err.message });
        } finally {
            setBusy(false);
        }
    };

    if (!open) return null;

    return (
        <div className="san-overlay" onClick={onClose}>
            <div className="san-modal" onClick={(e) => e.stopPropagation()}>
                <header>
                    <h3>활성 알람 즉시 메일 전송</h3>
                    <button type="button" onClick={onClose}>✕</button>
                </header>
                <div className="san-body">
                    <div className="san-form">
                        <label>채널
                            <select value={channelId || ""} onChange={(e) => setChannelId(parseInt(e.target.value, 10))}>
                                <option value="">(선택)</option>
                                {channels.map((c) => (
                                    <option key={c.id} value={c.id} disabled={!c.enabled}>
                                        {c.kind} {c.enabled ? "" : "(꺼짐)"}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>수신자 그룹
                            <select value={groupId || ""} onChange={(e) => setGroupId(parseInt(e.target.value, 10))}>
                                <option value="">(선택)</option>
                                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                        </label>
                    </div>
                    <h4>발송할 알람 ({selected.size}/{alerts.length}건)</h4>
                    <ul className="san-alarms">
                        {alerts.map((a, i) => (
                            <li key={i}>
                                <label>
                                    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                                    <span className="san-label">{a.label || a.sourceId}</span>
                                    <span className="san-meta">{a.sourceType} / {a.metric || "-"}</span>
                                    <span className="san-message">{a.message || ""}</span>
                                </label>
                            </li>
                        ))}
                        {alerts.length === 0 && <li className="san-muted">활성 알람이 없습니다.</li>}
                    </ul>
                </div>
                <footer>
                    {result && (
                        <div className={result.ok ? "san-ok" : "san-err"}>
                            {result.ok ? "✔ " : "✘ "}{result.detail}
                        </div>
                    )}
                    <button type="button" onClick={onClose}>닫기</button>
                    <button type="button" onClick={send} disabled={busy} className="san-primary">
                        {busy ? "전송 중…" : "지금 발송"}
                    </button>
                </footer>
            </div>
            <style>{`
                .san-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 9999;
                               display: flex; align-items: center; justify-content: center; }
                .san-modal { background: white; border-radius: 8px; min-width: 520px; max-width: 720px;
                             width: 80vw; max-height: 80vh; display: flex; flex-direction: column;
                             box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
                .san-modal header { padding: 12px 16px; border-bottom: 1px solid #e5e7eb;
                                    display: flex; justify-content: space-between; align-items: center; }
                .san-modal header h3 { margin: 0; font-size: 14px; }
                .san-modal header button { background: none; border: none; cursor: pointer; font-size: 16px; }
                .san-body { padding: 14px 16px; overflow: auto; flex: 1; }
                .san-form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-bottom: 14px; }
                .san-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #374151; }
                .san-form select { padding: 6px 8px; border: 1px solid #d1d5db; border-radius: 4px; }
                .san-modal h4 { font-size: 12px; color: #6b7280; margin: 12px 0 6px; }
                .san-alarms { list-style: none; padding: 0; margin: 0; }
                .san-alarms li { padding: 6px 0; border-bottom: 1px solid #f3f4f6; }
                .san-alarms label { display: grid; grid-template-columns: 20px 1fr 200px; gap: 8px;
                                    cursor: pointer; align-items: baseline; }
                .san-label { font-weight: 500; }
                .san-meta { color: #6b7280; font-size: 11px; }
                .san-message { grid-column: 2 / -1; color: #6b7280; font-size: 11px; margin-top: 2px; }
                .san-muted { color: #9ca3af; font-size: 12px; padding: 8px; }
                .san-modal footer { padding: 10px 16px; border-top: 1px solid #e5e7eb;
                                    display: flex; gap: 8px; align-items: center; }
                .san-modal footer button { padding: 6px 14px; border-radius: 4px; cursor: pointer;
                                          border: 1px solid #d1d5db; background: white; font-size: 13px; }
                .san-modal footer .san-primary { background: #2563eb; color: white; border-color: #2563eb; margin-left: auto; }
                .san-ok { color: #166534; font-size: 12px; flex: 1; }
                .san-err { color: #991b1b; font-size: 12px; flex: 1; }
            `}</style>
        </div>
    );
}

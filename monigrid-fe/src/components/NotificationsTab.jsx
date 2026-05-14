import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    notificationGlobalService,
    notificationChannelService,
    notificationGroupService,
    notificationRecipientService,
    notificationRuleService,
    notificationSilenceService,
    notificationQueueService,
    notificationStatsService,
} from "../services/notificationService";
import "./NotificationsTab.css";

/* ── small helpers ─────────────────────────────────────────────── */

const SUB_TABS = [
    { key: "master", label: "마스터" },
    { key: "channels", label: "채널 (SMTP)" },
    { key: "groups", label: "수신자 그룹" },
    { key: "rules", label: "알림 규칙" },
    { key: "silences", label: "억제 규칙" },
    { key: "queue", label: "발송 이력" },
];

const SOURCE_TYPE_OPTIONS = [
    { value: "", label: "(any)" },
    { value: "server_resource", label: "서버 리소스" },
    { value: "network", label: "네트워크" },
    { value: "http_status", label: "HTTP 상태" },
    { value: "data_api:table", label: "데이터 API (표)" },
    { value: "data_api:line-chart", label: "데이터 API (라인)" },
    { value: "data_api:bar-chart", label: "데이터 API (바)" },
];

const QUEUE_STATUS_LABELS = {
    pending: "대기",
    sending: "발송 중",
    sent: "성공",
    failed: "실패 (재시도 예정)",
    dead: "사망 (재시도 종료)",
    cancelled: "취소됨",
};

function formatIso(s) {
    if (!s) return "";
    try {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return s;
        return d.toLocaleString();
    } catch {
        return s;
    }
}

/* ══════════════════════════════════════════════════════════════════
   Master sub-tab
   ══════════════════════════════════════════════════════════════════ */

function MasterPanel() {
    const [global, setGlobal] = useState({ enabled: false });
    const [stats, setStats] = useState(null);
    const [busy, setBusy] = useState(false);

    const reload = useCallback(async () => {
        try {
            const [g, s] = await Promise.all([
                notificationGlobalService.get(),
                notificationStatsService.get(),
            ]);
            setGlobal(g);
            setStats(s);
        } catch (err) {
            console.error("notification stats reload failed", err);
        }
    }, []);

    useEffect(() => {
        reload();
        const t = setInterval(reload, 10_000);
        return () => clearInterval(t);
    }, [reload]);

    const toggle = async () => {
        setBusy(true);
        try {
            const next = await notificationGlobalService.set(!global.enabled);
            setGlobal(next);
        } catch (err) {
            alert(`글로벌 토글 변경 실패: ${err?.response?.data?.message || err.message}`);
        } finally {
            setBusy(false);
        }
    };

    const dispatcher = stats?.dispatcher || {};
    const queueCounts = stats?.queueCounts || {};
    const dead24h = stats?.deadIn24h || 0;
    const deadAlert = dead24h >= 100;

    return (
        <div className="notif-pane">
            <section className="notif-card">
                <div className="notif-master-row">
                    <div>
                        <h3>전역 메일링 스위치</h3>
                        <p className="notif-muted">
                            OFF 일 때는 어떤 알림도 발송되지 않습니다 (로깅·DB 기록은 그대로).
                        </p>
                    </div>
                    <button
                        type="button"
                        className={`notif-toggle ${global.enabled ? "on" : "off"}`}
                        onClick={toggle}
                        disabled={busy}
                    >
                        {global.enabled ? "ON" : "OFF"}
                    </button>
                </div>
            </section>

            {deadAlert && (
                <section className="notif-banner notif-banner-warn">
                    경고: 최근 24시간 내 발송 사망(dead) {dead24h}건 — 채널 설정/네트워크 점검 필요.
                </section>
            )}

            <section className="notif-card">
                <h3>큐 상태</h3>
                <div className="notif-stat-grid">
                    {Object.entries(QUEUE_STATUS_LABELS).map(([k, label]) => (
                        <div key={k} className="notif-stat">
                            <div className="notif-stat-label">{label}</div>
                            <div className="notif-stat-value">{queueCounts[k] ?? 0}</div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="notif-card">
                <h3>디스패처 통계</h3>
                <div className="notif-stat-grid">
                    {[
                        ["received", "수신"],
                        ["enqueued", "큐 적재"],
                        ["matchedRules", "룰 매치"],
                        ["suppressedCooldown", "쿨다운 억제"],
                        ["suppressedSilence", "Silence 억제"],
                        ["suppressedGlobalOff", "글로벌 OFF 억제"],
                        ["suppressedMinLevel", "Level 미달 억제"],
                        ["suppressedSendOnClear", "Clear 미발송"],
                        ["droppedOverflow", "오버플로 폐기"],
                        ["enqueueErrors", "Enqueue 에러"],
                        ["inflight", "In-flight"],
                    ].map(([k, label]) => (
                        <div key={k} className="notif-stat">
                            <div className="notif-stat-label">{label}</div>
                            <div className="notif-stat-value">{dispatcher[k] ?? 0}</div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   SMTP channel sub-tab
   ══════════════════════════════════════════════════════════════════ */

const EMPTY_SMTP_CONFIG = {
    host: "", port: 587, use_tls: true, use_ssl: false,
    username: "", password: "", from_address: "", from_name: "", reply_to: "",
};

function ChannelPanel() {
    const [enabled, setEnabled] = useState(true);
    const [cfg, setCfg] = useState(EMPTY_SMTP_CONFIG);
    const [updatedAt, setUpdatedAt] = useState(null);
    const [updatedBy, setUpdatedBy] = useState(null);
    const [loaded, setLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testRecipient, setTestRecipient] = useState("");
    const [testResult, setTestResult] = useState(null);

    useEffect(() => {
        notificationChannelService.getConfig("smtp")
            .then((res) => {
                setEnabled(res?.enabled ?? true);
                setCfg({ ...EMPTY_SMTP_CONFIG, ...(res?.config || {}) });
                setUpdatedAt(res?.updatedAt);
                setUpdatedBy(res?.updatedBy);
                setLoaded(true);
            })
            .catch((err) => {
                if (err?.response?.status === 404) {
                    setLoaded(true);
                } else {
                    console.error("smtp config load failed", err);
                }
            });
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            await notificationChannelService.save("smtp", { enabled, config: cfg });
            // empty password = keep existing — clear local field after save for clarity
            setCfg((prev) => ({ ...prev, password: "" }));
            setTestResult({ ok: true, detail: "저장 완료" });
        } catch (err) {
            const msg = err?.response?.data?.message || err.message;
            setTestResult({ ok: false, detail: `저장 실패: ${msg}` });
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        if (!testRecipient.trim()) {
            setTestResult({ ok: false, detail: "테스트 수신 주소가 비었습니다." });
            return;
        }
        setTesting(true);
        try {
            const result = await notificationChannelService.sendTest("smtp", testRecipient.trim());
            setTestResult(result);
        } catch (err) {
            const msg = err?.response?.data?.message || err.message;
            setTestResult({ ok: false, detail: msg });
        } finally {
            setTesting(false);
        }
    };

    if (!loaded) return <div className="notif-pane">로드 중…</div>;

    return (
        <div className="notif-pane">
            <section className="notif-card">
                <h3>SMTP 채널 설정</h3>
                <p className="notif-muted">
                    저장 후 다음 발송부터 적용됩니다 (워커 폴링 주기 약 30s).
                    비밀번호 칸을 비워두면 기존 저장값이 유지됩니다.
                </p>
                <div className="notif-form-grid">
                    <label>활성화
                        <input type="checkbox" checked={enabled}
                            onChange={(e) => setEnabled(e.target.checked)} />
                    </label>
                    <label>호스트
                        <input value={cfg.host}
                            onChange={(e) => setCfg({ ...cfg, host: e.target.value })}
                            placeholder="smtp.example.com" />
                    </label>
                    <label>포트
                        <input type="number" value={cfg.port}
                            onChange={(e) => setCfg({ ...cfg, port: parseInt(e.target.value, 10) || 587 })} />
                    </label>
                    <label>STARTTLS
                        <input type="checkbox" checked={cfg.use_tls}
                            onChange={(e) => setCfg({ ...cfg, use_tls: e.target.checked, use_ssl: e.target.checked ? false : cfg.use_ssl })} />
                    </label>
                    <label>SMTPS (SSL)
                        <input type="checkbox" checked={cfg.use_ssl}
                            onChange={(e) => setCfg({ ...cfg, use_ssl: e.target.checked, use_tls: e.target.checked ? false : cfg.use_tls })} />
                    </label>
                    <label>사용자명
                        <input value={cfg.username || ""}
                            onChange={(e) => setCfg({ ...cfg, username: e.target.value })} />
                    </label>
                    <label>비밀번호 <span className="notif-muted">(비우면 기존값 유지)</span>
                        <input type="password" value={cfg.password || ""}
                            onChange={(e) => setCfg({ ...cfg, password: e.target.value })} />
                    </label>
                    <label>발신 주소
                        <input value={cfg.from_address}
                            onChange={(e) => setCfg({ ...cfg, from_address: e.target.value })}
                            placeholder="alerts@example.com" />
                    </label>
                    <label>발신 이름
                        <input value={cfg.from_name || ""}
                            onChange={(e) => setCfg({ ...cfg, from_name: e.target.value })}
                            placeholder="MoniGrid Alerts" />
                    </label>
                    <label>Reply-To
                        <input value={cfg.reply_to || ""}
                            onChange={(e) => setCfg({ ...cfg, reply_to: e.target.value })} />
                    </label>
                </div>
                <div className="notif-actions">
                    <button type="button" onClick={handleSave} disabled={saving}>
                        {saving ? "저장 중…" : "저장"}
                    </button>
                </div>
                {(updatedAt || updatedBy) && (
                    <div className="notif-muted" style={{ marginTop: 8 }}>
                        마지막 수정: {formatIso(updatedAt)} {updatedBy ? `(${updatedBy})` : ""}
                    </div>
                )}
            </section>

            <section className="notif-card">
                <h3>테스트 발송</h3>
                <div className="notif-actions">
                    <input value={testRecipient}
                        onChange={(e) => setTestRecipient(e.target.value)}
                        placeholder="ops@example.com" />
                    <button type="button" onClick={handleTest} disabled={testing}>
                        {testing ? "발송 중…" : "테스트 메일 보내기"}
                    </button>
                </div>
                {testResult && (
                    <div className={`notif-banner ${testResult.ok ? "notif-banner-ok" : "notif-banner-err"}`}>
                        {testResult.ok ? "✔ " : "✘ "}{testResult.detail}
                    </div>
                )}
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Groups + recipients sub-tab
   ══════════════════════════════════════════════════════════════════ */

function GroupsPanel() {
    const [groups, setGroups] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [recipients, setRecipients] = useState([]);
    const [newGroupName, setNewGroupName] = useState("");
    const [newRecipientAddr, setNewRecipientAddr] = useState("");
    const [newRecipientName, setNewRecipientName] = useState("");
    const [busy, setBusy] = useState(false);

    const reloadGroups = useCallback(async () => {
        const list = await notificationGroupService.list();
        setGroups(list);
        if (list.length && selectedId == null) {
            setSelectedId(list[0].id);
        }
    }, [selectedId]);

    const reloadRecipients = useCallback(async (groupId) => {
        if (!groupId) { setRecipients([]); return; }
        const list = await notificationRecipientService.listForGroup(groupId);
        setRecipients(list);
    }, []);

    useEffect(() => { reloadGroups(); }, [reloadGroups]);
    useEffect(() => { reloadRecipients(selectedId); }, [selectedId, reloadRecipients]);

    const addGroup = async () => {
        const name = newGroupName.trim();
        if (!name) return;
        setBusy(true);
        try {
            const r = await notificationGroupService.create({ name });
            setNewGroupName("");
            await reloadGroups();
            setSelectedId(r.id);
        } finally {
            setBusy(false);
        }
    };

    const removeGroup = async (id) => {
        if (!confirm("그룹과 소속 수신자를 모두 삭제합니다. 진행할까요?")) return;
        try {
            await notificationGroupService.remove(id);
            if (selectedId === id) setSelectedId(null);
            await reloadGroups();
        } catch (err) {
            alert(err?.response?.data?.message || err.message);
        }
    };

    const addRecipient = async () => {
        if (!selectedId || !newRecipientAddr.trim()) return;
        setBusy(true);
        try {
            await notificationRecipientService.create(selectedId, {
                address: newRecipientAddr.trim(),
                displayName: newRecipientName.trim() || null,
            });
            setNewRecipientAddr("");
            setNewRecipientName("");
            await reloadRecipients(selectedId);
        } finally {
            setBusy(false);
        }
    };

    const toggleGroupEnabled = async (g) => {
        await notificationGroupService.update(g.id, { enabled: !g.enabled });
        await reloadGroups();
    };
    const toggleRecipientEnabled = async (r) => {
        await notificationRecipientService.update(r.id, { enabled: !r.enabled });
        await reloadRecipients(selectedId);
    };
    const removeRecipient = async (id) => {
        await notificationRecipientService.remove(id);
        await reloadRecipients(selectedId);
    };

    return (
        <div className="notif-pane notif-split">
            <section className="notif-card notif-split-left">
                <h3>그룹</h3>
                <ul className="notif-list">
                    {groups.map((g) => (
                        <li key={g.id}
                            className={`notif-list-row ${selectedId === g.id ? "active" : ""} ${!g.enabled ? "disabled" : ""}`}
                            onClick={() => setSelectedId(g.id)}>
                            <span className="notif-list-name">{g.name}</span>
                            <button type="button" className="notif-mini" onClick={(e) => { e.stopPropagation(); toggleGroupEnabled(g); }}>
                                {g.enabled ? "켜짐" : "꺼짐"}
                            </button>
                            <button type="button" className="notif-mini notif-danger" onClick={(e) => { e.stopPropagation(); removeGroup(g.id); }}>삭제</button>
                        </li>
                    ))}
                </ul>
                <div className="notif-actions">
                    <input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)}
                        placeholder="새 그룹 이름" />
                    <button type="button" onClick={addGroup} disabled={busy}>+ 추가</button>
                </div>
            </section>
            <section className="notif-card notif-split-right">
                <h3>수신자 {selectedId ? "" : "(좌측에서 그룹 선택)"}</h3>
                {selectedId && (
                    <>
                        <ul className="notif-list">
                            {recipients.map((r) => (
                                <li key={r.id}
                                    className={`notif-list-row ${!r.enabled ? "disabled" : ""}`}>
                                    <span className="notif-list-name">{r.displayName || r.address}</span>
                                    <span className="notif-list-sub">{r.address}</span>
                                    <button type="button" className="notif-mini" onClick={() => toggleRecipientEnabled(r)}>
                                        {r.enabled ? "켜짐" : "꺼짐"}
                                    </button>
                                    <button type="button" className="notif-mini notif-danger" onClick={() => removeRecipient(r.id)}>삭제</button>
                                </li>
                            ))}
                            {recipients.length === 0 && <li className="notif-muted">수신자가 없습니다.</li>}
                        </ul>
                        <div className="notif-actions">
                            <input value={newRecipientAddr} onChange={(e) => setNewRecipientAddr(e.target.value)}
                                placeholder="이메일 주소" />
                            <input value={newRecipientName} onChange={(e) => setNewRecipientName(e.target.value)}
                                placeholder="표시 이름 (선택)" />
                            <button type="button" onClick={addRecipient} disabled={busy}>+ 추가</button>
                        </div>
                    </>
                )}
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Rules sub-tab
   ══════════════════════════════════════════════════════════════════ */

function RulesPanel() {
    const [rules, setRules] = useState([]);
    const [groups, setGroups] = useState([]);
    const [channels, setChannels] = useState([]);
    const [draft, setDraft] = useState(null);

    const reload = useCallback(async () => {
        const [rs, gs, cs] = await Promise.all([
            notificationRuleService.list(),
            notificationGroupService.list(),
            notificationChannelService.list(),
        ]);
        setRules(rs); setGroups(gs); setChannels(cs);
    }, []);

    useEffect(() => { reload(); }, [reload]);

    const startNew = () => {
        setDraft({
            id: null, name: "", enabled: true,
            sourceType: "", sourceIdPattern: "", metricPattern: "",
            minLevel: "warn",
            recipientGroupId: groups[0]?.id || null,
            channelId: channels[0]?.id || null,
            cooldownSec: 300, digestWindowSec: 0, sendOnClear: false,
        });
    };
    const startEdit = (r) => setDraft({ ...r });
    const cancel = () => setDraft(null);

    const save = async () => {
        if (!draft.name?.trim()) { alert("이름이 필요합니다."); return; }
        if (!draft.recipientGroupId) { alert("수신자 그룹을 선택하세요."); return; }
        if (!draft.channelId) { alert("채널을 선택하세요."); return; }
        try {
            if (draft.id) {
                await notificationRuleService.update(draft.id, draft);
            } else {
                await notificationRuleService.create(draft);
            }
            setDraft(null);
            await reload();
        } catch (err) {
            alert(err?.response?.data?.message || err.message);
        }
    };

    const remove = async (id) => {
        if (!confirm("규칙을 삭제할까요?")) return;
        await notificationRuleService.remove(id);
        await reload();
    };

    const toggleEnabled = async (r) => {
        await notificationRuleService.update(r.id, { enabled: !r.enabled });
        await reload();
    };

    const groupName = (id) => groups.find((g) => g.id === id)?.name || `(group ${id})`;
    const channelKind = (id) => channels.find((c) => c.id === id)?.kind || `(channel ${id})`;

    return (
        <div className="notif-pane">
            <section className="notif-card">
                <div className="notif-card-head">
                    <h3>알림 규칙</h3>
                    <button type="button" onClick={startNew} disabled={!!draft}>+ 새 규칙</button>
                </div>
                <table className="notif-table">
                    <thead>
                        <tr>
                            <th>이름</th><th>활성</th><th>소스타입</th><th>대상 패턴</th>
                            <th>지표 패턴</th><th>최소 레벨</th><th>그룹</th><th>채널</th>
                            <th>쿨다운(s)</th><th>Clear 발송</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {rules.map((r) => (
                            <tr key={r.id} className={!r.enabled ? "notif-row-disabled" : ""}>
                                <td>{r.name}</td>
                                <td>
                                    <button type="button" className="notif-mini" onClick={() => toggleEnabled(r)}>
                                        {r.enabled ? "켜짐" : "꺼짐"}
                                    </button>
                                </td>
                                <td>{r.sourceType || "(any)"}</td>
                                <td>{r.sourceIdPattern || "*"}</td>
                                <td>{r.metricPattern || "*"}</td>
                                <td>{r.minLevel}</td>
                                <td>{groupName(r.recipientGroupId)}</td>
                                <td>{channelKind(r.channelId)}</td>
                                <td>{r.cooldownSec}</td>
                                <td>{r.sendOnClear ? "예" : "아니오"}</td>
                                <td>
                                    <button type="button" className="notif-mini" onClick={() => startEdit(r)}>편집</button>
                                    <button type="button" className="notif-mini notif-danger" onClick={() => remove(r.id)}>삭제</button>
                                </td>
                            </tr>
                        ))}
                        {rules.length === 0 && (
                            <tr><td colSpan={11} className="notif-muted">정의된 규칙이 없습니다.</td></tr>
                        )}
                    </tbody>
                </table>
            </section>

            {draft && (
                <section className="notif-card">
                    <h3>{draft.id ? "규칙 편집" : "새 규칙"}</h3>
                    <div className="notif-form-grid">
                        <label>이름<input value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
                        <label>활성화<input type="checkbox" checked={draft.enabled}
                            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /></label>
                        <label>소스 타입
                            <select value={draft.sourceType || ""}
                                onChange={(e) => setDraft({ ...draft, sourceType: e.target.value || null })}>
                                {SOURCE_TYPE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </label>
                        <label>대상 패턴 <span className="notif-muted">(정규식, 빈 값 = 전체)</span>
                            <input value={draft.sourceIdPattern || ""}
                                onChange={(e) => setDraft({ ...draft, sourceIdPattern: e.target.value })} />
                        </label>
                        <label>지표 패턴
                            <input value={draft.metricPattern || ""}
                                onChange={(e) => setDraft({ ...draft, metricPattern: e.target.value })} />
                        </label>
                        <label>최소 레벨
                            <select value={draft.minLevel}
                                onChange={(e) => setDraft({ ...draft, minLevel: e.target.value })}>
                                <option value="warn">warn 이상</option>
                                <option value="critical">critical 만</option>
                            </select>
                        </label>
                        <label>수신자 그룹
                            <select value={draft.recipientGroupId || ""}
                                onChange={(e) => setDraft({ ...draft, recipientGroupId: parseInt(e.target.value, 10) })}>
                                <option value="">(선택)</option>
                                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                        </label>
                        <label>채널
                            <select value={draft.channelId || ""}
                                onChange={(e) => setDraft({ ...draft, channelId: parseInt(e.target.value, 10) })}>
                                <option value="">(선택)</option>
                                {channels.map((c) => <option key={c.id} value={c.id}>{c.kind}</option>)}
                            </select>
                        </label>
                        <label>쿨다운(초)
                            <input type="number" value={draft.cooldownSec}
                                onChange={(e) => setDraft({ ...draft, cooldownSec: parseInt(e.target.value, 10) || 0 })} />
                        </label>
                        <label>Clear 이벤트도 발송
                            <input type="checkbox" checked={!!draft.sendOnClear}
                                onChange={(e) => setDraft({ ...draft, sendOnClear: e.target.checked })} />
                        </label>
                    </div>
                    <div className="notif-actions">
                        <button type="button" onClick={save}>저장</button>
                        <button type="button" onClick={cancel}>취소</button>
                    </div>
                </section>
            )}
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Silence sub-tab
   ══════════════════════════════════════════════════════════════════ */

function SilencesPanel() {
    const [silences, setSilences] = useState([]);
    const [name, setName] = useState("");
    const [hours, setHours] = useState(1);
    const [reason, setReason] = useState("");
    const [sourceType, setSourceType] = useState("");
    const [sourceIdPattern, setSourceIdPattern] = useState("");

    const reload = useCallback(async () => {
        const list = await notificationSilenceService.list();
        setSilences(list);
    }, []);
    useEffect(() => { reload(); }, [reload]);

    const create = async () => {
        if (!name.trim()) { alert("이름이 필요합니다."); return; }
        await notificationSilenceService.create({
            name: name.trim(), hours: Number(hours), reason: reason.trim() || null,
            sourceType: sourceType || null,
            sourceIdPattern: sourceIdPattern.trim() || null,
        });
        setName(""); setReason(""); setHours(1); setSourceType(""); setSourceIdPattern("");
        await reload();
    };

    const remove = async (id) => {
        if (!confirm("억제 규칙을 삭제할까요?")) return;
        await notificationSilenceService.remove(id);
        await reload();
    };

    return (
        <div className="notif-pane">
            <section className="notif-card">
                <h3>지금부터 N시간 억제 (빠른 추가)</h3>
                <div className="notif-form-grid">
                    <label>이름<input value={name} onChange={(e) => setName(e.target.value)} placeholder="야간 점검" /></label>
                    <label>시간(시)<input type="number" min="0.5" step="0.5" value={hours}
                        onChange={(e) => setHours(e.target.value)} /></label>
                    <label>소스 타입
                        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                            {SOURCE_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                    </label>
                    <label>대상 패턴
                        <input value={sourceIdPattern} onChange={(e) => setSourceIdPattern(e.target.value)} placeholder="(정규식, 빈 값 = 전체)" />
                    </label>
                    <label>사유
                        <input value={reason} onChange={(e) => setReason(e.target.value)} />
                    </label>
                </div>
                <div className="notif-actions">
                    <button type="button" onClick={() => { setHours(1); }}>1h</button>
                    <button type="button" onClick={() => { setHours(4); }}>4h</button>
                    <button type="button" onClick={() => { setHours(8); }}>8h</button>
                    <button type="button" onClick={create}>+ 등록</button>
                </div>
            </section>

            <section className="notif-card">
                <h3>현재 등록된 억제 규칙</h3>
                <table className="notif-table">
                    <thead>
                        <tr>
                            <th>이름</th><th>시작</th><th>종료</th><th>소스</th><th>대상 패턴</th><th>사유</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {silences.map((s) => (
                            <tr key={s.id}>
                                <td>{s.name}</td>
                                <td>{formatIso(s.startsAt)}</td>
                                <td>{formatIso(s.endsAt)}</td>
                                <td>{s.sourceType || "(any)"}</td>
                                <td>{s.sourceIdPattern || "*"}</td>
                                <td>{s.reason || ""}</td>
                                <td><button type="button" className="notif-mini notif-danger" onClick={() => remove(s.id)}>삭제</button></td>
                            </tr>
                        ))}
                        {silences.length === 0 && (
                            <tr><td colSpan={7} className="notif-muted">등록된 억제 규칙이 없습니다.</td></tr>
                        )}
                    </tbody>
                </table>
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Queue sub-tab (delivery history)
   ══════════════════════════════════════════════════════════════════ */

function QueuePanel() {
    const [status, setStatus] = useState("");
    const [data, setData] = useState({ items: [], totalCount: 0 });
    const [offset, setOffset] = useState(0);
    const limit = 50;

    const reload = useCallback(async () => {
        const r = await notificationQueueService.list({
            status: status || undefined, limit, offset,
        });
        setData(r);
    }, [status, offset]);

    useEffect(() => { reload(); }, [reload]);

    const retry = async (id) => {
        await notificationQueueService.retry(id);
        await reload();
    };
    const cancel = async (id) => {
        await notificationQueueService.cancel(id);
        await reload();
    };

    return (
        <div className="notif-pane">
            <section className="notif-card">
                <div className="notif-card-head">
                    <h3>발송 이력</h3>
                    <div>
                        <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
                            <option value="">(전체)</option>
                            {Object.entries(QUEUE_STATUS_LABELS).map(([k, l]) => (
                                <option key={k} value={k}>{l}</option>
                            ))}
                        </select>
                        <button type="button" onClick={reload} style={{ marginLeft: 8 }}>새로고침</button>
                    </div>
                </div>
                <table className="notif-table notif-table-tight">
                    <thead>
                        <tr>
                            <th>#</th><th>생성</th><th>발송완료</th><th>상태</th><th>시도</th>
                            <th>수신자</th><th>제목</th><th>마지막 에러</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.items.map((it) => (
                            <tr key={it.id} className={`notif-status-${it.status}`}>
                                <td>{it.id}</td>
                                <td>{formatIso(it.createdAt)}</td>
                                <td>{formatIso(it.sentAt)}</td>
                                <td>{QUEUE_STATUS_LABELS[it.status] || it.status}</td>
                                <td>{it.attempt}</td>
                                <td>{it.recipientAddress}</td>
                                <td className="notif-truncate" title={it.subject}>{it.subject}</td>
                                <td className="notif-truncate" title={it.lastError || ""}>{it.lastError || ""}</td>
                                <td>
                                    {(it.status === "failed" || it.status === "dead") && (
                                        <button type="button" className="notif-mini" onClick={() => retry(it.id)}>재시도</button>
                                    )}
                                    {(it.status === "pending" || it.status === "failed") && (
                                        <button type="button" className="notif-mini notif-danger" onClick={() => cancel(it.id)}>취소</button>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {data.items.length === 0 && (
                            <tr><td colSpan={9} className="notif-muted">이력이 없습니다.</td></tr>
                        )}
                    </tbody>
                </table>
                <div className="notif-pager">
                    <span>{offset + 1} – {Math.min(offset + limit, data.totalCount)} / {data.totalCount}</span>
                    <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>이전</button>
                    <button type="button" disabled={offset + limit >= data.totalCount} onClick={() => setOffset(offset + limit)}>다음</button>
                </div>
            </section>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════
   Top-level NotificationsTab
   ══════════════════════════════════════════════════════════════════ */

export default function NotificationsTab() {
    const [sub, setSub] = useState("master");

    const Panel = useMemo(() => {
        switch (sub) {
            case "master": return MasterPanel;
            case "channels": return ChannelPanel;
            case "groups": return GroupsPanel;
            case "rules": return RulesPanel;
            case "silences": return SilencesPanel;
            case "queue": return QueuePanel;
            default: return MasterPanel;
        }
    }, [sub]);

    return (
        <div className="notif-tab-root">
            <nav className="notif-subtabs">
                {SUB_TABS.map((t) => (
                    <button key={t.key} type="button"
                        className={`notif-subtab ${sub === t.key ? "active" : ""}`}
                        onClick={() => setSub(t.key)}>
                        {t.label}
                    </button>
                ))}
            </nav>
            <div className="notif-tab-body">
                <Panel />
            </div>
        </div>
    );
}

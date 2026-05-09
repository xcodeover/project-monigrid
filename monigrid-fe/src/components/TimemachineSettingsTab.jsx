import React, { useCallback, useEffect, useRef, useState } from "react";
import { timemachineService } from "../services/dashboardService";
import { IconRefresh } from "./icons";
import { useConfigFooterRegister, useConfigFooterUnregister } from "../pages/configFooterContext";

/* ── Helpers ──────────────────────────────────────────────────── */

function formatTs(ms) {
    if (ms == null) return "-";
    try {
        const d = new Date(ms);
        const y = d.getFullYear();
        const M = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const h = String(d.getHours()).padStart(2, "0");
        const m = String(d.getMinutes()).padStart(2, "0");
        const s = String(d.getSeconds()).padStart(2, "0");
        return `${y}-${M}-${dd} ${h}:${m}:${s}`;
    } catch { return "-"; }
}

function formatDuration(ms) {
    if (ms == null || ms <= 0) return "-";
    const sec = Math.floor(ms / 1000);
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (days > 0) parts.push(`${days}일`);
    if (hours > 0) parts.push(`${hours}시간`);
    if (minutes > 0 && days === 0) parts.push(`${minutes}분`);
    return parts.length === 0 ? "1분 미만" : parts.join(" ");
}

/* ══════════════════════════════════════════════════════════════════
   TimemachineSettingsTab
   ══════════════════════════════════════════════════════════════════ */

export default function TimemachineSettingsTab() {
    const [hoursDraft, setHoursDraft] = useState("");
    const [serverHours, setServerHours] = useState(null);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const [retention, st] = await Promise.all([
                timemachineService.getRetention(),
                timemachineService.stats(),
            ]);
            const h = Number(retention?.retentionHours);
            setServerHours(Number.isFinite(h) ? h : 0);
            setHoursDraft(String(Number.isFinite(h) ? h : 0));
            setStats(st || null);
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "타임머신 상태를 불러올 수 없습니다.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleSave = async () => {
        const n = Number(hoursDraft);
        if (!Number.isFinite(n) || n < 0) {
            setError("보존 시간은 0 이상의 숫자여야 합니다.");
            return;
        }
        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const res = await timemachineService.setRetention(n);
            setServerHours(Number(res?.retentionHours ?? n));
            setSuccessMsg(`저장 완료 (${n} 시간)`);
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    };

    const isDirty = String(hoursDraft) !== String(serverHours);
    const span = stats?.minTsMs && stats?.maxTsMs ? stats.maxTsMs - stats.minTsMs : null;

    // 페이지 footer 의 단일 저장 버튼에 binding 등록 (요구 ①).
    const registerFooter = useConfigFooterRegister();
    const unregisterFooter = useConfigFooterUnregister();
    const handleSaveRef = useRef();
    useEffect(() => { handleSaveRef.current = handleSave; });
    useEffect(() => {
        registerFooter({
            _key: "timemachine",
            isDirty,
            dirtyCount: isDirty ? 1 : 0,
            isSaving: saving,
            save: () => handleSaveRef.current?.(),
            saveLabel: "저장 & 적용",
        });
        return () => unregisterFooter("timemachine");
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isDirty, saving]);

    return (
        <div className="cfg-section wcfg-pane">
            <div className="cfg-section-header wcfg-header">
                <span style={{ fontSize: 13, fontWeight: 600 }}>타임머신 (대시보드 되감기)</span>
                <button
                    type="button"
                    className="cfg-add-btn"
                    onClick={load}
                    disabled={loading || saving}
                    title="새로고침"
                >
                    <IconRefresh size={14} /> 새로고침
                </button>
            </div>

            {error && <div className="cfg-msg cfg-msg-error">{error}</div>}

            <div className="wcfg-body">
                {loading ? (
                    <div className="cfg-loading">불러오는 중...</div>
                ) : (
                    <>
                        <section className="wcfg-group">
                            <header className="wcfg-group-header">
                                <h3>보존 시간</h3>
                            </header>
                            <p className="wcfg-hint" style={{ marginBottom: 10 }}>
                                BE 가 주기적으로 수집하는 모든 데이터(모니터 타겟 + 데이터 API)는
                                노드 로컬 SQLite 파일에 압축 저장됩니다. 아래에서 설정한 시간보다
                                오래된 샘플은 30분 주기로 자동 삭제됩니다. <strong>0</strong> 으로
                                설정하면 자동 삭제가 비활성화됩니다 (저장은 계속).
                            </p>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                                <label className="wcfg-selector" style={{ minWidth: 200 }}>
                                    <span>보존 시간 (시간)</span>
                                    <input
                                        type="number"
                                        min="0"
                                        max="8760"
                                        step="1"
                                        value={hoursDraft}
                                        onChange={(e) => setHoursDraft(e.target.value)}
                                        disabled={saving}
                                    />
                                </label>
                                {successMsg && (
                                    <span className="wcfg-success" style={{ alignSelf: "center" }}>
                                        {successMsg}
                                    </span>
                                )}
                                <span style={{ alignSelf: "center", fontSize: 11, color: "var(--text-tertiary, #64748b)" }}>
                                    페이지 우측 하단의 ‘저장 &amp; 적용’ 버튼으로 적용됩니다.
                                </span>
                            </div>
                        </section>

                        <section className="wcfg-group">
                            <header className="wcfg-group-header">
                                <h3>저장소 상태</h3>
                            </header>
                            {stats?.enabled === false ? (
                                <div className="cfg-empty">
                                    BE 측에서 타임머신 저장소가 초기화되지 않았습니다.
                                    부팅 로그를 확인해 주세요.
                                </div>
                            ) : (
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                                    <div>
                                        <div style={{ fontSize: 11, color: "var(--text-tertiary, #64748b)" }}>저장된 샘플 수</div>
                                        <div style={{ fontSize: 16, fontWeight: 600 }}>{stats?.rowCount ?? 0}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 11, color: "var(--text-tertiary, #64748b)" }}>보유 기간</div>
                                        <div style={{ fontSize: 16, fontWeight: 600 }}>
                                            {span ? formatDuration(span) : "-"}
                                        </div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 11, color: "var(--text-tertiary, #64748b)" }}>가장 오래된 샘플</div>
                                        <div style={{ fontSize: 13 }}>{formatTs(stats?.minTsMs)}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: 11, color: "var(--text-tertiary, #64748b)" }}>가장 최근 샘플</div>
                                        <div style={{ fontSize: 13 }}>{formatTs(stats?.maxTsMs)}</div>
                                    </div>
                                </div>
                            )}
                        </section>
                    </>
                )}
            </div>
        </div>
    );
}

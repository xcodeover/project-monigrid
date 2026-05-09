import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { dashboardService, timemachineService } from "../services/api";
import { monitorService } from "../services/dashboardService";
import { IconArrowLeft, IconRefresh } from "../components/icons";
import "./TimemachinePage.css";

/* ── Helpers ──────────────────────────────────────────────────── */

function isoNowMinus(hoursAgo) {
    const d = new Date();
    d.setMilliseconds(0);
    d.setHours(d.getHours() - hoursAgo);
    return d;
}

function dateToLocalInput(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
}

function localInputToDate(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

function formatTs(ms) {
    if (ms == null) return "-";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    return d.toLocaleString();
}

const SOURCE_TYPE_LABELS = {
    "monitor:server_resource": "서버 리소스",
    "monitor:network": "네트워크",
    "monitor:http_status": "API 상태",
    data_api: "데이터 API",
};

function sourceTypeLabel(t) {
    return SOURCE_TYPE_LABELS[t] || t || "알 수 없음";
}

/* ══════════════════════════════════════════════════════════════════
   TimemachinePage  -  /timemachine
   ══════════════════════════════════════════════════════════════════ */

export default function TimemachinePage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);

    const [atLocal, setAtLocal] = useState(() =>
        dateToLocalInput(isoNowMinus(0)),
    );
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [stats, setStats] = useState(null);

    // 라벨 매핑 (sourceType, sourceId) → 사람 이름
    const [monitorTargets, setMonitorTargets] = useState([]);
    const [endpointCatalog, setEndpointCatalog] = useState([]);

    useEffect(() => {
        if (!isAuthenticated) navigate("/login");
    }, [isAuthenticated, navigate]);

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            monitorService.listTargets().catch(() => ({ targets: [] })),
            dashboardService.getApiEndpoints().catch(() => []),
            timemachineService.stats().catch(() => null),
        ]).then(([m, eps, st]) => {
            if (cancelled) return;
            setMonitorTargets(Array.isArray(m?.targets) ? m.targets : []);
            setEndpointCatalog(Array.isArray(eps) ? eps : []);
            setStats(st || null);
        });
        return () => { cancelled = true; };
    }, []);

    const labelMap = useMemo(() => {
        const map = new Map();
        for (const t of monitorTargets) {
            if (!t?.id) continue;
            const k = `monitor:${t.type}|${t.id}`;
            map.set(k, t.label || t.id);
        }
        for (const ep of endpointCatalog) {
            if (!ep?.id) continue;
            const k = `data_api|${ep.id}`;
            map.set(k, ep.title || ep.endpoint || ep.id);
        }
        return map;
    }, [monitorTargets, endpointCatalog]);

    const fetchAt = useCallback(async () => {
        const d = localInputToDate(atLocal);
        if (!d) {
            setError("시점 입력이 올바르지 않습니다.");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const data = await timemachineService.queryAt({ at: d.getTime() });
            setItems(Array.isArray(data?.items) ? data.items : []);
        } catch (e) {
            setError(
                e?.response?.data?.message ||
                e?.message ||
                "타임머신 데이터를 불러올 수 없습니다.",
            );
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, [atLocal]);

    // 마운트 후 한 번 + atLocal 변경 시 자동 조회
    useEffect(() => { fetchAt(); }, [fetchAt]);

    const handleStep = (deltaMinutes) => {
        const d = localInputToDate(atLocal) || new Date();
        d.setMinutes(d.getMinutes() + deltaMinutes);
        setAtLocal(dateToLocalInput(d));
    };

    const handleQuickPick = (hoursAgo) => {
        setAtLocal(dateToLocalInput(isoNowMinus(hoursAgo)));
    };

    const handleLogout = () => { logout(); navigate("/login"); };

    const grouped = useMemo(() => {
        const out = {};
        for (const it of items) {
            const k = it.sourceType || "?";
            (out[k] ??= []).push(it);
        }
        // sort each group by label
        for (const k of Object.keys(out)) {
            out[k].sort((a, b) => {
                const la = labelMap.get(`${a.sourceType}|${a.sourceId}`) || a.sourceId;
                const lb = labelMap.get(`${b.sourceType}|${b.sourceId}`) || b.sourceId;
                return String(la).localeCompare(String(lb));
            });
        }
        return out;
    }, [items, labelMap]);

    return (
        <div className="tm-page">
            <header className="tm-header">
                <button
                    type="button"
                    className="tm-icon-btn"
                    onClick={() => navigate("/dashboard")}
                    title="대시보드로"
                    aria-label="대시보드로"
                >
                    <IconArrowLeft size={16} />
                </button>
                <div className="tm-header-text">
                    <h1>⏪ 타임머신</h1>
                    <p>BE 가 수집한 모든 데이터의 임의 시점 스냅샷을 조회합니다.</p>
                </div>
                <div className="tm-actions">
                    <span className="tm-user">@{user?.username || "user"}</span>
                    <button type="button" className="tm-btn" onClick={handleLogout}>
                        로그아웃
                    </button>
                </div>
            </header>

            <section className="tm-controls">
                <label className="tm-control">
                    <span>시점</span>
                    <input
                        type="datetime-local"
                        value={atLocal}
                        onChange={(e) => setAtLocal(e.target.value)}
                    />
                </label>
                <div className="tm-step-row">
                    <button type="button" className="tm-btn" onClick={() => handleStep(-60)}>
                        -1h
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleStep(-15)}>
                        -15m
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleStep(-5)}>
                        -5m
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleStep(5)}>
                        +5m
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleStep(15)}>
                        +15m
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleStep(60)}>
                        +1h
                    </button>
                </div>
                <div className="tm-step-row">
                    <button type="button" className="tm-btn" onClick={() => handleQuickPick(0)}>
                        지금
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleQuickPick(1)}>
                        1시간 전
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleQuickPick(6)}>
                        6시간 전
                    </button>
                    <button type="button" className="tm-btn" onClick={() => handleQuickPick(24)}>
                        24시간 전
                    </button>
                </div>
                <button
                    type="button"
                    className="tm-btn tm-btn-primary"
                    onClick={fetchAt}
                    disabled={loading}
                    title="새로고침"
                >
                    <IconRefresh size={14} /> {loading ? "조회 중…" : "조회"}
                </button>
                {stats?.enabled !== false && (
                    <span className="tm-stats-hint">
                        보유: {stats?.rowCount ?? 0}건 · {formatTs(stats?.minTsMs)} ~ {formatTs(stats?.maxTsMs)}
                    </span>
                )}
            </section>

            <main className="tm-main">
                {error && <div className="tm-msg tm-msg-error">{error}</div>}
                {!error && items.length === 0 && !loading && (
                    <div className="tm-msg tm-msg-empty">
                        선택한 시점에 보존된 샘플이 없습니다.
                    </div>
                )}
                {Object.keys(grouped).sort().map((group) => (
                    <section key={group} className="tm-group">
                        <header className="tm-group-header">
                            <h2>{sourceTypeLabel(group)}</h2>
                            <span className="tm-group-count">{grouped[group].length}건</span>
                        </header>
                        <div className="tm-cards">
                            {grouped[group].map((it) => {
                                const lblKey = `${it.sourceType}|${it.sourceId}`;
                                const label = labelMap.get(lblKey) || it.sourceId;
                                return (
                                    <article
                                        key={lblKey}
                                        className="tm-card"
                                        title={`샘플 시각: ${formatTs(it.tsMs)}`}
                                    >
                                        <header className="tm-card-header">
                                            <span className="tm-card-label">{label}</span>
                                            <span className="tm-card-id">{it.sourceId}</span>
                                        </header>
                                        <div className="tm-card-ts">
                                            샘플 시각: {formatTs(it.tsMs)}
                                        </div>
                                        <pre className="tm-card-payload">
{JSON.stringify(it.payload, null, 2)}
                                        </pre>
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </main>
        </div>
    );
}

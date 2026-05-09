import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { dashboardService } from "../services/api";
import { monitorService } from "../services/dashboardService";
import { useDocumentVisible } from "../hooks/useDocumentVisible";
import { IconRefresh } from "../components/icons";
import "./AlertHistoryPage.css";

/* ── Helpers ──────────────────────────────────────────────────── */

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 1000; // BE limit cap; we paginate until total exhausted

/** RFC 4180 escape: 콤마/큰따옴표/개행이 있으면 큰따옴표 wrap + 내부 큰따옴표 escape */
const escapeCsvField = (val) => {
    const s = val == null ? "" : String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
};

/** Trigger browser download of a CSV string. UTF-8 BOM 포함해 Excel 한글 대응. */
const triggerCsvDownload = (filename, headerCols, dataRows) => {
    const lines = [
        headerCols.map(escapeCsvField).join(","),
        ...dataRows.map((r) => r.map(escapeCsvField).join(",")),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], {
        type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 0);
};

const SOURCE_TYPE_LABELS = {
    server_resource: "서버 리소스",
    network: "네트워크",
    http_status: "API 상태",
    data_api: "데이터 API",
    // historical (Phase 2 step 2a) — widget_type 단순화 이전 라벨
    "data_api:table": "데이터 API (표)",
    "data_api:line-chart": "데이터 API (라인)",
    "data_api:bar-chart": "데이터 API (바)",
};

const SEVERITY_LABELS = {
    raise: "발생",
    clear: "해제",
};

const formatDateTime = (value) => {
    if (!value) return "-";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return String(value);
    const y = parsed.getFullYear();
    const M = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    const h = String(parsed.getHours()).padStart(2, "0");
    const m = String(parsed.getMinutes()).padStart(2, "0");
    const s = String(parsed.getSeconds()).padStart(2, "0");
    return `${y}-${M}-${d} ${h}:${m}:${s}`;
};

// `<input type="datetime-local">` 의 value 는 timezone offset 이 빠진
// "YYYY-MM-DDTHH:mm" 문자열이다. BE 는 ISO-8601 으로 비교하므로 그 문자열에
// `:00` 만 붙여 ISO-like 로 만들어 보낸다 (정확한 timezone 은 사용자 로컬 기준).
const localDateTimeToIso = (value) => {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    return trimmed.length === 16 ? `${trimmed}:00` : trimmed;
};

/* ── Page ─────────────────────────────────────────────────────── */

export default function AlertHistoryPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);
    const visible = useDocumentVisible();

    // ── 필터 (UI draft) ────────────────────────────────────────
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [sourceType, setSourceType] = useState("");
    const [sourceId, setSourceId] = useState("");
    const [severity, setSeverity] = useState("");
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(0);

    // ── 결과 ───────────────────────────────────────────────────
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [exporting, setExporting] = useState(false);

    // 모니터 타겟 카탈로그 — sourceId 드롭다운에서 라벨 매핑/선택지에 사용
    const [targets, setTargets] = useState([]);

    useEffect(() => {
        if (!isAuthenticated) navigate("/login");
    }, [isAuthenticated, navigate]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await monitorService.listTargets();
                if (cancelled) return;
                setTargets(Array.isArray(data?.targets) ? data.targets : []);
            } catch {
                if (!cancelled) setTargets([]);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const targetIdToLabel = useMemo(() => {
        const map = {};
        for (const t of targets) {
            if (t?.id) map[t.id] = t.label || t.id;
        }
        return map;
    }, [targets]);

    const filteredTargets = useMemo(() => {
        if (!sourceType) return targets;
        return targets.filter((t) => t.type === sourceType);
    }, [targets, sourceType]);

    // ── 조회 ───────────────────────────────────────────────────
    const fetchAlerts = useCallback(async (overrides = {}) => {
        setLoading(true);
        setError(null);
        const offset = overrides.page != null ? overrides.page * PAGE_SIZE : page * PAGE_SIZE;
        const params = {
            from: localDateTimeToIso(from),
            to: localDateTimeToIso(to),
            sourceType: sourceType || null,
            sourceId: sourceId || null,
            severity: severity || null,
            keyword: keyword || null,
            limit: PAGE_SIZE,
            offset,
        };
        // strip nulls — apiClient sends "null" as string otherwise
        Object.keys(params).forEach((k) => {
            if (params[k] == null || params[k] === "") delete params[k];
        });
        try {
            const data = await dashboardService.getAlerts(params);
            setItems(Array.isArray(data?.items) ? data.items : []);
            setTotal(Number.isFinite(data?.totalCount) ? data.totalCount : 0);
        } catch (err) {
            setError(err?.response?.data?.message || err?.message || "알림 이력을 불러올 수 없습니다.");
            setItems([]);
            setTotal(0);
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, sourceType, sourceId, severity, keyword, page]);

    // 첫 마운트 + 30초 주기 자동 새로고침 (현재 필터/페이지 그대로 재요청)
    useEffect(() => {
        if (!isAuthenticated || !visible) return;
        fetchAlerts();
        const id = setInterval(fetchAlerts, 30_000);
        return () => clearInterval(id);
    // fetchAlerts 는 deps 에서 의도적으로 제외 — 매 렌더의 새 reference 가
    // functionally identical, 30s timer 가 매번 재설정될 필요 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, visible]);

    // ── 핸들러 ─────────────────────────────────────────────────
    const handleSubmit = (e) => {
        e?.preventDefault?.();
        setPage(0);
        fetchAlerts({ page: 0 });
    };

    const handleReset = () => {
        setFrom(""); setTo(""); setSourceType(""); setSourceId("");
        setSeverity(""); setKeyword(""); setPage(0);
        // setState batch 직후의 fetchAlerts 는 stale 이므로 한 번 더 호출
        setTimeout(() => fetchAlerts({ page: 0 }), 0);
    };

    const handlePrev = () => {
        if (page === 0) return;
        const next = page - 1;
        setPage(next);
        fetchAlerts({ page: next });
    };

    const handleNext = () => {
        const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
        if (page >= maxPage) return;
        const next = page + 1;
        setPage(next);
        fetchAlerts({ page: next });
    };

    // ── CSV export ────────────────────────────────────────────
    // 현재 필터 조건에 매칭되는 모든 row 를 BE 의 limit=1000 페이지로 반복 요청해
    // 모은 뒤 클라이언트에서 CSV 로 변환해 다운로드한다. 페이징 도중 새 알람이
    // 발생해 total 이 늘어나도 첫 페이지 응답의 total 까지만 받고 끊는다.
    const handleExport = useCallback(async () => {
        if (exporting) return;
        setExporting(true);
        setError(null);
        try {
            const baseParams = {
                from: localDateTimeToIso(from),
                to: localDateTimeToIso(to),
                sourceType: sourceType || null,
                sourceId: sourceId || null,
                severity: severity || null,
                keyword: keyword || null,
            };
            Object.keys(baseParams).forEach((k) => {
                if (baseParams[k] == null || baseParams[k] === "") delete baseParams[k];
            });

            const collected = [];
            let offset = 0;
            let knownTotal = Infinity;
            while (offset < knownTotal) {
                const data = await dashboardService.getAlerts({
                    ...baseParams,
                    limit: EXPORT_PAGE_SIZE,
                    offset,
                });
                const batch = Array.isArray(data?.items) ? data.items : [];
                collected.push(...batch);
                if (Number.isFinite(data?.totalCount)) knownTotal = data.totalCount;
                if (batch.length < EXPORT_PAGE_SIZE) break;
                offset += batch.length;
            }

            if (collected.length === 0) {
                window.alert("내보낼 이력이 없습니다.");
                return;
            }

            const headerCols = [
                "시간", "구분", "레벨", "위젯 종류",
                "대상 라벨", "대상 ID", "메트릭", "메시지",
            ];
            const rows = collected.map((it) => [
                formatDateTime(it.createdAt),
                SEVERITY_LABELS[it.severity] || it.severity || "",
                (it.level || "").toUpperCase(),
                SOURCE_TYPE_LABELS[it.sourceType] || it.sourceType || "",
                it.label || targetIdToLabel[it.sourceId] || "",
                it.sourceId || "",
                it.metric || "",
                it.message || "",
            ]);

            const ts = new Date()
                .toISOString()
                .replace(/[-:T]/g, "")
                .slice(0, 14);
            triggerCsvDownload(`alert-history-${ts}.csv`, headerCols, rows);
        } catch (err) {
            setError(err?.response?.data?.message || err?.message || "CSV 내보내기 실패");
        } finally {
            setExporting(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [exporting, from, to, sourceType, sourceId, severity, keyword, targetIdToLabel]);

    const handleLogout = () => { logout(); navigate("/login"); };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="alert-history-page">
            <header className="ah-header">
                <div className="ah-title-wrap">
                    <h1>🚨 알림 이력</h1>
                    <p>BE 가 수집 갱신 직후 평가한 임계치 위반 / 회복 transition 이력입니다.</p>
                </div>
                <div className="ah-actions">
                    <span className="ah-user">@{user?.username || "user"}</span>
                    <button type="button" className="ah-btn" onClick={() => navigate("/dashboard")}>
                        대시보드
                    </button>
                    <button type="button" className="ah-btn" onClick={handleLogout}>
                        로그아웃
                    </button>
                </div>
            </header>

            <form className="ah-filters" onSubmit={handleSubmit}>
                <label>
                    <span>시작</span>
                    <input
                        type="datetime-local"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                    />
                </label>
                <label>
                    <span>종료</span>
                    <input
                        type="datetime-local"
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                    />
                </label>
                <label>
                    <span>위젯 종류</span>
                    <select value={sourceType} onChange={(e) => { setSourceType(e.target.value); setSourceId(""); }}>
                        <option value="">전체</option>
                        <option value="server_resource">서버 리소스</option>
                        <option value="network">네트워크</option>
                        <option value="http_status">API 상태</option>
                    </select>
                </label>
                <label>
                    <span>대상</span>
                    <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                        <option value="">전체</option>
                        {filteredTargets.map((t) => (
                            <option key={t.id} value={t.id}>
                                {t.label || t.id} ({t.id})
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    <span>구분</span>
                    <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                        <option value="">전체</option>
                        <option value="raise">발생</option>
                        <option value="clear">해제</option>
                    </select>
                </label>
                <label className="ah-keyword">
                    <span>키워드</span>
                    <input
                        type="text"
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        placeholder="라벨/메시지 검색"
                    />
                </label>
                <div className="ah-filter-actions">
                    <button type="submit" className="ah-btn ah-btn-primary">
                        조회
                    </button>
                    <button type="button" className="ah-btn" onClick={handleReset}>
                        초기화
                    </button>
                    <button
                        type="button"
                        className="ah-btn"
                        onClick={handleExport}
                        disabled={exporting || loading}
                        title="현재 필터에 매칭되는 전체 결과를 CSV 파일로 저장"
                    >
                        {exporting ? "내보내는 중..." : "CSV 내보내기"}
                    </button>
                    <button
                        type="button"
                        className="ah-btn"
                        onClick={() => fetchAlerts()}
                        title="새로고침"
                    >
                        <IconRefresh size={14} />
                    </button>
                </div>
            </form>

            <main className="ah-main">
                {error && <div className="ah-msg ah-msg-error">{error}</div>}
                {loading && <div className="ah-msg ah-msg-loading">불러오는 중...</div>}
                {!loading && !error && items.length === 0 && (
                    <div className="ah-msg ah-msg-empty">조건에 맞는 이력이 없습니다.</div>
                )}
                {items.length > 0 && (
                    <div className="ah-table-wrap">
                        <table className="ah-table">
                            <thead>
                                <tr>
                                    <th className="ah-col-time">시간</th>
                                    <th className="ah-col-sev">구분</th>
                                    <th className="ah-col-level">레벨</th>
                                    <th className="ah-col-source-type">위젯 종류</th>
                                    <th className="ah-col-target">대상</th>
                                    <th className="ah-col-target-id">대상 ID</th>
                                    <th className="ah-col-metric">메트릭</th>
                                    <th className="ah-col-msg">메시지</th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((it) => {
                                    const sevClass = `ah-sev ah-sev-${it.severity || "raise"}`;
                                    const levelClass = `ah-level ah-level-${(it.level || "warn").toLowerCase()}`;
                                    const targetLabel =
                                        it.label || targetIdToLabel[it.sourceId] || "-";
                                    const targetTitle = it.sourceId
                                        ? `${targetLabel} (${it.sourceId})`
                                        : targetLabel;
                                    const sourceTypeLabel =
                                        SOURCE_TYPE_LABELS[it.sourceType] || it.sourceType || "-";
                                    const message = it.message || "-";
                                    return (
                                        <tr key={it.id}>
                                            <td className="ah-cell-ts" title={formatDateTime(it.createdAt)}>
                                                {formatDateTime(it.createdAt)}
                                            </td>
                                            <td>
                                                <span className={sevClass}>
                                                    {SEVERITY_LABELS[it.severity] || it.severity || "-"}
                                                </span>
                                            </td>
                                            <td>
                                                <span className={levelClass}>
                                                    {(it.level || "-").toUpperCase()}
                                                </span>
                                            </td>
                                            <td className="ah-cell-truncate" title={sourceTypeLabel}>
                                                {sourceTypeLabel}
                                            </td>
                                            <td className="ah-cell-truncate" title={targetTitle}>
                                                {targetLabel}
                                            </td>
                                            <td className="ah-cell-truncate" title={it.sourceId || ""}>
                                                <span className="ah-target-id-inline">{it.sourceId || "-"}</span>
                                            </td>
                                            <td className="ah-cell-truncate" title={it.metric || ""}>
                                                {it.metric || "-"}
                                            </td>
                                            <td className="ah-cell-msg ah-cell-truncate" title={message}>
                                                {message}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </main>

            <footer className="ah-pager">
                <span className="ah-pager-info">
                    {total === 0
                        ? "0건"
                        : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} / ${total}건`}
                </span>
                <div className="ah-pager-actions">
                    <button type="button" className="ah-btn" onClick={handlePrev} disabled={page === 0 || loading}>
                        이전
                    </button>
                    <span className="ah-pager-page">{page + 1} / {totalPages}</span>
                    <button type="button" className="ah-btn" onClick={handleNext}
                            disabled={loading || (page + 1) * PAGE_SIZE >= total}>
                        다음
                    </button>
                </div>
            </footer>
        </div>
    );
}

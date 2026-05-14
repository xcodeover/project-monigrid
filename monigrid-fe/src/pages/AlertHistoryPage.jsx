import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { dashboardService } from "../services/api";
import { monitorService } from "../services/dashboardService";
import { IconArrowLeft, IconLogout } from "../components/icons";
import "./AlertHistoryPage.css";

/* ── Helpers ──────────────────────────────────────────────────── */

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 1000; // BE limit cap; we paginate until total exhausted

// 조회 부하 방지를 위한 최대 기간 (시작~종료 차이의 상한).
// 1년 = 365일. 윤년이라도 같은 월/일을 정확히 1년 잡으면 365 또는 366. 일관성을
// 위해 day 기준 365 로 고정 — 사용자가 정확히 같은 시각의 1년 전을 선택했을 때
// 윤년이면 살짝 초과로 막힐 수 있지만, 그 1일 차이는 안내 메시지로 충분.
const MAX_RANGE_DAYS = 365;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/** Date → datetime-local input value ("YYYY-MM-DDTHH:mm", 로컬 시각 기준). */
const toLocalInputValue = (date) => {
    const pad = (n) => String(n).padStart(2, "0");
    const y = date.getFullYear();
    const M = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const m = pad(date.getMinutes());
    return `${y}-${M}-${d}T${h}:${m}`;
};

/** 페이지 진입/초기화 시 사용할 default 범위: 한 달 전 ~ 현재. */
const getDefaultRange = () => {
    const now = new Date();
    const monthAgo = new Date(now);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    return {
        from: toLocalInputValue(monthAgo),
        to: toLocalInputValue(now),
    };
};

/**
 * 시작/종료 datetime-local 값의 유효성/범위 검증.
 * - 한쪽이 비어 있으면 검증 통과 (BE 측이 unbounded 으로 처리).
 * - 시작 > 종료 면 에러.
 * - 기간이 MAX_RANGE_DAYS 초과면 에러.
 * 반환: 에러 메시지(string) 또는 null.
 */
const validateRange = (fromVal, toVal) => {
    if (!fromVal || !toVal) return null;
    const fd = new Date(fromVal);
    const td = new Date(toVal);
    if (Number.isNaN(fd.getTime()) || Number.isNaN(td.getTime())) return null;
    if (fd.getTime() > td.getTime()) {
        return "시작 일시가 종료 일시보다 늦습니다.";
    }
    if (td.getTime() - fd.getTime() > MAX_RANGE_MS) {
        return `조회 기간은 최대 ${MAX_RANGE_DAYS}일 (1년) 까지만 가능합니다.`;
    }
    return null;
};

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

// 알람 transition 의 방향성을 직관적으로 보이도록 "정상 → 알람" 형태로 표시.
// raise = 정상 → 알람,  clear = 알람 → 정상.
const SEVERITY_LABELS = {
    raise: "정상 → 알람",
    clear: "알람 → 정상",
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
// "YYYY-MM-DDTHH:mm" 문자열로, 사용자 로컬 timezone 기준 wall-clock 시각이다.
// BE 는 created_at 을 UTC 로 저장하고 비교도 UTC 로 하므로, 입력값을 일단
// Date 로 파싱해 (브라우저 로컬 기준) 다시 toISOString() 으로 UTC ISO 변환한다.
// 잘못된 입력이면 null 반환.
const localDateTimeToIso = (value) => {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    const dt = new Date(trimmed);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
};

/* ── Page ─────────────────────────────────────────────────────── */

export default function AlertHistoryPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);

    // ── 필터 (UI draft) ────────────────────────────────────────
    // 페이지 진입 시 기본 범위: 한 달 전 ~ 현재. lazy init 으로 마운트 시 1회만
    // 계산되도록 함 — 매 렌더마다 new Date() 가 호출되지 않도록.
    const [from, setFrom] = useState(() => getDefaultRange().from);
    const [to, setTo] = useState(() => getDefaultRange().to);
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
        // 기간 검증 — 1년 초과 / 역전된 범위는 BE 호출 전에 차단.
        const rangeError = validateRange(from, to);
        if (rangeError) {
            setError(rangeError);
            setItems([]);
            setTotal(0);
            setLoading(false);
            return;
        }
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

    // 첫 마운트에 1회만 조회. 이후엔 사용자가 "조회" 또는 "초기화" 버튼을
    // 누를 때만 fetch — 자동 새로고침은 폐지.
    useEffect(() => {
        if (!isAuthenticated) return;
        fetchAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated]);

    // ── 핸들러 ─────────────────────────────────────────────────
    const handleSubmit = (e) => {
        e?.preventDefault?.();
        setPage(0);
        fetchAlerts({ page: 0 });
    };

    const handleReset = () => {
        // 시간 범위는 빈 값이 아닌 default (한 달 전 ~ 현재) 로 되돌린다.
        const r = getDefaultRange();
        setFrom(r.from); setTo(r.to);
        setSourceType(""); setSourceId("");
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
        // CSV 도 같은 1년 제한. 조회와 일치시켜 사용자에게 일관된 가드.
        const rangeError = validateRange(from, to);
        if (rangeError) {
            setError(rangeError);
            return;
        }
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
                // 알람→정상(clear) 은 회복 transition 이라 레벨이 의미 없어 빈칸.
                it.severity === "clear" ? "" : (it.level || "").toUpperCase(),
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
                <button
                    type="button"
                    className="ah-back-btn"
                    onClick={() => navigate("/dashboard")}
                    aria-label="뒤로가기"
                    title="대시보드로 돌아가기"
                >
                    <IconArrowLeft size={16} />
                </button>
                <div className="ah-title-wrap">
                    <h1>🚨 알림 이력</h1>
                    <p>BE 가 수집 갱신 직후 평가한 임계치 위반 / 회복 transition 이력입니다. (최대 조회 기간 1년)</p>
                </div>
                <div className="ah-actions">
                    <span className="ah-user">@{user?.username || "user"}</span>
                    <button
                        type="button"
                        className="ah-icon-btn-action"
                        onClick={handleLogout}
                        title="로그아웃"
                        aria-label="로그아웃"
                    >
                        <IconLogout size={16} />
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
                        <option value="raise">정상 → 알람</option>
                        <option value="clear">알람 → 정상</option>
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
                                                {it.severity === "clear" ? null : (
                                                    <span className={levelClass}>
                                                        {(it.level || "-").toUpperCase()}
                                                    </span>
                                                )}
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

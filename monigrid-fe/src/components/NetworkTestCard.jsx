import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import apiClient from "../services/http.js";
import { monitorService } from "../services/dashboardService.js";
import { useDocumentVisible } from "../hooks/useDocumentVisible.js";
import {
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    SIZE_STEP,
} from "../pages/dashboardConstants";
import {
    sortAlertsFirst,
    useAutoScrollTopOnDataChange,
} from "../utils/widgetListHelpers";
import MonitorTargetPicker from "./MonitorTargetPicker";
import { IconClose, IconRefresh, IconSettings } from "./icons";
import {
    clamp,
    formatInterval,
    formatLocalTime,
    toGridSize,
    toUserSize,
} from "./widgetUtils.js";

const NETWORK_TEST_COMPACT_THRESHOLD_USER = 3;
const NETWORK_TEST_NORMAL_THRESHOLD_USER = 6;
import WidgetSettingsModal from "./WidgetSettingsModal.jsx";
import "./ApiCard.css";
import "./NetworkTestCard.css";

/* ── helpers ─────────────────────────────────────────────────────── */

const MAX_TARGETS = 50;

const generateId = () =>
    `net-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const incrementLabel = (label) => {
    const m = label.match(/^(.*?)(\d+)$/);
    if (m) return m[1] + (parseInt(m[2], 10) + 1);
    return label ? `${label}-2` : "";
};

const migrateTargets = (cfg) => {
    if (!cfg) return [];
    if (Array.isArray(cfg.targets)) return cfg.targets;
    return [];
};

const formatTime = formatLocalTime;

/* ── TargetRow — single-line per target ──────────────────────────── */

const TargetRow = ({ target, state, displayMode }) => {
    const s = state || {};
    const checked = s.lastChecked != null;
    const loading = s.loading;
    const success = s.success;
    const compact = displayMode === "compact";

    // 체크 중(loading)이라도 직전 결과(OK/FAIL)를 그대로 유지한다.
    // 한 번도 체크한 적 없을 때만 회색/— 로 표시한다. 진행 중임은 spinner로 표시.
    const dotColor = !checked ? "#6b7280" : success ? "#22c55e" : "#ef4444";
    const statusText = !checked ? "—" : success ? "OK" : "FAIL";
    const statusClass = !checked ? "" : success ? "live" : "dead";

    const tooltip = [
        `이름: ${target.label || "(없음)"}`,
        `유형: ${target.type === "ping" ? "Ping (ICMP)" : "Telnet (TCP)"}`,
        `호스트: ${target.host || "-"}`,
        target.type === "telnet" ? `포트: ${target.port || "-"}` : null,
        `타임아웃: ${target.timeout || 5}초`,
        checked ? `상태: ${success ? "OK" : "FAIL"}` : null,
        checked && s.responseTimeMs != null ? `응답: ${s.responseTimeMs}ms` : null,
        s.error && !success ? `오류: ${s.error}` : null,
    ].filter(Boolean).join("\n");

    return (
        <div className={`net-row mode-${displayMode}${checked && !success ? " fail" : ""}`} title={tooltip}>
            <span className={`net-row-dot${checked && !success ? " pulse" : ""}`} style={{ backgroundColor: dotColor }} />
            <span className="net-row-label">
                {target.label || target.host}
            </span>
            <div className="net-row-right">
                {!compact && (
                    <span className="net-row-host">
                        {target.host}{target.type === "telnet" ? `:${target.port}` : ""}
                    </span>
                )}
                <span className="net-row-type">{target.type.toUpperCase()}</span>
                <span className={`net-row-status ${statusClass}`}>{statusText}</span>
                {checked && s.responseTimeMs != null ? (
                    <span className="net-row-latency">{s.responseTimeMs}ms</span>
                ) : (
                    <span className="net-row-latency">—</span>
                )}
                {loading && <span className="net-row-spinner" />}
            </div>
        </div>
    );
};

/* ── Settings modal (lazy-mounted) ───────────────────────────────────
   Lifted out so the draft state + sync useEffects + MonitorTargetPicker
   only mount while the modal is open. Previously these ran on every poll
   re-render of every NetworkTestCard, multiplied by widget count.
   ──────────────────────────────────────────────────────────────────── */
const NetworkTestSettingsModal = ({
    open,
    onClose,
    title,
    targetIds,
    currentSize,
    sizeBounds,
    refreshIntervalSec,
    onSizeChange,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    onWidgetConfigChange,
}) => {
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 5,
    });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 10);
    const [titleDraft, setTitleDraft] = useState(title);
    const [selectedTargetIdsDraft, setSelectedTargetIdsDraft] = useState(
        () => [...targetIds],
    );

    useEffect(() => {
        setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 5 });
    }, [currentSize?.w, currentSize?.h]);
    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? 10);
    }, [refreshIntervalSec]);
    useEffect(() => { setTitleDraft(title); }, [title]);

    const handleSizeApply = () => {
        const w = clamp(sizeDraft.w, sizeBounds?.minW ?? MIN_WIDGET_W, sizeBounds?.maxW ?? MAX_WIDGET_W, currentSize?.w ?? 8);
        const h = clamp(sizeDraft.h, sizeBounds?.minH ?? MIN_WIDGET_H, sizeBounds?.maxH ?? MAX_WIDGET_H, currentSize?.h ?? 5);
        setSizeDraft({ w, h });
        onSizeChange(w, h);
    };

    const handleIntervalApply = () => {
        const v = clamp(intervalDraft, MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, 10);
        setIntervalDraft(v);
        onRefreshIntervalChange(v);
    };

    const handleTitleApply = () => {
        const t = titleDraft.trim();
        if (t && t !== title) onWidgetMetaChange?.({ title: t });
    };

    const handleSaveTargets = () => {
        onWidgetConfigChange?.({ targetIds: selectedTargetIdsDraft });
        onClose?.();
    };

    return (
        <WidgetSettingsModal
            open={open}
            onClose={onClose}
            title='네트워크 테스트 위젯 설정'
            subtitle={title}
            closeOnBackdropClick={false}
        >
            <div className="settings-section">
                <h6>위젯 정보</h6>
                <div className="size-editor widget-meta-editor">
                    <label>
                        Title
                        <input type="text" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} />
                    </label>
                    <button type="button" className="size-preset-btn" onClick={handleTitleApply}>적용</button>
                </div>
            </div>
            <div className="settings-inline-row">
                <div className="settings-section">
                    <h6>위젯 크기</h6>
                    <div className="size-editor widget-size-editor">
                        <label>Width<input type="number" min={toUserSize(sizeBounds?.minW ?? MIN_WIDGET_W)} max={toUserSize(sizeBounds?.maxW ?? MAX_WIDGET_W)} step={SIZE_STEP} value={toUserSize(sizeDraft.w)} onChange={(e) => setSizeDraft((p) => ({ ...p, w: toGridSize(e.target.value) }))} /></label>
                        <label>Height<input type="number" min={sizeBounds?.minH ?? MIN_WIDGET_H} max={sizeBounds?.maxH ?? MAX_WIDGET_H} value={sizeDraft.h} onChange={(e) => setSizeDraft((p) => ({ ...p, h: e.target.value }))} /></label>
                        <button type="button" className="size-preset-btn" onClick={handleSizeApply}>적용</button>
                    </div>
                </div>
                <div className="settings-section refresh-interval-section">
                    <h6>갱신 주기 (초)</h6>
                    <div className="refresh-interval-editor">
                        <label className="refresh-interval-input-label"><span>Interval</span><input type="number" min={MIN_REFRESH_INTERVAL_SEC} max={MAX_REFRESH_INTERVAL_SEC} value={intervalDraft} onChange={(e) => setIntervalDraft(e.target.value)} /></label>
                        <button type="button" className="size-preset-btn" onClick={handleIntervalApply}>적용</button>
                    </div>
                </div>
            </div>
            <div className="settings-section srv-list-section">
                <div className="srv-list-header">
                    <h6>대상 선택 ({selectedTargetIdsDraft.length}개)</h6>
                </div>
                <MonitorTargetPicker
                    targetType="network"
                    selectedIds={selectedTargetIdsDraft}
                    onChange={setSelectedTargetIdsDraft}
                />
            </div>
            <div className="srv-settings-footer">
                <button type="button" className="size-preset-btn" onClick={onClose}>취소</button>
                <button type="button" className="size-preset-btn srv-save-btn" onClick={handleSaveTargets}>저장 ({selectedTargetIdsDraft.length}개)</button>
            </div>
        </WidgetSettingsModal>
    );
};

/* ══════════════════════════════════════════════════════════════════
   Main component
   ══════════════════════════════════════════════════════════════════ */

const NetworkTestCard = ({
    title,
    networkConfig,
    onRemove,
    currentSize,
    sizeBounds,
    onSizeChange,
    refreshIntervalSec,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    onWidgetConfigChange,
    onAlarmChange,
}) => {
    /* ── mode: snapshot (BE-centralized) vs legacy (probe-from-browser) */
    const targetIds = useMemo(
        () => (Array.isArray(networkConfig?.targetIds) ? networkConfig.targetIds : []),
        [networkConfig],
    );
    const useSnapshot = targetIds.length > 0;

    const legacyTargets = useMemo(() => migrateTargets(networkConfig), [networkConfig]);
    const [snapshotTargets, setSnapshotTargets] = useState([]);
    const targets = useSnapshot ? snapshotTargets : legacyTargets;

    // 그리드 해상도 doubling 이후 기준이 어긋나지 않도록 user-unit 으로 비교.
    const userW = toUserSize(currentSize?.w ?? 8);
    const displayMode =
        userW <= NETWORK_TEST_COMPACT_THRESHOLD_USER
            ? "compact"
            : userW <= NETWORK_TEST_NORMAL_THRESHOLD_USER
              ? "normal"
              : "wide";

    /* ── visibility-aware polling ────────────────────────────────── */
    const visible = useDocumentVisible();

    /* ── per-target state map ────────────────────────────────────── */
    const [targetStates, setTargetStates] = useState({});
    const targetsRef = useRef(targets);

    useEffect(() => { targetsRef.current = targets; }, [targets]);

    const checkAllTargets = useCallback(async () => {
        // Skip polling while tab is hidden to avoid wasted requests.
        // The visibility-flip effect triggers an immediate fetch on return.
        // NOTE: 탭이 숨겨진 동안에는 알람 감지가 최대 폴링 주기만큼 지연된다.
        if (document.hidden) return;
        if (useSnapshot) {
            if (targetIds.length === 0) return;
            try {
                const res = await monitorService.getSnapshot(targetIds);
                const items = Array.isArray(res?.items) ? res.items : [];
                const derived = items.map((it) => {
                    const spec = it.spec || {};
                    return {
                        id: it.targetId,
                        label: it.label || spec.host || it.targetId,
                        type: spec.type || "ping",
                        host: spec.host || "",
                        port: spec.port != null ? String(spec.port) : "",
                        timeout: spec.timeout != null ? String(spec.timeout) : "5",
                    };
                });
                setSnapshotTargets(derived);
                setTargetStates(() => {
                    const next = {};
                    items.forEach((it) => {
                        const d = it.data || {};
                        const hasError = !!it.errorMessage;
                        const success = !hasError && (d.success === true);
                        next[it.targetId] = {
                            success,
                            responseTimeMs: d.responseTimeMs ?? null,
                            error: hasError ? it.errorMessage : (success ? null : (d.message || "Fail")),
                            loading: false,
                            lastChecked: it.updatedAt ? new Date(it.updatedAt) : new Date(),
                        };
                    });
                    return next;
                });
            } catch (err) {
                const errorMsg = err?.response?.data?.message || err?.message || "스냅샷 조회 실패";
                setTargetStates((prev) => {
                    const next = { ...prev };
                    targetIds.forEach((tid) => {
                        next[tid] = {
                            success: false,
                            responseTimeMs: null,
                            error: errorMsg,
                            loading: false,
                            lastChecked: new Date(),
                        };
                    });
                    return next;
                });
            }
            return;
        }

        const list = targetsRef.current;
        if (list.length === 0) return;

        setTargetStates((prev) => {
            const next = { ...prev };
            list.forEach((t) => { next[t.id] = { ...next[t.id], loading: true }; });
            return next;
        });

        const batchTargets = list.map((t) => {
            const payload = {
                type: t.type,
                host: t.host?.trim() || "localhost",
                timeout: Number(t.timeout) || 5,
            };
            if (t.type === "ping") {
                payload.count = 1;
            } else {
                payload.port = Number(t.port) || 80;
            }
            return payload;
        });

        try {
            const res = await apiClient.post("/dashboard/network-test-batch", { targets: batchTargets });
            const batchResults = res.data?.results || [];

            setTargetStates((prev) => {
                const next = { ...prev };
                list.forEach((t, i) => {
                    const data = batchResults[i];
                    if (data) {
                        next[t.id] = {
                            success: data.success,
                            responseTimeMs: data.responseTimeMs ?? null,
                            error: data.success ? null : (data.message || "Fail"),
                            loading: false,
                            lastChecked: new Date(),
                        };
                    } else {
                        next[t.id] = {
                            success: false,
                            responseTimeMs: null,
                            error: "No result from batch",
                            loading: false,
                            lastChecked: new Date(),
                        };
                    }
                });
                return next;
            });
        } catch (err) {
            setTargetStates((prev) => {
                const next = { ...prev };
                list.forEach((t) => {
                    next[t.id] = {
                        success: false,
                        responseTimeMs: null,
                        error: err?.response?.data?.message || err?.message || "요청 실패",
                        loading: false,
                        lastChecked: new Date(),
                    };
                });
                return next;
            });
        }
    }, [useSnapshot, targetIds]);

    const pollKey = useMemo(() => (
        useSnapshot
            ? `s:${targetIds.join(",")}`
            : `l:${legacyTargets.map((t) => `${t.id}|${t.host}|${t.type}|${t.port}`).join(",")}`
    ), [useSnapshot, targetIds, legacyTargets]);

    const hasItems = useSnapshot ? targetIds.length > 0 : legacyTargets.length > 0;

    useEffect(() => {
        if (hasItems) checkAllTargets();
    }, [pollKey, hasItems, checkAllTargets]);

    useEffect(() => {
        if (!hasItems) return undefined;
        // refreshIntervalSec이 string("30")으로 들어와도 안전하게 처리한다.
        const sec = Math.max(MIN_REFRESH_INTERVAL_SEC, Number(refreshIntervalSec) || 10);
        const id = setInterval(checkAllTargets, sec * 1000);
        return () => clearInterval(id);
    }, [pollKey, hasItems, refreshIntervalSec, checkAllTargets]);

    // Visibility-flip: immediately refetch when the user returns to the tab so
    // the widget shows fresh data rather than stale results from before hiding.
    // Trade-off: all visible-flip fetches fire simultaneously (BE burst), but
    // this equals a normal dashboard load — acceptable for user freshness.
    // 최초 마운트 시 useDocumentVisible()이 true로 초기화되므로 이 effect가 즉시 실행돼
    // 스케줄링 effect의 첫 fetch와 중복된다. isFirstMountRef로 마운트 시 1회만 건너뛴다.
    const isFirstMountRef = useRef(true);
    useEffect(() => {
        if (isFirstMountRef.current) {
            isFirstMountRef.current = false;
            return;
        }
        if (visible && hasItems) checkAllTargets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    /* ── alarm reporting ──────────────────────────────────────���─── */
    const statusSummary = useMemo(() => {
        if (targets.length === 0) return null;
        let ok = 0, fail = 0, pending = 0;
        targets.forEach((t) => {
            const s = targetStates[t.id];
            if (!s || s.lastChecked == null) pending++;
            else if (s.success) ok++;
            else fail++;
        });
        return { ok, fail, pending, total: targets.length };
    }, [targets, targetStates]);

    // Detect backend-level failure (all targets unreachable due to backend down)
    const isDead = useMemo(() => {
        if (targets.length === 0) return false;
        return targets.every((t) => {
            const s = targetStates[t.id];
            return s && !s.loading && s.lastChecked != null && !s.success && s.error;
        });
    }, [targets, targetStates]);

    useEffect(() => {
        if (!onAlarmChange || !statusSummary) return;
        onAlarmChange(statusSummary.fail > 0 ? "dead" : "live");
    }, [statusSummary, onAlarmChange]);

    /* ── NG(실패/에러) 대상을 목록 상단으로 끌어올림 ──────────────── */
    // statusSummary 의 fail 판정과 동일한 기준: 체크 완료 & success=false.
    const displayTargets = useMemo(
        () =>
            sortAlertsFirst(targets, (t) => {
                const s = targetStates[t.id];
                if (!s || s.lastChecked == null) return false;
                return !s.success;
            }),
        [targets, targetStates],
    );

    /* ── 갱신 주기마다 목록 스크롤 최상단으로 ─────────────────────── */
    const scrollRef = useRef(null);
    useAutoScrollTopOnDataChange(scrollRef, targetStates);

    /* ── settings modal state ────────────────────────────────────── */
    const [showSettings, setShowSettings] = useState(false);
    const hasAutoOpened = useRef(false);

    useEffect(() => {
        // 새로 추가된 위젯에 대상이 비어있으면 settings 모달을 자동으로 한 번 열어준다.
        if (
            !hasAutoOpened.current &&
            targetIds.length === 0 &&
            legacyTargets.length === 0
        ) {
            setShowSettings(true);
            hasAutoOpened.current = true;
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const openSettings = useCallback(() => {
        setShowSettings(true);
    }, []);

    const lastChecked = useMemo(() => {
        let latest = null;
        Object.values(targetStates).forEach((s) => {
            if (s.lastChecked && (!latest || s.lastChecked > latest)) latest = s.lastChecked;
        });
        return latest;
    }, [targetStates]);

    /* ── render: main widget ─────────────────────────────────────── */
    return (
        <div className="api-card">
            <div className="api-card-header">
                <div className="api-card-title-section">
                    <div className="api-card-title-row">
                        <h4 title={title}>{title}</h4>
                        {isDead && (
                            <span className="status-pill dead">
                                <span className="status-dot" />
                                DEAD
                            </span>
                        )}
                        <div className="title-actions">
                            <button type="button" className="compact-icon-btn" onClick={checkAllTargets} title="새로고침" aria-label="새로고침"><IconRefresh size={14} /></button>
                            <button type="button" className="compact-icon-btn" onClick={openSettings} title="설정" aria-label="설정"><IconSettings size={14} /></button>
                            <button type="button" className="compact-icon-btn remove" onClick={onRemove} title="제거" aria-label="제거"><IconClose size={14} /></button>
                        </div>
                    </div>
                    <div className="api-endpoint-row">
                        <div className="api-endpoint-info">
                            {targets.length === 0 ? (
                                <span className="api-endpoint">대상 미설정</span>
                            ) : statusSummary ? (
                                <>
                                    {statusSummary.ok > 0 && <span className="status-badge ok">{statusSummary.ok} OK</span>}
                                    {statusSummary.fail > 0 && <span className="status-badge ng">{statusSummary.fail} NG</span>}
                                    {statusSummary.ok === 0 && statusSummary.fail === 0 && <span className="api-endpoint">{targets.length}개 대상</span>}
                                </>
                            ) : (
                                <span className="api-endpoint">{targets.length}개 대상</span>
                            )}
                        </div>
                        <span className="refresh-interval-chip">⏱ {formatInterval(refreshIntervalSec ?? 10)}</span>
                        {lastChecked && <span className="last-updated-time">{formatTime(lastChecked)}</span>}
                    </div>
                </div>
            </div>

            {showSettings && (
                <NetworkTestSettingsModal
                    open
                    onClose={() => setShowSettings(false)}
                    title={title}
                    targetIds={targetIds}
                    currentSize={currentSize}
                    sizeBounds={sizeBounds}
                    refreshIntervalSec={refreshIntervalSec}
                    onSizeChange={onSizeChange}
                    onRefreshIntervalChange={onRefreshIntervalChange}
                    onWidgetMetaChange={onWidgetMetaChange}
                    onWidgetConfigChange={onWidgetConfigChange}
                />
            )}

            <div className="api-card-content">
                {targets.length === 0 ? (
                    <div className="resource-setup-prompt">
                        <p>대상을 등록해 주세요.</p>
                        <button type="button" className="size-preset-btn" onClick={openSettings}>설정 열기</button>
                    </div>
                ) : (
                    <div
                        className={`net-list net-list-${displayMode}`}
                        ref={scrollRef}
                    >
                        {displayTargets.map((t) => (
                            <TargetRow
                                key={t.id}
                                target={t}
                                state={targetStates[t.id]}
                                displayMode={displayMode}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default NetworkTestCard;

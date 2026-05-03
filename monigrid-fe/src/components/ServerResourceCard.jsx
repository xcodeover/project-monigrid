import {
    useEffect,
    useState,
    useRef,
    useCallback,
    useMemo,
} from "react";
import apiClient from "../services/http.js";
import { monitorService } from "../services/dashboardService.js";
import {
    MAX_REFRESH_INTERVAL_SEC,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_REFRESH_INTERVAL_SEC,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
} from "../pages/dashboardConstants";
import {
    DEFAULT_CRITERIA,
    MAX_HISTORY,
    checkCriteria,
    clamp,
    formatElapsed,
    formatInterval,
    formatTime,
    migrateServers,
} from "./serverResourceHelpers";
import ServerRow from "./ServerRow";
import ServerDetailPopup from "./ServerDetailPopup";
import ServerResourceSettingsModal from "./ServerResourceSettingsModal";
import { IconClose, IconRefresh, IconSettings } from "./icons";
import {
    sortAlertsFirst,
    useAutoScrollTopOnDataChange,
} from "../utils/widgetListHelpers";
import "./ApiCard.css";
import "./ServerResourceCard.css";

/**
 * Container for the multi-server resource monitor widget.
 *
 * Owns: server polling, per-server state, history accumulation, settings
 * draft state, alarm reporting. All visual sub-components are stateless
 * and live in their own files (SRP).
 */
const ServerResourceCard = ({
    title,
    widgetConfig,
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
    /* ── mode: snapshot (BE-centralized) vs legacy (credentials in widget) */
    const targetIds = useMemo(
        () => (Array.isArray(widgetConfig?.targetIds) ? widgetConfig.targetIds : []),
        [widgetConfig],
    );
    const useSnapshot = targetIds.length > 0;

    /* ── derived: servers list ────────────────────────────────────
     * snapshot mode → built from the latest /monitor-snapshot response
     * legacy mode   → migrateServers(widgetConfig.servers)
     */
    const [snapshotServers, setSnapshotServers] = useState([]);
    const legacyServers = useMemo(() => migrateServers(widgetConfig), [widgetConfig]);
    const servers = useSnapshot ? snapshotServers : legacyServers;

    /* ── display mode based on grid width ────────────────────────── */
    const widgetW = currentSize?.w ?? 4;
    const displayMode =
        widgetW <= 2
            ? "mini"
            : widgetW <= 3
              ? "compact"
              : widgetW <= 6
                ? "normal"
                : "wide";

    /* ── per-server data map ─────────────────────────────────────── */
    const [serverStates, setServerStates] = useState({});
    const [diskCycleIdx, setDiskCycleIdx] = useState(0);
    const serversRef = useRef(servers);
    const timerRef = useRef(null);

    /* ── history for detail popup charts ────────────────────────── */
    const historyRef = useRef({});
    const [historyVersion, setHistoryVersion] = useState(0);
    const [detailServerId, setDetailServerId] = useState(null);

    useEffect(() => {
        serversRef.current = servers;
    }, [servers]);

    // 서버 목록이 변하면 historyRef에서 사라진 서버의 히스토리 키를 정리한다.
    // (각 키는 MAX_HISTORY로 cap되지만, 잦은 추가/삭제 시 유령 키가 누적될 수 있음)
    useEffect(() => {
        const liveIds = new Set(servers.map((s) => s.id));
        let purged = false;
        Object.keys(historyRef.current).forEach((id) => {
            if (!liveIds.has(id)) {
                delete historyRef.current[id];
                purged = true;
            }
        });
        if (purged) setHistoryVersion((v) => v + 1);
    }, [servers]);

    const fetchAllServers = useCallback(async () => {
        if (useSnapshot) {
            if (targetIds.length === 0) return;
            setDiskCycleIdx((prev) => prev + 1);
            try {
                const res = await monitorService.getSnapshot(targetIds);
                const items = Array.isArray(res?.items) ? res.items : [];
                const criteriaOverrides = widgetConfig?.criteriaByTarget || {};
                const now = new Date();
                const derivedServers = items.map((it) => ({
                    id: it.targetId,
                    label: it.label || it.spec?.host || it.targetId,
                    osType: it.spec?.os_type || it.spec?.osType || "linux-generic",
                    host: it.spec?.host || "",
                    criteria: {
                        ...DEFAULT_CRITERIA,
                        ...(it.spec?.criteria || {}),
                        ...(criteriaOverrides[it.targetId] || {}),
                    },
                }));
                setSnapshotServers(derivedServers);
                setServerStates(() => {
                    const next = {};
                    items.forEach((it) => {
                        next[it.targetId] = {
                            data: it.data,
                            error: it.errorMessage || null,
                            loading: false,
                            lastUpdated: it.updatedAt ? new Date(it.updatedAt) : null,
                            lastAttempted: now,
                        };
                    });
                    return next;
                });
            } catch (err) {
                const errorMsg = err?.response?.data?.message || err?.message || "스냅샷 조회 실패";
                setServerStates((prev) => {
                    const next = { ...prev };
                    targetIds.forEach((tid) => {
                        next[tid] = {
                            data: prev[tid]?.data ?? null,
                            error: errorMsg,
                            loading: false,
                            lastUpdated: prev[tid]?.lastUpdated ?? null,
                            lastAttempted: new Date(),
                        };
                    });
                    return next;
                });
            }
            return;
        }

        const list = serversRef.current;
        if (list.length === 0) return;
        setDiskCycleIdx((prev) => prev + 1);

        const batchPayload = list.map((srv) => {
            const item = { os_type: srv.osType, host: srv.host || "localhost" };
            if (
                srv.osType === "windows" &&
                srv.host !== "localhost" &&
                srv.host !== "127.0.0.1"
            ) {
                if (srv.username) item.username = srv.username;
                if (srv.password) item.password = srv.password;
                if (srv.domain) item.domain = srv.domain;
            }
            if (srv.osType === "windows-winrm") {
                item.username = srv.username;
                item.password = srv.password;
                if (srv.domain) item.domain = srv.domain;
                if (srv.port) item.port = Number(srv.port);
                if (srv.transport) item.transport = srv.transport;
            }
            if (
                (srv.osType.startsWith("linux") || srv.osType === "windows-ssh") &&
                srv.host !== "localhost" &&
                srv.host !== "127.0.0.1"
            ) {
                item.username = srv.username;
                item.password = srv.password;
                if (srv.port) item.port = Number(srv.port);
            }
            return item;
        });

        try {
            const res = await apiClient.post(
                "/dashboard/server-resources-batch",
                { servers: batchPayload },
            );
            const batchResults = res.data?.results || [];

            setServerStates((prev) => {
                const next = { ...prev };
                list.forEach((srv, i) => {
                    const data = batchResults[i] || null;
                    const now = new Date();
                    if (data) {
                        next[srv.id] = {
                            data,
                            error: data.error || null,
                            loading: false,
                            lastUpdated: now,
                            lastAttempted: now,
                        };
                    } else {
                        next[srv.id] = {
                            data: next[srv.id]?.data ?? null,
                            error: "No result from batch",
                            loading: false,
                            lastUpdated: next[srv.id]?.lastUpdated ?? null,
                            lastAttempted: now,
                        };
                    }
                });
                return next;
            });
        } catch (err) {
            const errorMsg =
                err?.response?.data?.message || err?.message || "요청 실패";
            setServerStates((prev) => {
                const next = { ...prev };
                list.forEach((srv) => {
                    next[srv.id] = {
                        data: next[srv.id]?.data ?? null,
                        error: errorMsg,
                        loading: false,
                        lastUpdated: next[srv.id]?.lastUpdated ?? null,
                        lastAttempted: new Date(),
                    };
                });
                return next;
            });
        }
    }, [useSnapshot, targetIds, widgetConfig]);

    // stable key for detecting server list changes.
    // snapshot mode: tracks the target id set.
    // legacy mode: tracks each server's identity (host/os may change).
    const pollKey = useMemo(() => (
        useSnapshot
            ? `s:${targetIds.join(",")}`
            : `l:${legacyServers.map((s) => `${s.id}|${s.host}|${s.osType}`).join(",")}`
    ), [useSnapshot, targetIds, legacyServers]);

    const hasItems = useSnapshot ? targetIds.length > 0 : legacyServers.length > 0;

    useEffect(() => {
        if (hasItems) fetchAllServers();
    }, [pollKey, hasItems, fetchAllServers]);

    useEffect(() => {
        if (!hasItems) return;
        const ms = (refreshIntervalSec ?? 30) * 1000;
        timerRef.current = setInterval(fetchAllServers, ms);
        return () => clearInterval(timerRef.current);
    }, [pollKey, hasItems, refreshIntervalSec, fetchAllServers]);

    /* ── accumulate history for charts ─────────────────────────── */
    useEffect(() => {
        const now = Date.now();
        let changed = false;
        Object.entries(serverStates).forEach(([id, state]) => {
            if (!state?.data) return;
            const d = state.data;
            const point = {
                ts: now,
                cpu: d.cpu?.usedPct ?? null,
                memory: d.memory?.usedPct ?? null,
            };
            (d.disks || []).forEach((dk) => {
                const key = `disk_${(dk.mount || "root").toLowerCase()}`;
                point[key] = dk.usedPct ?? null;
            });
            const prev = historyRef.current[id] || [];
            // Avoid duplicates for same timestamp (within 500ms)
            if (prev.length > 0 && Math.abs(prev[prev.length - 1].ts - now) < 500)
                return;
            // Always create a new array (React dev mode may freeze arrays passed as props)
            const next = [...prev, point];
            historyRef.current[id] =
                next.length > MAX_HISTORY
                    ? next.slice(next.length - MAX_HISTORY)
                    : next;
            changed = true;
        });
        if (changed) setHistoryVersion((v) => v + 1);
    }, [serverStates]);

    const detailServer = useMemo(
        () =>
            detailServerId
                ? servers.find((s) => s.id === detailServerId)
                : null,
        [detailServerId, servers],
    );

    const detailHistory = useMemo(
        () => (detailServerId ? historyRef.current[detailServerId] || [] : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [detailServerId, historyVersion],
    );

    /* ── per-server violations (criteria check) ─────────────────── */
    const violationsMap = useMemo(() => {
        const map = {};
        servers.forEach((srv) => {
            const state = serverStates[srv.id];
            if (state?.data) {
                map[srv.id] = checkCriteria(
                    state.data,
                    srv.criteria || DEFAULT_CRITERIA,
                );
            }
        });
        return map;
    }, [servers, serverStates]);

    const totalViolations = useMemo(
        () =>
            Object.values(violationsMap).reduce((sum, v) => sum + v.length, 0),
        [violationsMap],
    );

    /* ── NG(알람) 서버를 목록 상단으로 끌어올림 ───────────────────── */
    // 판정 기준은 statusCounts 와 동일: 접속 에러(데이터 없음) 또는 임계치 위반.
    const displayServers = useMemo(
        () =>
            sortAlertsFirst(servers, (srv) => {
                const state = serverStates[srv.id];
                if (state?.error && !state?.data) return true;
                return (violationsMap[srv.id] || []).length > 0;
            }),
        [servers, serverStates, violationsMap],
    );

    const statusCounts = useMemo(() => {
        let ok = 0,
            ng = 0;
        servers.forEach((srv) => {
            const state = serverStates[srv.id];
            const v = violationsMap[srv.id] || [];
            if (!state?.data && state?.error) ng++;
            else if (v.length > 0) ng++;
            else if (state?.data) ok++;
        });
        return { ok, ng };
    }, [servers, serverStates, violationsMap]);

    // Detect backend-level failure (all servers unreachable)
    const isDead = useMemo(() => {
        if (servers.length === 0) return false;
        return servers.every((srv) => {
            const st = serverStates[srv.id];
            return st?.error && !st?.data;
        });
    }, [servers, serverStates]);

    // Stale: data exists but last successful fetch is too old, or
    // the most recent attempt failed while old data is still displayed
    const isStale = useMemo(() => {
        if (servers.length === 0 || isDead) return false;
        const staleSec = (refreshIntervalSec ?? 30) * 3;
        const now = Date.now();
        return servers.some((srv) => {
            const st = serverStates[srv.id];
            if (!st) return false;
            // Has error while showing stale data
            if (st.error && st.data) return true;
            // Last successful update is too old
            if (st.lastUpdated && (now - st.lastUpdated.getTime()) > staleSec * 1000) return true;
            return false;
        });
    }, [servers, serverStates, isDead, refreshIntervalSec]);

    // Report alarm status to parent
    useEffect(() => {
        if (!onAlarmChange) return;
        onAlarmChange(totalViolations > 0 || isDead ? "dead" : "live");
    }, [totalViolations, isDead, onAlarmChange]);

    /* ── 갱신 주기마다 목록 스크롤 최상단으로 ─────────────────────── */
    const scrollRef = useRef(null);
    useAutoScrollTopOnDataChange(scrollRef, serverStates);

    /* ── settings modal state ────────────────────────────────────── */
    const [showSettings, setShowSettings] = useState(false);
    const hasAutoOpened = useRef(false);

    useEffect(() => {
        // 새로 추가된 위젯에 대상이 비어있으면 settings 모달을 자동으로 한 번 열어준다.
        if (
            !hasAutoOpened.current &&
            targetIds.length === 0 &&
            legacyServers.length === 0
        ) {
            setShowSettings(true);
            hasAutoOpened.current = true;
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* ── settings draft state ────────────────────────────────────── */
    const [sizeDraft, setSizeDraft] = useState({
        w: currentSize?.w ?? 4,
        h: currentSize?.h ?? 5,
    });
    const [intervalDraft, setIntervalDraft] = useState(refreshIntervalSec ?? 30);
    const [titleDraft, setTitleDraft] = useState(title);
    const [selectedTargetIdsDraft, setSelectedTargetIdsDraft] = useState([]);

    useEffect(() => {
        setSizeDraft({ w: currentSize?.w ?? 4, h: currentSize?.h ?? 5 });
    }, [currentSize?.w, currentSize?.h]);
    useEffect(() => {
        setIntervalDraft(refreshIntervalSec ?? 30);
    }, [refreshIntervalSec]);
    useEffect(() => {
        setTitleDraft(title);
    }, [title]);

    const openSettings = useCallback(() => {
        setSelectedTargetIdsDraft([...targetIds]);
        setShowSettings(true);
    }, [targetIds]);

    /* ── settings handlers ───────────────────────────────────────── */
    const handleSizeApply = () => {
        const w = clamp(
            sizeDraft.w,
            sizeBounds?.minW ?? MIN_WIDGET_W,
            sizeBounds?.maxW ?? MAX_WIDGET_W,
            currentSize?.w ?? 8,
        );
        const h = clamp(
            sizeDraft.h,
            sizeBounds?.minH ?? MIN_WIDGET_H,
            sizeBounds?.maxH ?? MAX_WIDGET_H,
            currentSize?.h ?? 5,
        );
        setSizeDraft({ w, h });
        onSizeChange(w, h);
    };

    const handleIntervalApply = () => {
        const v = clamp(intervalDraft, MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC, 30);
        setIntervalDraft(v);
        onRefreshIntervalChange(v);
    };

    const handleTitleApply = () => {
        const t = titleDraft.trim();
        if (t && t !== title) onWidgetMetaChange?.({ title: t });
    };

    const handleSaveTargets = () => {
        onWidgetConfigChange?.({ targetIds: selectedTargetIdsDraft });
        setShowSettings(false);
    };

    /* ── summary info ────────────────────────────────────────────── */
    const lastUpdated = useMemo(() => {
        let latest = null;
        Object.values(serverStates).forEach((s) => {
            if (s.lastUpdated && (!latest || s.lastUpdated > latest))
                latest = s.lastUpdated;
        });
        return latest;
    }, [serverStates]);

    // Tick for elapsed time display (only active when stale/dead)
    const [, setElapsedTick] = useState(0);
    useEffect(() => {
        if (!isStale && !isDead) return;
        const id = setInterval(() => setElapsedTick((v) => v + 1), 10_000);
        return () => clearInterval(id);
    }, [isStale, isDead]);

    /* ── render: main card ───────────────────────────────────────── */
    return (
        <div className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4 title={title}>{title}</h4>
                        {isDead && (
                            <span className='status-pill dead'>
                                <span className='status-dot' />
                                DEAD
                            </span>
                        )}
                        {!isDead && isStale && (
                            <span className='status-pill stale'>
                                <span className='status-dot' />
                                STALE
                            </span>
                        )}
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={fetchAllServers}
                                title='새로고침'
                            >
                                <IconRefresh size={14} />
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={openSettings}
                                title='설정'
                            >
                                <IconSettings size={14} />
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn remove'
                                onClick={onRemove}
                                title='제거'
                            >
                                <IconClose size={14} />
                            </button>
                        </div>
                    </div>
                    <div className='api-endpoint-row'>
                        <div className='api-endpoint-info'>
                            {servers.length === 0 ? (
                                <span className='api-endpoint'>서버 미설정</span>
                            ) : (
                                <>
                                    {statusCounts.ok > 0 && (
                                        <span className='status-badge ok'>
                                            {statusCounts.ok} OK
                                        </span>
                                    )}
                                    {statusCounts.ng > 0 && (
                                        <span className='status-badge ng'>
                                            {statusCounts.ng} NG
                                        </span>
                                    )}
                                    {statusCounts.ok === 0 &&
                                        statusCounts.ng === 0 && (
                                            <span className='api-endpoint'>
                                                {servers.length}개 서버
                                            </span>
                                        )}
                                </>
                            )}
                        </div>
                        <span className='refresh-interval-chip'>
                            ⏱ {formatInterval(refreshIntervalSec ?? 30)}
                        </span>
                        {lastUpdated && (
                            <span
                                className={`last-updated-time${isStale || isDead ? " stale" : ""}`}
                                title={formatTime(lastUpdated)}
                            >
                                {isStale || isDead
                                    ? formatElapsed(lastUpdated)
                                    : formatTime(lastUpdated)}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <ServerResourceSettingsModal
                open={showSettings}
                title={title}
                onClose={() => setShowSettings(false)}
                titleDraft={titleDraft}
                onTitleDraftChange={setTitleDraft}
                onTitleApply={handleTitleApply}
                sizeDraft={sizeDraft}
                sizeBounds={sizeBounds}
                onSizeDraftChange={setSizeDraft}
                onSizeApply={handleSizeApply}
                intervalDraft={intervalDraft}
                onIntervalDraftChange={setIntervalDraft}
                onIntervalApply={handleIntervalApply}
                selectedTargetIds={selectedTargetIdsDraft}
                onSelectedTargetIdsChange={setSelectedTargetIdsDraft}
                onSave={handleSaveTargets}
            />
            {detailServer && (
                <ServerDetailPopup
                    server={detailServer}
                    history={detailHistory}
                    onClose={() => setDetailServerId(null)}
                />
            )}

            <div className='api-card-content'>
                {servers.length === 0 ? (
                    <div className='resource-setup-prompt'>
                        <p>서버 접속 정보를 설정해주세요.</p>
                        <button
                            type='button'
                            className='size-preset-btn'
                            onClick={openSettings}
                        >
                            설정 열기
                        </button>
                    </div>
                ) : (
                    <div
                        className={`srv-list srv-list-${displayMode}`}
                        ref={scrollRef}
                    >
                        {displayServers.map((srv) => (
                            <ServerRow
                                key={srv.id}
                                server={srv}
                                data={serverStates[srv.id]?.data}
                                loading={
                                    serverStates[srv.id]?.loading !== false &&
                                    !serverStates[srv.id]?.data
                                }
                                error={serverStates[srv.id]?.error}
                                displayMode={displayMode}
                                violations={violationsMap[srv.id]}
                                diskCycleIdx={diskCycleIdx}
                                onDoubleClick={() => setDetailServerId(srv.id)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ServerResourceCard;

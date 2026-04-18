import {
    useEffect,
    useState,
    useRef,
    useCallback,
    useMemo,
} from "react";
import apiClient from "../services/http.js";
import { MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC } from "../pages/dashboardConstants";
import {
    DEFAULT_CRITERIA,
    MAX_HISTORY,
    MAX_SERVERS,
    checkCriteria,
    clamp,
    formatElapsed,
    formatInterval,
    formatTime,
    generateId,
    incrementLabel,
    migrateServers,
} from "./serverResourceHelpers";
import ServerRow from "./ServerRow";
import ServerDetailPopup from "./ServerDetailPopup";
import ServerResourceSettingsModal from "./ServerResourceSettingsModal";
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
    /* ── derived: servers list (migrate old format) ──────────────── */
    const servers = useMemo(() => migrateServers(widgetConfig), [widgetConfig]);

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
    }, []);

    // stable key for detecting server list changes
    const serversKey = useMemo(
        () => servers.map((s) => `${s.id}|${s.host}|${s.osType}`).join(","),
        [servers],
    );

    useEffect(() => {
        if (servers.length > 0) fetchAllServers();
    }, [serversKey, fetchAllServers]);

    useEffect(() => {
        if (servers.length === 0) return;
        const ms = (refreshIntervalSec ?? 30) * 1000;
        timerRef.current = setInterval(fetchAllServers, ms);
        return () => clearInterval(timerRef.current);
    }, [serversKey, refreshIntervalSec, fetchAllServers]);

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

    /* ── settings modal state ────────────────────────────────────── */
    const [showSettings, setShowSettings] = useState(false);
    const hasAutoOpened = useRef(false);

    useEffect(() => {
        if (!hasAutoOpened.current && servers.length === 0) {
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
    const [serversDraft, setServersDraft] = useState([]);
    const [expandedId, setExpandedId] = useState(null);

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
        setServersDraft(
            servers.map((s) => ({
                ...s,
                criteria: { ...DEFAULT_CRITERIA, ...s.criteria },
            })),
        );
        setExpandedId(null);
        setShowSettings(true);
    }, [servers]);

    /* ── settings handlers ───────────────────────────────────────── */
    const handleSizeApply = () => {
        const w = clamp(
            sizeDraft.w,
            sizeBounds?.minW ?? 2,
            sizeBounds?.maxW ?? 12,
            currentSize?.w ?? 4,
        );
        const h = clamp(
            sizeDraft.h,
            sizeBounds?.minH ?? 2,
            sizeBounds?.maxH ?? 24,
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

    const handleAddServer = () => {
        if (serversDraft.length >= MAX_SERVERS) {
            window.alert(`최대 ${MAX_SERVERS}개까지 등록할 수 있습니다.`);
            return;
        }
        const last = serversDraft[serversDraft.length - 1];
        const defaultOsType = last?.osType || "linux-rhel8";
        const defaultPort = defaultOsType === "windows-winrm" ? "5985" : "22";
        const newSrv = {
            id: generateId(),
            label: "",
            osType: defaultOsType,
            host: "",
            username: last?.username || "",
            password: last?.password || "",
            domain: last?.domain || "",
            port: last?.port || defaultPort,
            transport: last?.transport || "",
            criteria: { ...DEFAULT_CRITERIA },
        };
        setServersDraft((p) => [...p, newSrv]);
        setExpandedId(newSrv.id);
    };

    const handleDuplicateServer = (srv) => {
        if (serversDraft.length >= MAX_SERVERS) {
            window.alert(`최대 ${MAX_SERVERS}개까지 등록할 수 있습니다.`);
            return;
        }
        const dup = {
            ...srv,
            id: generateId(),
            label: incrementLabel(srv.label),
            criteria: { ...srv.criteria },
            domain: srv.domain || "",
        };
        setServersDraft((p) => [...p, dup]);
        setExpandedId(dup.id);
    };

    const handleRemoveServer = (id) => {
        setServersDraft((p) => p.filter((s) => s.id !== id));
        if (expandedId === id) setExpandedId(null);
    };

    const handleUpdateServerField = (id, field, value) => {
        setServersDraft((p) =>
            p.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
        );
    };

    const handleSaveServers = () => {
        onWidgetConfigChange?.({ servers: serversDraft });
        setShowSettings(false);
    };

    const handleToggleExpanded = (id) => {
        setExpandedId(expandedId === id ? null : id);
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
                                ⟳
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={openSettings}
                                title='설정'
                            >
                                ⚙
                            </button>
                            <button
                                type='button'
                                className='compact-icon-btn remove'
                                onClick={onRemove}
                                title='제거'
                            >
                                ✕
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

            {showSettings && (
                <ServerResourceSettingsModal
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
                    serversDraft={serversDraft}
                    expandedId={expandedId}
                    onToggleExpanded={handleToggleExpanded}
                    onAddServer={handleAddServer}
                    onDuplicateServer={handleDuplicateServer}
                    onRemoveServer={handleRemoveServer}
                    onUpdateServerField={handleUpdateServerField}
                    onSave={handleSaveServers}
                />
            )}
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
                    <div className={`srv-list srv-list-${displayMode}`}>
                        {servers.map((srv) => (
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

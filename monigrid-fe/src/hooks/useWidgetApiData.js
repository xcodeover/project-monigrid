/**
 * useWidgetApiData (SRP): manages per-widget polling with de-duplication and
 * auto-rescheduling. Supports table, health-check, and status-list widget types.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import {
    dataService,
    healthService,
    monitorService,
} from "../services/dashboardService.js";
import { formatErrorMessage } from "../services/http.js";
import { getEnabledCriteriaColumns } from "../utils/helpers.js";

// Convert monitor-snapshot rows (BE-collected) into the shape StatusListCard
// already understands ({items, okCount, failCount}). Mirrors the wire format
// produced by the legacy `/health-check-proxy-batch` route so the card itself
// doesn't need to learn about monitor targets.
const transformMonitorSnapshotToStatusList = (snapshotResponse) => {
    const rawItems = Array.isArray(snapshotResponse?.items)
        ? snapshotResponse.items
        : [];
    const items = rawItems.map((entry) => {
        const probe = entry?.data || {};
        const ok = probe?.ok === true;
        const url = entry?.spec?.url || "";
        const error =
            entry?.errorMessage ||
            probe?.error ||
            (ok
                ? null
                : probe?.httpStatus
                  ? `HTTP ${probe.httpStatus}`
                  : "수집 결과 없음");
        return {
            id: entry?.targetId || url,
            label: entry?.label || url || entry?.targetId,
            url,
            ok,
            httpStatus: probe?.httpStatus ?? null,
            responseTimeMs: probe?.responseTimeMs ?? null,
            checkedAt: entry?.updatedAt || null,
            body: probe?.body ?? null,
            error,
        };
    });
    const okCount = items.filter((i) => i.ok).length;
    return {
        items,
        okCount,
        failCount: items.length - okCount,
        checkedAt: new Date().toISOString(),
    };
};

const clampIntervalSec = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(3600, Math.max(1, Math.floor(n))) : 5;
};

const resolveWidgetType = (widget) => {
    if (widget?.type === "health-check") return "health-check";
    if (widget?.type === "status-list") return "status-list";
    return "table";
};

/**
 * criteria 기반 알람이 활성화된 테이블 위젯인지 판정.
 * 활성화된 경우 백엔드 캐시를 우회(?fresh=1)해 실시간 상태로 알람을 평가해야 한다.
 */
const widgetNeedsFreshData = (widget) => {
    if (resolveWidgetType(widget) !== "table") return false;
    const criteria = widget?.tableSettings?.criteria;
    if (!criteria) return false;
    return getEnabledCriteriaColumns(criteria).length > 0;
};

// Stable string hash (mulberry-ish, FNV-1a in spirit). Used to compute a
// deterministic per-widget phase shift so 30 widgets sharing a 5s interval
// don't all fire on the same tick — that "thundering herd" filled the
// browser's per-host connection budget (6) and queued the tail behind it,
// stretching tail latency past the next interval and tripping in-flight
// guards. Deterministic (vs Math.random) keeps phases stable across reloads.
const stringHash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
};

// Spread starts across 30% of the interval (capped at 1.5s so the user's
// first paint isn't visibly delayed for long-interval widgets).
const computeStartDelayMs = (widgetId, intervalSec) => {
    const windowMs = Math.min(1500, Math.floor(intervalSec * 300));
    if (windowMs <= 0) return 0;
    return stringHash(String(widgetId || "")) % windowMs;
};

const scheduleKeyFor = (widget) => {
    const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
    // status-list now keys on the registered http_status target id list — the
    // widget pulls a BE-collected snapshot, so re-key whenever the operator
    // adds/removes a target from this widget.
    const target =
        resolveWidgetType(widget) === "status-list"
            ? JSON.stringify(
                  Array.isArray(widget.targetIds) ? widget.targetIds : [],
              )
            : widget.endpoint;
    // fresh 모드 토글도 키에 포함 — 알람 criteria가 켜지거나 꺼지면 즉시 재스케줄
    const freshFlag = widgetNeedsFreshData(widget) ? "fresh" : "cached";
    return `${target}::${intervalSec}::${freshFlag}`;
};

const useWidgetApiData = (widgets) => {
    const [results, setResults] = useState({});
    const [loadingMap, setLoadingMap] = useState({});
    const [refreshingMap, setRefreshingMap] = useState({});

    const timersRef = useRef({});
    const scheduleKeyRef = useRef({});
    const inFlightRef = useRef({});
    // Per-widget AbortController so that widget removal / hook unmount
    // doesn't leave dead requests downloading the body and parsing JSON
    // (which still happens after epoch guards drop the result).
    const controllersRef = useRef({});
    const widgetsRef = useRef(widgets);
    const resultsRef = useRef(results);

    useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
    useEffect(() => { resultsRef.current = results; }, [results]);

    const fetchWidget = useCallback(async (widget) => {
        const widgetId = widget.id;
        const widgetType = resolveWidgetType(widget);
        const hasTarget =
            widgetType === "status-list"
                ? Array.isArray(widget.targetIds) && widget.targetIds.length > 0
                : Boolean(widget.endpoint);

        if (!widgetId || !hasTarget) return;

        if (inFlightRef.current[widgetId]) {
            return inFlightRef.current[widgetId];
        }

        const controller = new AbortController();
        controllersRef.current[widgetId] = controller;
        const signal = controller.signal;

        const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
        const requestStartedAt = Date.now();
        const hasPreviousData = resultsRef.current[widgetId]?.data != null;

        if (hasPreviousData) {
            setRefreshingMap((prev) => ({ ...prev, [widgetId]: true }));
        } else {
            setLoadingMap((prev) => ({ ...prev, [widgetId]: true }));
        }

        const fetchPromise = (() => {
            if (widgetType === "health-check") {
                return healthService.checkEndpointHealth(widget.endpoint, { signal });
            }
            if (widgetType === "status-list") {
                // Hit the BE-shared monitor-snapshot cache instead of the
                // per-request proxy fan-out. Multiple users staring at the
                // same dashboard now share one collector per target.
                return monitorService
                    .getSnapshot(widget.targetIds, { signal })
                    .then(transformMonitorSnapshotToStatusList);
            }
            return dataService.getApiData(widgetId, widget.endpoint, {
                fresh: widgetNeedsFreshData(widget),
                signal,
            });
        })()
            .then((data) => {
                if (widgetType === "health-check") {
                    const isLive = data?.ok === true;
                    setResults((prev) => ({
                        ...prev,
                        [widgetId]: {
                            id: widgetId,
                            data,
                            status: isLive ? "live" : "dead",
                            error: isLive ? null : `HTTP ${data?.httpStatus ?? "unknown"}`,
                            lastUpdatedAt: Date.now(),
                        },
                    }));
                    return;
                }

                if (widgetType === "status-list") {
                    const failCount = Number(data?.failCount || 0);
                    const okCount = Number(data?.okCount || 0);
                    const status = failCount === 0 ? "live" : okCount > 0 ? "slow-live" : "dead";
                    setResults((prev) => ({
                        ...prev,
                        [widgetId]: {
                            id: widgetId,
                            data,
                            status,
                            error: null,
                            lastUpdatedAt: Date.now(),
                        },
                    }));
                    return;
                }

                const elapsed = Date.now() - requestStartedAt;
                setResults((prev) => ({
                    ...prev,
                    [widgetId]: {
                        id: widgetId,
                        data,
                        status: elapsed > intervalSec * 1000 ? "slow-live" : "live",
                        error: null,
                        lastUpdatedAt: Date.now(),
                    },
                }));
            })
            .catch((error) => {
                // AbortController-driven cancellations: keep the previous
                // result and just clear the in-flight slot. Surfacing
                // "Request aborted" as a widget error would flash the
                // alarm UI on every widget removal.
                if (signal.aborted || error?.name === "CanceledError" || error?.code === "ERR_CANCELED") {
                    return;
                }
                setResults((prev) => ({
                    ...prev,
                    [widgetId]: {
                        id: widgetId,
                        data: null,
                        status: "dead",
                        error: formatErrorMessage(error),
                        lastUpdatedAt: prev[widgetId]?.lastUpdatedAt ?? null,
                    },
                }));
            })
            .finally(() => {
                setLoadingMap((prev) => ({ ...prev, [widgetId]: false }));
                setRefreshingMap((prev) => ({ ...prev, [widgetId]: false }));
                delete inFlightRef.current[widgetId];
                if (controllersRef.current[widgetId] === controller) {
                    delete controllersRef.current[widgetId];
                }
            });

        inFlightRef.current[widgetId] = fetchPromise;
        return fetchPromise;
    }, []);

    useEffect(() => {
        const widgetIds = new Set(widgets.map((w) => w.id));

        // Clean up removed widgets only
        Object.keys(timersRef.current).forEach((widgetId) => {
            if (!widgetIds.has(widgetId)) {
                clearInterval(timersRef.current[widgetId]);
                delete timersRef.current[widgetId];
                delete scheduleKeyRef.current[widgetId];
                delete inFlightRef.current[widgetId];
                const controller = controllersRef.current[widgetId];
                if (controller) {
                    controller.abort();
                    delete controllersRef.current[widgetId];
                }
            }
        });

        // Schedule or re-schedule each widget
        widgets.forEach((widget) => {
            const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
            const key = scheduleKeyFor(widget);

            if (scheduleKeyRef.current[widget.id] === key) {
                if (!resultsRef.current[widget.id]) fetchWidget(widget);
                return;
            }

            if (timersRef.current[widget.id]) {
                clearInterval(timersRef.current[widget.id]);
            }

            scheduleKeyRef.current[widget.id] = key;
            // Resolve the widget from widgetsRef on every tick instead of
            // capturing it in the closure: a setting edit (criteria, table
            // formatting, etc.) won't change the schedule key but still
            // needs to be visible on the next fetch — a captured `widget`
            // would keep the old settings until the user toggles something
            // that does invalidate the schedule key.
            const widgetId = widget.id;
            const startDelay = computeStartDelayMs(widgetId, intervalSec);
            const tick = () => {
                const latest = widgetsRef.current.find((w) => w.id === widgetId);
                if (latest) fetchWidget(latest);
            };
            // Phase the first fetch via setTimeout, then start the interval
            // from that offset so subsequent ticks inherit the per-widget
            // phase. clearInterval/clearTimeout share an ID space in
            // browsers, so the cleanup paths can clear either kind safely.
            timersRef.current[widgetId] = setTimeout(() => {
                tick();
                timersRef.current[widgetId] = setInterval(tick, intervalSec * 1000);
            }, startDelay);
        });

        // Only clean up all timers on full unmount (not on every widgets change)
    }, [widgets, fetchWidget]);

    // Unmount-only cleanup
    useEffect(() => {
        return () => {
            Object.values(timersRef.current).forEach(clearInterval);
            Object.values(controllersRef.current).forEach((c) => {
                try { c.abort(); } catch { /* ignore */ }
            });
            timersRef.current = {};
            scheduleKeyRef.current = {};
            inFlightRef.current = {};
            controllersRef.current = {};
        };
    }, []);

    const refetchAll = useCallback(
        () => Promise.all(widgetsRef.current.map((w) => fetchWidget(w))),
        [fetchWidget],
    );

    const refetchOne = useCallback(
        (widgetId) => {
            const widget = widgetsRef.current.find((w) => w.id === widgetId);
            return widget ? fetchWidget(widget) : Promise.resolve();
        },
        [fetchWidget],
    );

    return { results, loadingMap, refreshingMap, refetchAll, refetchOne };
};

export default useWidgetApiData;

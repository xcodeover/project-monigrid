/**
 * useWidgetApiData (SRP): manages per-widget polling with de-duplication and
 * auto-rescheduling. Supports table, health-check, and status-list widget types.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { dataService, healthService } from "../services/dashboardService.js";
import { formatErrorMessage } from "../services/http.js";
import { getEnabledCriteriaColumns } from "../utils/helpers.js";

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

const scheduleKeyFor = (widget) => {
    const intervalSec = clampIntervalSec(widget.refreshIntervalSec ?? 5);
    const target =
        resolveWidgetType(widget) === "status-list"
            ? JSON.stringify(widget.endpoints || [])
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
    const widgetsRef = useRef(widgets);
    const resultsRef = useRef(results);

    useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
    useEffect(() => { resultsRef.current = results; }, [results]);

    const fetchWidget = useCallback(async (widget) => {
        const widgetId = widget.id;
        const widgetType = resolveWidgetType(widget);
        const hasTarget =
            widgetType === "status-list"
                ? Array.isArray(widget.endpoints) && widget.endpoints.length > 0
                : Boolean(widget.endpoint);

        if (!widgetId || !hasTarget) return;

        if (inFlightRef.current[widgetId]) {
            return inFlightRef.current[widgetId];
        }

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
                return healthService.checkEndpointHealth(widget.endpoint);
            }
            if (widgetType === "status-list") {
                return healthService.checkMultipleEndpointsHealth(widget.endpoints);
            }
            return dataService.getApiData(widgetId, widget.endpoint, {
                fresh: widgetNeedsFreshData(widget),
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
            fetchWidget(widget);
            timersRef.current[widget.id] = setInterval(() => fetchWidget(widget), intervalSec * 1000);
        });

        // Only clean up all timers on full unmount (not on every widgets change)
    }, [widgets, fetchWidget]);

    // Unmount-only cleanup
    useEffect(() => {
        return () => {
            Object.values(timersRef.current).forEach(clearInterval);
            timersRef.current = {};
            scheduleKeyRef.current = {};
            inFlightRef.current = {};
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

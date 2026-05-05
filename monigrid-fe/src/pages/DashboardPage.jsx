import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { WidthProvider, Responsive } from "react-grid-layout/legacy";
import { useNavigate } from "react-router-dom";
import { useWidgetApiData } from "../hooks/useApi";
import {
    dashboardService,
    getRememberedApiBaseUrl,
    normalizeUserEndpoint,
    rememberApiBaseUrl,
    resolveEndpointWithBase,
} from "../services/api";
import { monitorService, titleService } from "../services/dashboardService";
import { API_BASE_URL as BUILDTIME_API_BASE_URL } from "../services/http";
import {
    countRowsMatchingCriteria,
    getEnabledCriteriaColumns,
    normalizeToArray,
} from "../utils/helpers";
import { hasThresholdViolation } from "../utils/chartThresholds.js";
import { useDashboardStore } from "../store/dashboardStore";
import { useAuthStore } from "../store/authStore";
import { useAlarmStore } from "../store/alarmStore";
import AlarmBanner from "../components/AlarmBanner";
// prismjs + react-simple-code-editor are heavy — defer until modal is opened
const SqlEditorModal = lazy(() => import("../components/SqlEditorModal"));
const ConfigEditorModal = lazy(() => import("../components/ConfigEditorModal"));
import BackendConfigPasswordPrompt from "../components/BackendConfigPasswordPrompt";
import DashboardHeader from "./DashboardHeader";
import AddApiModal from "./AddApiModal";
import DashboardSettingsModal from "./DashboardSettingsModal";
import WidgetRenderer from "./WidgetRenderer";
import {
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_FONT_SIZE,
    DEFAULT_WIDGET_LAYOUT,
    GRID_COLUMNS,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    WIDGET_TYPE_NETWORK_TEST,
    WIDGET_TYPE_SERVER_RESOURCE,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants";
import {
    clampValue,
    createDefaultApis,
    createStatusListWidget,
    layoutArrayToMap,
    normalizeWidgetLayout,
} from "./dashboardHelpers";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./DashboardPage.css";

const ResponsiveGridLayout = WidthProvider(Responsive);

const COMPANY_NAME =
    import.meta.env.VITE_COMPANY_NAME || "Monitoring Dashboard";
const CURRENT_YEAR = new Date().getFullYear();
// Build-time title fallback — used when no KV override is set by admin.
// LoginPage intentionally keeps its own copy (unauthenticated, no KV access).
const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Monitoring Dashboard";
// 빌드 시점 기본 URL 해석은 services/http.js에 일원화되어 있다.
// (VITE_API_URL이 명시적 빈 문자열이면 same-origin 모드 → window.location.origin)
// localStorage에 저장된 값이 있으면 그것을 우선한다.
const API_BASE_URL = getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;

const DEFAULT_APIS = createDefaultApis(API_BASE_URL);

const DashboardPage = () => {
    const navigate = useNavigate();
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);
    const widgets = useDashboardStore((state) => state.widgets);
    const layouts = useDashboardStore((state) => state.layouts);
    const setWidgets = useDashboardStore((state) => state.setWidgets);
    const addWidget = useDashboardStore((state) => state.addWidget);
    const removeWidget = useDashboardStore((state) => state.removeWidget);
    const updateWidget = useDashboardStore((state) => state.updateWidget);
    const saveLayout = useDashboardStore((state) => state.saveLayout);
    const saveLayouts = useDashboardStore((state) => state.saveLayouts);
    const dashboardSettings = useDashboardStore(
        (state) => state.dashboardSettings,
    );
    const setDashboardSettings = useDashboardStore(
        (state) => state.setDashboardSettings,
    );
    const exportDashboardConfig = useDashboardStore(
        (state) => state.exportDashboardConfig,
    );
    const importDashboardConfig = useDashboardStore(
        (state) => state.importDashboardConfig,
    );
    const syncPreferencesFromServer = useDashboardStore(
        (state) => state.syncPreferencesFromServer,
    );
    const disableServerSync = useDashboardStore(
        (state) => state.disableServerSync,
    );
    const flushPendingPush = useDashboardStore(
        (state) => state.flushPendingPush,
    );

    // 빌드 시점 기본값 해석은 services/http.js에 일원화 (same-origin 모드 포함)
    const rememberedApiBaseUrl =
        getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;

    const [showAddApi, setShowAddApi] = useState(false);
    const [showDashboardSettings, setShowDashboardSettings] = useState(false);
    const [showSqlEditor, setShowSqlEditor] = useState(false);
    const [showConfigEditor, setShowConfigEditor] = useState(false);
    const [showConfigPasswordPrompt, setShowConfigPasswordPrompt] = useState(false);
    const [newApiForm, setNewApiForm] = useState({
        title: "",
        endpoint: "",
        type: WIDGET_TYPE_TABLE,
        targetIds: [],
    });
    const [monitorTargets, setMonitorTargets] = useState([]);
    const [monitorTargetsError, setMonitorTargetsError] = useState(null);
    const [fontSizeDraft, setFontSizeDraft] = useState(
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );
    const [configJsonDraft, setConfigJsonDraft] = useState("");
    const [configErrorMessage, setConfigErrorMessage] = useState("");
    const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState(rememberedApiBaseUrl);
    const [apiBaseUrlSaved, setApiBaseUrlSaved] = useState(false);
    const [backendVersion, setBackendVersion] = useState(null);
    const [dashboardTitle, setDashboardTitle] = useState("");
    const [dashboardTitleDraft, setDashboardTitleDraft] = useState("");
    const [isFullscreen, setIsFullscreen] = useState(
        () => typeof document !== "undefined" && !!document.fullscreenElement,
    );

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullscreenChange,
            );
        };
    }, []);

    // AddApiModal 이 열릴 때 모니터 대상 목록을 로드해 둔다.
    // 서버 리소스/네트워크 위젯은 이 목록에서 골라서만 추가할 수 있다.
    useEffect(() => {
        if (!showAddApi) return;
        let cancelled = false;
        (async () => {
            try {
                const data = await monitorService.listTargets();
                if (cancelled) return;
                setMonitorTargets(Array.isArray(data?.targets) ? data.targets : []);
                setMonitorTargetsError(null);
            } catch (err) {
                if (cancelled) return;
                setMonitorTargets([]);
                setMonitorTargetsError(
                    err?.response?.data?.message ||
                        err?.message ||
                        "모니터 대상을 불러올 수 없습니다.",
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [showAddApi]);

    const handleToggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(() => {});
        } else {
            document.exitFullscreen?.().catch(() => {});
        }
    };

    useEffect(() => {
        let cancelled = false;
        const fetchBackendVersion = async () => {
            try {
                // /dashboard/health (authenticated) instead of /health
                // (public liveness probe). The latter intentionally no
                // longer leaks the deployed build version.
                const res = await dashboardService.getApiData(null, "/dashboard/health");
                if (cancelled) return;
                if (res?.version) setBackendVersion(res.version);
                // dashboardTitle: empty string → FE falls back to APP_TITLE
                const kvTitle = res?.dashboardTitle ?? "";
                setDashboardTitle(kvTitle);
                setDashboardTitleDraft(kvTitle);
            } catch {
                /* ignore */
            }
        };
        fetchBackendVersion();
        return () => {
            cancelled = true;
        };
    }, []);

    // Sync browser tab title whenever the KV-driven title changes
    useEffect(() => {
        document.title = dashboardTitle || APP_TITLE;
    }, [dashboardTitle]);

    useEffect(() => {
        setFontSizeDraft(
            dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
        );
    }, [dashboardSettings?.widgetFontSize]);

    // Hydrate the store with server-side preferences once per session
    // (keyed by username so switching users re-fetches).
    //
    // buildDefaults is passed so that the store can seed the initial widget set
    // INSIDE the sync window when both localStorage and the BE have no record
    // (new PC, first login). Doing the seed here — outside the sync — would
    // race the async GET: setWidgets() triggers queueServerPush() which sets
    // _dirtyDuringSync=true, causing the local-wins branch to discard BE prefs
    // and push empty defaults back to the server.
    //
    // ⚠ WARNING: 이 effect 와 sync 응답 사이에 setWidgets/setLayouts 같은
    // store mutating effect 를 추가하면 위 race 가 재발한다 (issue #4 재현).
    // 새 effect 는 반드시 syncPreferencesFromServer 의 .then() 안에서 실행하거나,
    // store 의 _syncInFlight=false 확인 후 실행할 것.
    useEffect(() => {
        if (!user?.username) return;
        const buildDefaults = () => {
            const statusListWidget = createStatusListWidget();
            const defaultWidgets = [...DEFAULT_APIS, statusListWidget];
            const defaultLayouts = Object.fromEntries(
                defaultWidgets
                    .filter((w) => w.defaultLayout)
                    .map((w) => [w.id, w.defaultLayout]),
            );
            return { widgets: defaultWidgets, layouts: defaultLayouts };
        };
        syncPreferencesFromServer(buildDefaults);
    }, [user?.username, syncPreferencesFromServer]);

    const dashboardWidgets = widgets ?? DEFAULT_APIS;
    const isAdmin =
        user?.role === "admin" ||
        String(user?.username || "")
            .trim()
            .toLowerCase() === "admin";

    const reportWidgetStatus = useAlarmStore(
        (state) => state.reportWidgetStatus,
    );
    const alarmedWidgets = useAlarmStore((state) => state.alarmedWidgets);
    const alarmSound = useAlarmStore((state) => state.alarmSound);
    const setAlarmSound = useAlarmStore((state) => state.setAlarmSound);
    const soundEnabled = useAlarmStore((state) => state.soundEnabled);
    const setSoundEnabled = useAlarmStore((state) => state.setSoundEnabled);

    const { results, loadingMap, refreshingMap, refetchAll, refetchOne } =
        useWidgetApiData(dashboardWidgets);

    // Report alarm status via useEffect (must NOT be called during render)
    // Includes criteria-based alerts: if a table widget has alertCount > 0, treat as alarm
    useEffect(() => {
        dashboardWidgets.forEach((widget) => {
            // Skip widgets that manage their own alarm via onAlarmChange
            if (
                widget.type === WIDGET_TYPE_SERVER_RESOURCE ||
                widget.type === WIDGET_TYPE_NETWORK_TEST
            )
                return;

            const status = results[widget.id]?.status ?? "loading";
            // dead: 완전 실패 / slow-live: status-list에서 일부 NG → 둘 다 alarm 발생
            let alarmStatus =
                status === "dead" || status === "slow-live" ? "dead" : status;

            // Check criteria-based alerts for table widgets
            if (
                alarmStatus !== "dead" &&
                widget.type === "table" &&
                widget.tableSettings?.criteria
            ) {
                const criteriaMap = widget.tableSettings.criteria;
                const enabledCols = getEnabledCriteriaColumns(criteriaMap);
                if (enabledCols.length > 0) {
                    const data = results[widget.id]?.data;
                    if (data) {
                        const rows = normalizeToArray(data);
                        const alertCount = countRowsMatchingCriteria(
                            rows,
                            criteriaMap,
                        );
                        if (alertCount > 0) {
                            alarmStatus = "dead";
                        }
                    }
                }
            }

            // Threshold-based alarms for chart widgets (line-chart / bar-chart).
            // A violation on ANY row of ANY enabled threshold raises the alarm.
            if (
                alarmStatus !== "dead" &&
                (widget.type === "line-chart" ||
                    widget.type === "bar-chart") &&
                Array.isArray(widget.chartSettings?.thresholds) &&
                widget.chartSettings.thresholds.length > 0
            ) {
                const data = results[widget.id]?.data;
                if (data) {
                    const rows = normalizeToArray(data);
                    if (
                        hasThresholdViolation(
                            rows,
                            widget.chartSettings.thresholds,
                        )
                    ) {
                        alarmStatus = "dead";
                    }
                }
            }

            reportWidgetStatus(widget.id, alarmStatus);
        });
    }, [results, dashboardWidgets, reportWidgetStatus]);

    // Memoised so the responsiveLayouts object below stays stable across
    // re-renders that don't touch the widget set or saved layout map (the
    // common case — polling results updating). `layouts` only changes
    // when the user finishes a drag/resize (onDragStop/onResizeStop), so
    // the dep array hits in steady state.
    const gridLayout = useMemo(
        () => dashboardWidgets.map((widget) =>
            normalizeWidgetLayout(widget, layouts[widget.id]),
        ),
        [dashboardWidgets, layouts],
    );

    // ResponsiveGridLayout does shallow-equals on `layouts`; rebuilding the
    // {lg, md, sm, xs, xxs} object every render forced an internal layout
    // recomputation against 30+ children even when nothing visible changed.
    const responsiveLayouts = useMemo(
        () => ({
            lg: gridLayout,
            md: gridLayout,
            sm: gridLayout,
            xs: gridLayout,
            xxs: gridLayout,
        }),
        [gridLayout],
    );

    const handleLogout = () => {
        disableServerSync();
        logout();
        navigate("/login");
    };

    const handleRemoveApi = (apiId) => {
        reportWidgetStatus(apiId, "live");
        removeWidget(apiId);
    };

    const handleAddApi = () => {
        if (!newApiForm.title.trim()) {
            return;
        }

        const isStatusListWidget = newApiForm.type === WIDGET_TYPE_STATUS_LIST;
        const isNetworkTestWidget = newApiForm.type === WIDGET_TYPE_NETWORK_TEST;
        const isServerResourceWidget =
            newApiForm.type === WIDGET_TYPE_SERVER_RESOURCE;
        const needsEndpoint =
            !isStatusListWidget && !isNetworkTestWidget && !isServerResourceWidget;
        if (needsEndpoint && !newApiForm.endpoint.trim()) {
            return;
        }

        // 모니터 대상에 의존하는 위젯은 등록된 대상을 1개 이상 선택해야 한다.
        // (status-list 도 이제 http_status 모니터 대상에서 골라 추가하는 구조다.)
        const selectedTargetIds = Array.isArray(newApiForm.targetIds)
            ? newApiForm.targetIds.filter(Boolean)
            : [];
        if (
            (isServerResourceWidget ||
                isNetworkTestWidget ||
                isStatusListWidget) &&
            selectedTargetIds.length === 0
        ) {
            return;
        }

        // Date.now() alone collides on rapid double-click — append a small
        // random tail to keep ids unique within the same millisecond.
        const widgetId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const nextLayout = {
            ...DEFAULT_WIDGET_LAYOUT,
            y: dashboardWidgets.length * 4,
        };
        const isChartType =
            newApiForm.type === "line-chart" ||
            newApiForm.type === "bar-chart";
        const newWidget = {
            id: widgetId,
            type: newApiForm.type,
            title: newApiForm.title.trim(),
            endpoint: needsEndpoint
                ? normalizeUserEndpoint(
                      newApiForm.endpoint.trim(),
                      rememberedApiBaseUrl,
                  )
                : undefined,
            defaultLayout: nextLayout,
            refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
            // status-list 위젯은 등록된 http_status 모니터 대상 id 목록을 보유한다.
            // (BE 가 주기적으로 폴링한 결과를 monitor-snapshot 으로 가져온다.)
            targetIds: isStatusListWidget ? selectedTargetIds : undefined,
            tableSettings:
                newApiForm.type === WIDGET_TYPE_TABLE
                    ? { visibleColumns: [], columnWidths: {}, criteria: {} }
                    : undefined,
            chartSettings: isChartType
                ? {
                      xAxisKey: "",
                      yAxisKeys: [],
                      timeRange: "all",
                      orientation: "vertical",
                  }
                : undefined,
            serverConfig: isServerResourceWidget
                ? { targetIds: selectedTargetIds }
                : undefined,
            networkConfig: isNetworkTestWidget
                ? { targetIds: selectedTargetIds }
                : undefined,
        };

        addWidget(newWidget);
        saveLayout(widgetId, nextLayout);
        setNewApiForm({
            title: "",
            endpoint: "",
            type: WIDGET_TYPE_TABLE,
            targetIds: [],
        });
        setShowAddApi(false);
    };

    const handleWidgetMetaChange = (apiId, updates) => {
        const targetWidget = dashboardWidgets.find(
            (widget) => widget.id === apiId,
        );
        if (!targetWidget) {
            return;
        }

        const nextTitle = String(
            updates?.title ?? targetWidget.title ?? "",
        ).trim();
        if (!nextTitle) {
            return;
        }

        // Types that don't have an endpoint field — just update title
        if (
            targetWidget.type === WIDGET_TYPE_STATUS_LIST ||
            targetWidget.type === WIDGET_TYPE_NETWORK_TEST ||
            targetWidget.type === WIDGET_TYPE_SERVER_RESOURCE
        ) {
            updateWidget(apiId, { title: nextTitle });
            return;
        }

        const nextEndpoint = String(
            updates?.endpoint ?? targetWidget.endpoint ?? "",
        ).trim();
        if (!nextEndpoint) {
            return;
        }

        updateWidget(apiId, {
            title: nextTitle,
            endpoint: normalizeUserEndpoint(
                nextEndpoint,
                rememberedApiBaseUrl,
            ),
        });
    };

    const handleStatusListTargetIdsChange = (apiId, targetIds) => {
        const sanitized = Array.isArray(targetIds)
            ? targetIds.filter(Boolean)
            : [];
        updateWidget(apiId, { targetIds: sanitized });
    };

    const isBackendManagedEndpoint = (endpointValue) => {
        if (!endpointValue) {
            return false;
        }

        try {
            const targetUrl = new URL(
                resolveEndpointWithBase(endpointValue, rememberedApiBaseUrl),
            );
            const baseUrl = new URL(rememberedApiBaseUrl);
            return (
                targetUrl.origin === baseUrl.origin &&
                targetUrl.pathname.startsWith("/api/")
            );
        } catch {
            return false;
        }
    };

    const handleManualRefresh = async (widget) => {
        if (
            widget?.type !== WIDGET_TYPE_STATUS_LIST &&
            isBackendManagedEndpoint(widget?.endpoint)
        ) {
            try {
                await dashboardService.refreshEndpointCache({
                    endpoint: widget.endpoint,
                    resetConnection: true,
                });
            } catch (error) {
                console.warn(
                    "Cache refresh failed before manual widget refresh",
                    error,
                );
            }
        }

        await refetchOne(widget.id);
    };

    const handleLayoutCommit = (nextLayout) => {
        const nextLayoutMap = layoutArrayToMap(nextLayout, layouts);
        saveLayouts({ ...layouts, ...nextLayoutMap });
    };

    const handleWidgetSizeChange = (apiId, nextWidth, nextHeight) => {
        const currentLayout =
            layouts[apiId] ??
            gridLayout.find((item) => item.i === apiId) ??
            DEFAULT_WIDGET_LAYOUT;

        const width = clampValue(
            nextWidth,
            currentLayout.minW ?? MIN_WIDGET_W,
            MAX_WIDGET_W,
            currentLayout.w,
        );
        const height = clampValue(
            nextHeight,
            currentLayout.minH ?? MIN_WIDGET_H,
            MAX_WIDGET_H,
            currentLayout.h,
        );

        saveLayout(apiId, {
            ...currentLayout,
            w: width,
            h: height,
        });
    };

    const handleRefreshIntervalChange = (apiId, intervalSec) => {
        const normalizedInterval = clampValue(
            intervalSec,
            1,
            3600,
            DEFAULT_REFRESH_INTERVAL_SEC,
        );

        updateWidget(apiId, {
            refreshIntervalSec: normalizedInterval,
        });
    };

    const handleTableSettingsChange = (apiId, nextSettings) => {
        updateWidget(apiId, {
            tableSettings: nextSettings,
        });
    };

    const handleChartSettingsChange = (apiId, nextSettings) => {
        updateWidget(apiId, {
            chartSettings: nextSettings,
        });
    };

    const handleApplyDashboardSettings = () => {
        const normalizedFontSize = clampValue(
            fontSizeDraft,
            10,
            18,
            DEFAULT_WIDGET_FONT_SIZE,
        );
        setFontSizeDraft(normalizedFontSize);
        setDashboardSettings({
            widgetFontSize: normalizedFontSize,
        });
    };

    const handleApplyApiBaseUrl = async () => {
        const trimmed = apiBaseUrlDraft.trim().replace(/\/+$/, "");
        if (!trimmed) return;
        rememberApiBaseUrl(trimmed);
        setApiBaseUrlSaved(true);
        // Stop new debounced pushes from being scheduled, then flush whatever
        // is already in-flight so the user's most recent layout edits aren't
        // dropped by the impending page reload.
        try {
            disableServerSync();
            await flushPendingPush();
        } catch {
            // flushPendingPush already swallows network errors; reaching here
            // would mean a programming error — fall through and reload anyway
            // rather than trapping the user on the modal.
        }
        window.location.reload();
    };

    const handleExportConfig = () => {
        const exportedConfig = exportDashboardConfig();
        const prettyJson = JSON.stringify(exportedConfig, null, 2);
        setConfigJsonDraft(prettyJson);

        const blob = new Blob([prettyJson], { type: "application/json" });
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = `dashboard-config-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
    };

    const handleImportConfigFromText = () => {
        try {
            const parsed = JSON.parse(configJsonDraft);
            importDashboardConfig(parsed);
            setConfigErrorMessage("");
            setShowDashboardSettings(false);
        } catch (error) {
            setConfigErrorMessage(
                error instanceof Error
                    ? error.message
                    : "설정 JSON 파싱에 실패했습니다.",
            );
        }
    };

    const handleConfigFileChange = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result ?? "");
            setConfigJsonDraft(text);
        };
        reader.readAsText(file, "utf-8");
        event.target.value = "";
    };

    const handleApiBaseUrlDraftChange = (value) => {
        setApiBaseUrlDraft(value);
        setApiBaseUrlSaved(false);
    };

    const handleApplyDashboardTitle = async (newTitle) => {
        const trimmed = String(newTitle ?? "").trim();
        try {
            await titleService.setDashboardTitle(trimmed);
            setDashboardTitle(trimmed);
            setDashboardTitleDraft(trimmed);
        } catch (err) {
            console.error("대시보드 타이틀 저장 실패", err);
        }
    };

    const widgetFontSize =
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE;

    return (
        <div className='dashboard-page'>
            <DashboardHeader
                widgetCount={dashboardWidgets.length}
                user={user}
                isAdmin={isAdmin}
                isFullscreen={isFullscreen}
                dashboardTitle={dashboardTitle}
                onToggleFullscreen={handleToggleFullscreen}
                onOpenSettings={() => setShowDashboardSettings(true)}
                onOpenConfigEditor={() => setShowConfigPasswordPrompt(true)}
                onOpenAddApi={() => setShowAddApi(true)}
                onOpenSqlEditor={() => setShowSqlEditor(true)}
                onOpenUserManagement={() => navigate("/users")}
                onRefreshAll={() => refetchAll()}
                onOpenLogs={() => navigate("/logs")}
                onLogout={handleLogout}
            />

            {showAddApi && (
                <AddApiModal
                    form={newApiForm}
                    onChange={setNewApiForm}
                    onSubmit={handleAddApi}
                    onClose={() => setShowAddApi(false)}
                    monitorTargets={monitorTargets}
                    monitorTargetsError={monitorTargetsError}
                />
            )}

            {showDashboardSettings && (
                <DashboardSettingsModal
                    onClose={() => setShowDashboardSettings(false)}
                    apiBaseUrlDraft={apiBaseUrlDraft}
                    apiBaseUrlSaved={apiBaseUrlSaved}
                    onApiBaseUrlDraftChange={handleApiBaseUrlDraftChange}
                    onApplyApiBaseUrl={handleApplyApiBaseUrl}
                    fontSizeDraft={fontSizeDraft}
                    onFontSizeDraftChange={setFontSizeDraft}
                    onApplyDashboardSettings={handleApplyDashboardSettings}
                    alarmSound={alarmSound}
                    soundEnabled={soundEnabled}
                    onSetAlarmSound={setAlarmSound}
                    onSetSoundEnabled={setSoundEnabled}
                    configJsonDraft={configJsonDraft}
                    onConfigJsonDraftChange={setConfigJsonDraft}
                    onConfigFileChange={handleConfigFileChange}
                    configErrorMessage={configErrorMessage}
                    onExportConfig={handleExportConfig}
                    onImportConfigFromText={handleImportConfigFromText}
                    isAdmin={isAdmin}
                    dashboardTitleDraft={dashboardTitleDraft}
                    onDashboardTitleDraftChange={setDashboardTitleDraft}
                    onApplyDashboardTitle={handleApplyDashboardTitle}
                />
            )}

            {showSqlEditor && isAdmin && (
                <Suspense fallback={null}>
                    <SqlEditorModal
                        open={showSqlEditor}
                        onClose={() => setShowSqlEditor(false)}
                    />
                </Suspense>
            )}

            {isAdmin && (
                <BackendConfigPasswordPrompt
                    open={showConfigPasswordPrompt}
                    onClose={() => setShowConfigPasswordPrompt(false)}
                    onSuccess={() => {
                        setShowConfigPasswordPrompt(false);
                        setShowConfigEditor(true);
                    }}
                />
            )}

            {showConfigEditor && isAdmin && (
                <Suspense fallback={null}>
                    <ConfigEditorModal
                        open={showConfigEditor}
                        onClose={() => setShowConfigEditor(false)}
                    />
                </Suspense>
            )}

            <div className='dashboard-content-wrapper'>
                <div className='dashboard-content'>
                    {dashboardWidgets.length === 0 ? (
                        <div className='empty-state'>
                            <div className='empty-icon'>📭</div>
                            <h2>위젯을 추가하세요</h2>
                            <p>
                                모니터링할 데이터 API · 서버 리소스 · 네트워크 체크
                                위젯을 추가하여 대시보드를 시작합니다.
                            </p>
                            <button
                                className='primary-btn'
                                onClick={() => setShowAddApi(true)}
                            >
                                위젯 추가
                            </button>
                        </div>
                    ) : (
                        <ResponsiveGridLayout
                            className='api-grid'
                            layouts={responsiveLayouts}
                            breakpoints={{
                                lg: 1200,
                                md: 996,
                                sm: 768,
                                xs: 480,
                                xxs: 0,
                            }}
                            cols={{
                                lg: GRID_COLUMNS,
                                md: 20,
                                sm: 12,
                                xs: 8,
                                xxs: 4,
                            }}
                            rowHeight={56}
                            margin={[20, 20]}
                            containerPadding={[0, 0]}
                            draggableHandle='.api-card-header'
                            resizeHandles={["se"]}
                            onDragStop={handleLayoutCommit}
                            onResizeStop={handleLayoutCommit}
                        >
                            {dashboardWidgets.map((widget) => {
                                const apiResult = results[widget.id];
                                const apiData = apiResult?.data ?? null;
                                const apiError = apiResult?.error;
                                const apiStatus = apiResult?.status ?? "loading";
                                const isLoading =
                                    !!loadingMap[widget.id] && !apiData;
                                const isRefreshing =
                                    !!refreshingMap[widget.id];
                                const currentLayout =
                                    layouts[widget.id] ??
                                    gridLayout.find(
                                        (item) => item.i === widget.id,
                                    );

                                const isWidgetAlarming =
                                    alarmedWidgets.has(widget.id);

                                return (
                                    <div
                                        key={widget.id}
                                        className={`grid-item${isWidgetAlarming ? " widget-alarming" : ""}`}
                                    >
                                        <WidgetRenderer
                                            widget={widget}
                                            currentLayout={currentLayout}
                                            apiData={apiData}
                                            apiError={apiError}
                                            apiStatus={apiStatus}
                                            isLoading={isLoading}
                                            isRefreshing={isRefreshing}
                                            widgetFontSize={widgetFontSize}
                                            onRemoveApi={handleRemoveApi}
                                            onManualRefresh={handleManualRefresh}
                                            onRefetchOne={refetchOne}
                                            onWidgetSizeChange={
                                                handleWidgetSizeChange
                                            }
                                            onRefreshIntervalChange={
                                                handleRefreshIntervalChange
                                            }
                                            onWidgetMetaChange={
                                                handleWidgetMetaChange
                                            }
                                            onTableSettingsChange={
                                                handleTableSettingsChange
                                            }
                                            onChartSettingsChange={
                                                handleChartSettingsChange
                                            }
                                            onStatusListTargetIdsChange={
                                                handleStatusListTargetIdsChange
                                            }
                                            onUpdateWidget={updateWidget}
                                            onReportWidgetStatus={
                                                reportWidgetStatus
                                            }
                                        />
                                    </div>
                                );
                            })}
                        </ResponsiveGridLayout>
                    )}
                </div>
            </div>

            <AlarmBanner />

            <footer className='dashboard-footer'>
                <span className='footer-copyright'>
                    Copyright © {CURRENT_YEAR} {COMPANY_NAME}. All rights
                    reserved.
                </span>
                {/* monigrid_settings_kv.version 을 application 버전으로 표시.
                    backend.config.version 이 KV 우선 + build-time __version__ fallback. */}
                {backendVersion && (
                    <span className='footer-version'>v{backendVersion}</span>
                )}
            </footer>
        </div>
    );
};

export default DashboardPage;

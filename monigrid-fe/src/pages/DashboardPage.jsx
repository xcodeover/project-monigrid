import { useEffect, useMemo, useState } from "react";
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
import SqlEditorModal from "../components/SqlEditorModal";
import ConfigEditorModal from "../components/ConfigEditorModal";
import DashboardHeader from "./DashboardHeader";
import AddApiModal from "./AddApiModal";
import DashboardSettingsModal from "./DashboardSettingsModal";
import WidgetRenderer from "./WidgetRenderer";
import {
    DEFAULT_CONTENT_ZOOM,
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_FONT_SIZE,
    DEFAULT_WIDGET_LAYOUT,
    GRID_COLUMNS,
    MAX_CONTENT_ZOOM,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_CONTENT_ZOOM,
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
    parseStatusListInput,
} from "./dashboardHelpers";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./DashboardPage.css";

const ResponsiveGridLayout = WidthProvider(Responsive);

const COMPANY_NAME =
    import.meta.env.VITE_COMPANY_NAME || "Monitoring Dashboard";
const CURRENT_YEAR = new Date().getFullYear();
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

    // 빌드 시점 기본값 해석은 services/http.js에 일원화 (same-origin 모드 포함)
    const rememberedApiBaseUrl =
        getRememberedApiBaseUrl() || BUILDTIME_API_BASE_URL;

    const [showAddApi, setShowAddApi] = useState(false);
    const [showDashboardSettings, setShowDashboardSettings] = useState(false);
    const [showSqlEditor, setShowSqlEditor] = useState(false);
    const [showConfigEditor, setShowConfigEditor] = useState(false);
    const [newApiForm, setNewApiForm] = useState({
        title: "",
        endpoint: "",
        type: WIDGET_TYPE_TABLE,
        endpointsText: `${rememberedApiBaseUrl}/health\n${rememberedApiBaseUrl}/dashboard/endpoints`,
    });
    const [fontSizeDraft, setFontSizeDraft] = useState(
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
    );
    const [zoomDraft, setZoomDraft] = useState(
        dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM,
    );
    const [configJsonDraft, setConfigJsonDraft] = useState("");
    const [configErrorMessage, setConfigErrorMessage] = useState("");
    const [apiBaseUrlDraft, setApiBaseUrlDraft] = useState(rememberedApiBaseUrl);
    const [apiBaseUrlSaved, setApiBaseUrlSaved] = useState(false);
    const [backendVersion, setBackendVersion] = useState(null);

    useEffect(() => {
        let cancelled = false;
        const fetchBackendVersion = async () => {
            try {
                const res = await dashboardService.getApiData(null, "/health");
                if (!cancelled && res?.version) setBackendVersion(res.version);
            } catch {
                /* ignore */
            }
        };
        fetchBackendVersion();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        setFontSizeDraft(
            dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
        );
    }, [dashboardSettings?.widgetFontSize]);

    useEffect(() => {
        setZoomDraft(dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM);
    }, [dashboardSettings?.contentZoom]);

    useEffect(() => {
        if (widgets !== null) {
            return;
        }
        // 최초 로드(localStorage 없음)일 때만 기본 위젯 세트를 추가
        const statusListWidget = createStatusListWidget(rememberedApiBaseUrl);
        const initial = [...DEFAULT_APIS, statusListWidget];
        setWidgets(initial);
        saveLayout(statusListWidget.id, statusListWidget.defaultLayout);
    }, [widgets, setWidgets, saveLayout, rememberedApiBaseUrl]);

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

    const gridLayout = useMemo(
        () =>
            dashboardWidgets.map((widget) =>
                normalizeWidgetLayout(widget, layouts[widget.id]),
            ),
        [dashboardWidgets, layouts],
    );

    const handleLogout = () => {
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

        const statusListEndpoints = isStatusListWidget
            ? parseStatusListInput(
                  newApiForm.endpointsText,
                  rememberedApiBaseUrl,
              )
            : [];
        if (isStatusListWidget && statusListEndpoints.length === 0) {
            return;
        }

        const widgetId = `api-${Date.now()}`;
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
            endpoints: isStatusListWidget ? statusListEndpoints : undefined,
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
                ? { servers: [] }
                : undefined,
            networkConfig: isNetworkTestWidget ? { targets: [] } : undefined,
        };

        addWidget(newWidget);
        saveLayout(widgetId, nextLayout);
        setNewApiForm({
            title: "",
            endpoint: "",
            type: WIDGET_TYPE_TABLE,
            endpointsText: `${rememberedApiBaseUrl}/health\n${rememberedApiBaseUrl}/dashboard/endpoints`,
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

    const handleStatusListEndpointsChange = (apiId, endpoints) => {
        updateWidget(apiId, { endpoints });
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
        const normalizedZoom = clampValue(
            zoomDraft,
            MIN_CONTENT_ZOOM,
            MAX_CONTENT_ZOOM,
            DEFAULT_CONTENT_ZOOM,
        );

        setFontSizeDraft(normalizedFontSize);
        setZoomDraft(normalizedZoom);
        setDashboardSettings({
            widgetFontSize: normalizedFontSize,
            contentZoom: normalizedZoom,
        });
    };

    const handleApplyApiBaseUrl = () => {
        const trimmed = apiBaseUrlDraft.trim().replace(/\/+$/, "");
        if (!trimmed) return;
        rememberApiBaseUrl(trimmed);
        setApiBaseUrlSaved(true);
        setTimeout(() => setApiBaseUrlSaved(false), 2000);
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

    const contentZoom =
        dashboardSettings?.contentZoom ?? DEFAULT_CONTENT_ZOOM;
    const widgetFontSize =
        dashboardSettings?.widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE;

    return (
        <div className='dashboard-page'>
            <DashboardHeader
                widgetCount={dashboardWidgets.length}
                user={user}
                isAdmin={isAdmin}
                onOpenSettings={() => setShowDashboardSettings(true)}
                onOpenConfigEditor={() => setShowConfigEditor(true)}
                onOpenAddApi={() => setShowAddApi(true)}
                onOpenSqlEditor={() => setShowSqlEditor(true)}
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
                    zoomDraft={zoomDraft}
                    onZoomDraftChange={setZoomDraft}
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
                />
            )}

            {showSqlEditor && isAdmin && (
                <SqlEditorModal
                    open={showSqlEditor}
                    onClose={() => setShowSqlEditor(false)}
                />
            )}

            {showConfigEditor && isAdmin && (
                <ConfigEditorModal
                    open={showConfigEditor}
                    onClose={() => setShowConfigEditor(false)}
                />
            )}

            <div className='dashboard-content-wrapper'>
                <div
                    className={`dashboard-content${contentZoom !== 100 ? " zoom-scaled" : ""}`}
                    style={(() => {
                        const s = contentZoom / 100;
                        return s !== 1
                            ? {
                                  transform: `scale(${s})`,
                                  transformOrigin: "top left",
                                  width: `${100 / s}%`,
                              }
                            : undefined;
                    })()}
                >
                    {dashboardWidgets.length === 0 ? (
                        <div className='empty-state'>
                            <div className='empty-icon'>📭</div>
                            <h2>API 엔드포인트를 추가하세요</h2>
                            <p>
                                모니터링할 REST API 엔드포인트를 추가하여
                                대시보드를 시작합니다.
                            </p>
                            <button
                                className='primary-btn'
                                onClick={() => setShowAddApi(true)}
                            >
                                API 추가
                            </button>
                        </div>
                    ) : (
                        <ResponsiveGridLayout
                            className='api-grid'
                            layouts={{
                                lg: gridLayout,
                                md: gridLayout,
                                sm: gridLayout,
                                xs: gridLayout,
                                xxs: gridLayout,
                            }}
                            breakpoints={{
                                lg: 1200,
                                md: 996,
                                sm: 768,
                                xs: 480,
                                xxs: 0,
                            }}
                            cols={{
                                lg: GRID_COLUMNS,
                                md: 10,
                                sm: 6,
                                xs: 4,
                                xxs: 2,
                            }}
                            rowHeight={56}
                            margin={[20, 20]}
                            containerPadding={[0, 0]}
                            draggableHandle='.api-card-header'
                            resizeHandles={["se"]}
                            transformScale={contentZoom / 100}
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
                                            onStatusListEndpointsChange={
                                                handleStatusListEndpointsChange
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
                <span className='footer-version'>
                    monitoring-fe v{import.meta.env.VITE_APP_VERSION || "0.0.0"}
                    {backendVersion && ` | monitoring-be v${backendVersion}`}
                </span>
            </footer>
        </div>
    );
};

export default DashboardPage;

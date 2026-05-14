import { Component, memo, useCallback } from "react";
import ApiCard from "../components/ApiCard";
import HealthCheckCard from "../components/HealthCheckCard";
import LineChartCard from "../components/LineChartCard";
import BarChartCard from "../components/BarChartCard";
import StatusListCard from "../components/StatusListCard";
import NetworkTestCard from "../components/NetworkTestCard";
import ServerResourceCard from "../components/ServerResourceCard";
import {
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_FONT_SIZE,
    MAX_WIDGET_H,
    MAX_WIDGET_W,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    WIDGET_TYPE_BAR_CHART,
    WIDGET_TYPE_HEALTH_CHECK,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_NETWORK_TEST,
    WIDGET_TYPE_SERVER_RESOURCE,
    WIDGET_TYPE_STATUS_LIST,
} from "./dashboardConstants";

// React only catches render-time errors via an Error Boundary. Without one,
// a single widget throwing (BigInt in JSON.stringify, recharts NaN, etc.)
// unmounts the entire dashboard. This boundary scopes the blast to one tile.
class WidgetErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // eslint-disable-next-line no-console
        console.error(
            "[WidgetErrorBoundary]",
            this.props.widgetId,
            error,
            info,
        );
    }

    handleReset = () => {
        this.setState({ error: null });
    };

    render() {
        if (this.state.error) {
            return (
                <div
                    className='api-card'
                    role='alert'
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        padding: 12,
                        textAlign: "center",
                    }}
                >
                    <div style={{ fontWeight: 600 }}>
                        {this.props.title || "위젯"}
                    </div>
                    <div>위젯 렌더링 오류, 새로고침을 권장합니다.</div>
                    <div
                        style={{
                            fontSize: "0.8em",
                            opacity: 0.7,
                            wordBreak: "break-word",
                        }}
                    >
                        {String(
                            this.state.error?.message || this.state.error,
                        )}
                    </div>
                    <button
                        type='button'
                        onClick={this.handleReset}
                        style={{ padding: "4px 10px" }}
                    >
                        재시도
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

/**
 * Widget renderer extracted from DashboardPage (SRP).
 *
 * Selects the right card component for a single widget based on its
 * type and forwards the appropriate props. Owns no state — every
 * callback comes from the parent DashboardPage.
 */
const WidgetRendererInner = ({
    widget,
    currentLayout,
    apiData,
    apiError,
    apiStatus,
    isLoading,
    isRefreshing,
    widgetFontSize,
    onRemoveApi,
    onManualRefresh,
    onRefetchOne,
    onWidgetSizeChange,
    onRefreshIntervalChange,
    onWidgetMetaChange,
    onTableSettingsChange,
    onChartSettingsChange,
    onStatusListTargetIdsChange,
    onUpdateWidget,
    onReportWidgetStatus,
}) => {
    const widgetId = widget.id;

    // --- Memoized callbacks (keyed on widgetId + parent callbacks) ---
    const handleRemove = useCallback(
        () => onRemoveApi(widgetId),
        [onRemoveApi, widgetId],
    );
    const handleRefresh = useCallback(
        () => onManualRefresh(widget),
        [onManualRefresh, widget],
    );
    const handleRefetchOne = useCallback(
        () => onRefetchOne(widgetId),
        [onRefetchOne, widgetId],
    );
    const handleRefreshIntervalChange = useCallback(
        (intervalSec) => onRefreshIntervalChange(widgetId, intervalSec),
        [onRefreshIntervalChange, widgetId],
    );
    const handleWidgetMetaChange = useCallback(
        (updates) => onWidgetMetaChange(widgetId, updates),
        [onWidgetMetaChange, widgetId],
    );
    const handleSizeChange = useCallback(
        (nextWidth, nextHeight) => onWidgetSizeChange(widgetId, nextWidth, nextHeight),
        [onWidgetSizeChange, widgetId],
    );
    const handleAlarmChange = useCallback(
        (status) => onReportWidgetStatus(widgetId, status),
        [onReportWidgetStatus, widgetId],
    );
    const handleChartSettingsChange = useCallback(
        (nextSettings) => onChartSettingsChange(widgetId, nextSettings),
        [onChartSettingsChange, widgetId],
    );
    const handleTableSettingsChange = useCallback(
        (nextSettings) => onTableSettingsChange(widgetId, nextSettings),
        [onTableSettingsChange, widgetId],
    );
    const handleStatusListTargetIdsChange = useCallback(
        (nextTargetIds) => onStatusListTargetIdsChange(widgetId, nextTargetIds),
        [onStatusListTargetIdsChange, widgetId],
    );
    const handleWidgetConfigChange = useCallback(
        (cfg, key) => onUpdateWidget(widgetId, { [key]: cfg }),
        [onUpdateWidget, widgetId],
    );
    const handleServerConfigChange = useCallback(
        (cfg) => handleWidgetConfigChange(cfg, "serverConfig"),
        [handleWidgetConfigChange],
    );
    const handleNetworkConfigChange = useCallback(
        (cfg) => handleWidgetConfigChange(cfg, "networkConfig"),
        [handleWidgetConfigChange],
    );

    const sizeBounds = {
        minW: currentLayout?.minW ?? MIN_WIDGET_W,
        maxW: MAX_WIDGET_W,
        minH: currentLayout?.minH ?? MIN_WIDGET_H,
        maxH: MAX_WIDGET_H,
    };

    const widgetError =
        apiStatus === "dead" || apiStatus === "error" ? apiError : null;

    const commonCardProps = {
        title: widget.title,
        endpoint: widget.endpoint,
        data: apiData,
        loading: isLoading,
        error: widgetError,
        apiStatus,
        onRemove: handleRemove,
        onRefresh: handleRefresh,
        currentSize: currentLayout,
        sizeBounds,
        refreshIntervalSec:
            widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC,
        // DashboardPage 가 이미 widget.dataFontSize ?? global 로 resolve 한 값을
        // 넘겨준다. 각 카드는 settings 모달에서 fontSize 편집 시 widget.dataFontSize
        // 만 patch 하면 user_preferences DB 에 자동 persist.
        widgetFontSize: widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE,
        onRefreshIntervalChange: handleRefreshIntervalChange,
        onWidgetMetaChange: handleWidgetMetaChange,
        onSizeChange: handleSizeChange,
    };

    if (widget.type === WIDGET_TYPE_LINE_CHART) {
        return (
            <LineChartCard
                apiId={widgetId}
                {...commonCardProps}
                chartSettings={widget.chartSettings}
                onChartSettingsChange={handleChartSettingsChange}
            />
        );
    }

    if (widget.type === WIDGET_TYPE_BAR_CHART) {
        return (
            <BarChartCard
                apiId={widgetId}
                {...commonCardProps}
                chartSettings={widget.chartSettings}
                onChartSettingsChange={handleChartSettingsChange}
            />
        );
    }

    // 4 카드(StatusList/ServerResource/NetworkTest/HealthCheck)는 데이터 카드와
    // 시그니처가 달라 commonCardProps 를 그대로 spread 하지 않는다. 다만
    // widgetFontSize 는 모든 카드의 settings 모달 draft 초기값으로 필요하므로
    // 공통으로 추출해 명시 전달한다. 누락 시 모달이 항상 default 13 으로 reset 됨.
    const resolvedFontSize = widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE;

    if (widget.type === WIDGET_TYPE_STATUS_LIST) {
        return (
            <StatusListCard
                title={widget.title}
                targetIds={widget.targetIds || []}
                data={apiData}
                loading={isLoading}
                error={widgetError}
                apiStatus={apiStatus}
                onRemove={handleRemove}
                onRefresh={handleRefresh}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={
                    widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC
                }
                widgetFontSize={resolvedFontSize}
                onRefreshIntervalChange={handleRefreshIntervalChange}
                onWidgetMetaChange={handleWidgetMetaChange}
                onTargetIdsChange={handleStatusListTargetIdsChange}
                onSizeChange={handleSizeChange}
            />
        );
    }

    if (widget.type === WIDGET_TYPE_SERVER_RESOURCE) {
        return (
            <ServerResourceCard
                title={widget.title}
                widgetConfig={widget.serverConfig}
                onRemove={handleRemove}
                onRefresh={handleRefetchOne}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={widget.refreshIntervalSec ?? 30}
                widgetFontSize={resolvedFontSize}
                onRefreshIntervalChange={handleRefreshIntervalChange}
                onWidgetMetaChange={handleWidgetMetaChange}
                onWidgetConfigChange={handleServerConfigChange}
                onAlarmChange={handleAlarmChange}
                onSizeChange={handleSizeChange}
            />
        );
    }

    if (widget.type === WIDGET_TYPE_NETWORK_TEST) {
        return (
            <NetworkTestCard
                title={widget.title}
                networkConfig={widget.networkConfig}
                onRemove={handleRemove}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={widget.refreshIntervalSec ?? 10}
                widgetFontSize={resolvedFontSize}
                onRefreshIntervalChange={handleRefreshIntervalChange}
                onWidgetMetaChange={handleWidgetMetaChange}
                onWidgetConfigChange={handleNetworkConfigChange}
                onAlarmChange={handleAlarmChange}
                onSizeChange={handleSizeChange}
            />
        );
    }

    if (widget.type === WIDGET_TYPE_HEALTH_CHECK) {
        return (
            <HealthCheckCard
                apiId={widgetId}
                title={widget.title}
                endpoint={widget.endpoint}
                healthData={apiData}
                loading={isLoading}
                refreshing={isRefreshing}
                error={widgetError}
                apiStatus={apiStatus}
                onRemove={handleRemove}
                onRefresh={handleRefresh}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={
                    widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC
                }
                widgetFontSize={resolvedFontSize}
                onRefreshIntervalChange={handleRefreshIntervalChange}
                onWidgetMetaChange={handleWidgetMetaChange}
                onSizeChange={handleSizeChange}
            />
        );
    }

    // Default: data table
    return (
        <ApiCard
            title={widget.title}
            endpoint={widget.endpoint}
            data={apiData}
            loading={isLoading}
            error={widgetError}
            apiStatus={apiStatus}
            onRemove={handleRemove}
            onRefresh={handleRefresh}
            currentSize={currentLayout}
            sizeBounds={sizeBounds}
            refreshIntervalSec={
                widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC
            }
            onRefreshIntervalChange={handleRefreshIntervalChange}
            onWidgetMetaChange={handleWidgetMetaChange}
            tableSettings={widget.tableSettings}
            widgetFontSize={widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE}
            onTableSettingsChange={handleTableSettingsChange}
            onSizeChange={handleSizeChange}
        />
    );
};

/**
 * Custom equality skips re-renders when the only thing that changed in the
 * parent was a callback identity (DashboardPage rebuilds many of these on
 * each render). Compare the widget object, layout, and async data fields by
 * reference; treat callbacks as interchangeable. The parent already calls
 * the freshest callback when an event fires, so a stale-but-functional
 * callback here is harmless — the closure inside it reads from the parent's
 * latest state.
 */
const _propsAreEqual = (prev, next) =>
    prev.widget === next.widget &&
    prev.currentLayout === next.currentLayout &&
    prev.apiData === next.apiData &&
    prev.apiError === next.apiError &&
    prev.apiStatus === next.apiStatus &&
    prev.isLoading === next.isLoading &&
    prev.isRefreshing === next.isRefreshing &&
    prev.widgetFontSize === next.widgetFontSize;

const MemoWidgetRendererInner = memo(WidgetRendererInner, _propsAreEqual);

const WidgetRenderer = (props) => (
    <WidgetErrorBoundary
        widgetId={props.widget?.id}
        title={props.widget?.title}
    >
        <MemoWidgetRendererInner {...props} />
    </WidgetErrorBoundary>
);

export default WidgetRenderer;

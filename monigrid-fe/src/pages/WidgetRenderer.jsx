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

/**
 * Widget renderer extracted from DashboardPage (SRP).
 *
 * Selects the right card component for a single widget based on its
 * type and forwards the appropriate props. Owns no state — every
 * callback comes from the parent DashboardPage.
 */
const WidgetRenderer = ({
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
    onStatusListEndpointsChange,
    onUpdateWidget,
    onReportWidgetStatus,
}) => {
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
        onRemove: () => onRemoveApi(widget.id),
        onRefresh: () => onManualRefresh(widget),
        currentSize: currentLayout,
        sizeBounds,
        refreshIntervalSec:
            widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC,
        onRefreshIntervalChange: (intervalSec) =>
            onRefreshIntervalChange(widget.id, intervalSec),
        onWidgetMetaChange: (updates) =>
            onWidgetMetaChange(widget.id, updates),
        onSizeChange: (nextWidth, nextHeight) =>
            onWidgetSizeChange(widget.id, nextWidth, nextHeight),
    };

    if (widget.type === WIDGET_TYPE_LINE_CHART) {
        return (
            <LineChartCard
                apiId={widget.id}
                {...commonCardProps}
                chartSettings={widget.chartSettings}
                onChartSettingsChange={(nextSettings) =>
                    onChartSettingsChange(widget.id, nextSettings)
                }
            />
        );
    }

    if (widget.type === WIDGET_TYPE_BAR_CHART) {
        return (
            <BarChartCard
                apiId={widget.id}
                {...commonCardProps}
                chartSettings={widget.chartSettings}
                onChartSettingsChange={(nextSettings) =>
                    onChartSettingsChange(widget.id, nextSettings)
                }
            />
        );
    }

    if (widget.type === WIDGET_TYPE_STATUS_LIST) {
        return (
            <StatusListCard
                title={widget.title}
                endpoints={widget.endpoints}
                data={apiData}
                loading={isLoading}
                error={widgetError}
                apiStatus={apiStatus}
                onRemove={() => onRemoveApi(widget.id)}
                onRefresh={() => onManualRefresh(widget)}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={
                    widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC
                }
                onRefreshIntervalChange={(intervalSec) =>
                    onRefreshIntervalChange(widget.id, intervalSec)
                }
                onWidgetMetaChange={(updates) =>
                    onWidgetMetaChange(widget.id, updates)
                }
                onEndpointsChange={(nextEndpoints) =>
                    onStatusListEndpointsChange(widget.id, nextEndpoints)
                }
                onSizeChange={(nextWidth, nextHeight) =>
                    onWidgetSizeChange(widget.id, nextWidth, nextHeight)
                }
            />
        );
    }

    if (widget.type === WIDGET_TYPE_SERVER_RESOURCE) {
        return (
            <ServerResourceCard
                title={widget.title}
                widgetConfig={widget.serverConfig}
                onRemove={() => onRemoveApi(widget.id)}
                onRefresh={() => onRefetchOne(widget.id)}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={widget.refreshIntervalSec ?? 30}
                onRefreshIntervalChange={(intervalSec) =>
                    onRefreshIntervalChange(widget.id, intervalSec)
                }
                onWidgetMetaChange={(updates) =>
                    onWidgetMetaChange(widget.id, updates)
                }
                onWidgetConfigChange={(cfg) =>
                    onUpdateWidget(widget.id, { serverConfig: cfg })
                }
                onAlarmChange={(status) =>
                    onReportWidgetStatus(widget.id, status)
                }
                onSizeChange={(nextWidth, nextHeight) =>
                    onWidgetSizeChange(widget.id, nextWidth, nextHeight)
                }
            />
        );
    }

    if (widget.type === WIDGET_TYPE_NETWORK_TEST) {
        return (
            <NetworkTestCard
                title={widget.title}
                networkConfig={widget.networkConfig}
                onRemove={() => onRemoveApi(widget.id)}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={widget.refreshIntervalSec ?? 10}
                onRefreshIntervalChange={(intervalSec) =>
                    onRefreshIntervalChange(widget.id, intervalSec)
                }
                onWidgetMetaChange={(updates) =>
                    onWidgetMetaChange(widget.id, updates)
                }
                onWidgetConfigChange={(cfg) =>
                    onUpdateWidget(widget.id, { networkConfig: cfg })
                }
                onAlarmChange={(status) =>
                    onReportWidgetStatus(widget.id, status)
                }
                onSizeChange={(nextWidth, nextHeight) =>
                    onWidgetSizeChange(widget.id, nextWidth, nextHeight)
                }
            />
        );
    }

    if (widget.type === WIDGET_TYPE_HEALTH_CHECK) {
        return (
            <HealthCheckCard
                apiId={widget.id}
                title={widget.title}
                endpoint={widget.endpoint}
                healthData={apiData}
                loading={isLoading}
                refreshing={isRefreshing}
                error={widgetError}
                apiStatus={apiStatus}
                onRemove={() => onRemoveApi(widget.id)}
                onRefresh={() => onManualRefresh(widget)}
                currentSize={currentLayout}
                sizeBounds={sizeBounds}
                refreshIntervalSec={
                    widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC
                }
                onRefreshIntervalChange={(intervalSec) =>
                    onRefreshIntervalChange(widget.id, intervalSec)
                }
                onWidgetMetaChange={(updates) =>
                    onWidgetMetaChange(widget.id, updates)
                }
                onSizeChange={(nextWidth, nextHeight) =>
                    onWidgetSizeChange(widget.id, nextWidth, nextHeight)
                }
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
            onRemove={() => onRemoveApi(widget.id)}
            onRefresh={() => onManualRefresh(widget)}
            currentSize={currentLayout}
            sizeBounds={sizeBounds}
            refreshIntervalSec={
                widget.refreshIntervalSec ?? DEFAULT_REFRESH_INTERVAL_SEC
            }
            onRefreshIntervalChange={(intervalSec) =>
                onRefreshIntervalChange(widget.id, intervalSec)
            }
            onWidgetMetaChange={(updates) =>
                onWidgetMetaChange(widget.id, updates)
            }
            tableSettings={widget.tableSettings}
            widgetFontSize={widgetFontSize ?? DEFAULT_WIDGET_FONT_SIZE}
            onTableSettingsChange={(nextSettings) =>
                onTableSettingsChange(widget.id, nextSettings)
            }
            onSizeChange={(nextWidth, nextHeight) =>
                onWidgetSizeChange(widget.id, nextWidth, nextHeight)
            }
        />
    );
};

export default WidgetRenderer;

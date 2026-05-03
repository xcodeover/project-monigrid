/**
 * Pure helpers extracted from DashboardPage.jsx (SRP).
 *
 * No React imports — can be unit tested without rendering and reused by
 * dashboard sub-components.
 */

import {
    DEFAULT_REFRESH_INTERVAL_SEC,
    DEFAULT_WIDGET_LAYOUT,
    MIN_WIDGET_H,
    MIN_WIDGET_W,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants";

export const clampValue = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

export const normalizeWidgetLayout = (widget, savedLayout) => {
    const fallbackLayout = widget.defaultLayout ?? DEFAULT_WIDGET_LAYOUT;

    return {
        i: widget.id,
        ...fallbackLayout,
        ...savedLayout,
        minW:
            savedLayout?.minW ??
            fallbackLayout.minW ??
            DEFAULT_WIDGET_LAYOUT.minW,
        minH:
            savedLayout?.minH ??
            fallbackLayout.minH ??
            DEFAULT_WIDGET_LAYOUT.minH,
    };
};

export const layoutArrayToMap = (layoutItems, previousLayouts = {}) => {
    return layoutItems.reduce((accumulator, item) => {
        accumulator[item.i] = {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
            minW: previousLayouts[item.i]?.minW ?? MIN_WIDGET_W,
            minH: previousLayouts[item.i]?.minH ?? MIN_WIDGET_H,
        };
        return accumulator;
    }, {});
};

// Default status-list widget seeded on first dashboard load. Targets are now
// owned by the BE settings DB (`monigrid_monitor_targets`, type=http_status),
// so the widget starts empty — the admin must register targets in the
// "API 상태" config tab and then pick them in the widget's settings.
export const createStatusListWidget = () => ({
    id: "api-status-list",
    type: WIDGET_TYPE_STATUS_LIST,
    title: "API Status List",
    targetIds: [],
    defaultLayout: {
        x: 0,
        y: 5,
        w: 8,
        h: 5,
        minW: MIN_WIDGET_W,
        minH: MIN_WIDGET_H,
    },
    refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
});

export const createDefaultApis = (baseUrl) => [
    {
        id: "api-1",
        type: WIDGET_TYPE_TABLE,
        title: "CoinTrader Status",
        endpoint: `${baseUrl}/api/status`,
        defaultLayout: {
            x: 0,
            y: 0,
            w: 8,
            h: 4,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    {
        id: "api-2",
        type: WIDGET_TYPE_TABLE,
        title: "Application Alerts",
        endpoint: `${baseUrl}/api/alerts`,
        defaultLayout: {
            x: 8,
            y: 0,
            w: 8,
            h: 4,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
    {
        id: "api-3",
        type: WIDGET_TYPE_TABLE,
        title: "System Metrics",
        endpoint: `${baseUrl}/api/metrics`,
        defaultLayout: {
            x: 16,
            y: 0,
            w: 8,
            h: 5,
            minW: MIN_WIDGET_W,
            minH: MIN_WIDGET_H,
        },
        refreshIntervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
        tableSettings: {
            visibleColumns: [],
            columnWidths: {},
            criteria: {},
        },
    },
];

/**
 * Pure helpers extracted from DashboardPage.jsx (SRP).
 *
 * No React imports — can be unit tested without rendering and reused by
 * dashboard sub-components.
 */

import { resolveEndpointWithBase } from "../services/api";
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

export const parseStatusListInput = (rawValue, baseUrl) => {
    return String(rawValue ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const [rawLabel, ...rawUrlTokens] = line.includes("|")
                ? line.split("|")
                : ["", line];
            const urlValue =
                rawUrlTokens.length > 0 ? rawUrlTokens.join("|") : rawLabel;
            const normalizedUrl = resolveEndpointWithBase(
                urlValue.trim(),
                baseUrl,
            );
            const fallbackLabel = (() => {
                try {
                    const parsedUrl = new URL(normalizedUrl);
                    return parsedUrl.pathname || normalizedUrl;
                } catch {
                    return normalizedUrl;
                }
            })();

            return {
                id: `status-list-item-${index}-${normalizedUrl}`,
                label:
                    (rawUrlTokens.length > 0
                        ? rawLabel
                        : fallbackLabel
                    ).trim() || fallbackLabel,
                url: normalizedUrl,
            };
        })
        .filter((item) => item.url);
};

export const createStatusListWidget = (baseUrl) => ({
    id: "api-status-list",
    type: WIDGET_TYPE_STATUS_LIST,
    title: "API Status List",
    endpoints: [
        { id: "status-health", label: "Health", url: `${baseUrl}/health` },
        {
            id: "status-endpoints",
            label: "Endpoint Catalog",
            url: `${baseUrl}/dashboard/endpoints`,
        },
        {
            id: "status-logs",
            label: "Log Dates",
            url: `${baseUrl}/logs/available-dates`,
        },
    ],
    defaultLayout: {
        x: 0,
        y: 5,
        w: 4,
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
            w: 4,
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
            x: 4,
            y: 0,
            w: 4,
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
            x: 8,
            y: 0,
            w: 4,
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

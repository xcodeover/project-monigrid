/**
 * Constants extracted from DashboardPage.jsx (SRP).
 *
 * Pure module — no React imports — so it can be reused by every
 * dashboard sub-component (modals, widget renderer, etc.) without
 * forming a circular dependency on the page module itself.
 */

export const MIN_WIDGET_W = 2;
export const MAX_WIDGET_W = 12;
export const MIN_WIDGET_H = 2;
export const MAX_WIDGET_H = 24;
export const DEFAULT_REFRESH_INTERVAL_SEC = 5;
export const MIN_REFRESH_INTERVAL_SEC =
    Math.max(1, Number(import.meta.env.VITE_MIN_REFRESH_INTERVAL_SEC) || 5);
export const MAX_REFRESH_INTERVAL_SEC =
    Math.max(MIN_REFRESH_INTERVAL_SEC, Number(import.meta.env.VITE_MAX_REFRESH_INTERVAL_SEC) || 3600);
export const DEFAULT_WIDGET_FONT_SIZE = 13;
export const DEFAULT_CONTENT_ZOOM = 100;
export const MIN_CONTENT_ZOOM = 50;
export const MAX_CONTENT_ZOOM = 150;
export const ZOOM_STEP = 10;
export const GRID_COLUMNS = 12;

export const WIDGET_TYPE_TABLE = "table";
export const WIDGET_TYPE_HEALTH_CHECK = "health-check";
export const WIDGET_TYPE_LINE_CHART = "line-chart";
export const WIDGET_TYPE_BAR_CHART = "bar-chart";
export const WIDGET_TYPE_STATUS_LIST = "status-list";
export const WIDGET_TYPE_NETWORK_TEST = "network-test";
export const WIDGET_TYPE_SERVER_RESOURCE = "server-resource";

export const DEFAULT_WIDGET_LAYOUT = {
    x: 0,
    y: 0,
    w: 4,
    h: 4,
    minW: MIN_WIDGET_W,
    minH: MIN_WIDGET_H,
};

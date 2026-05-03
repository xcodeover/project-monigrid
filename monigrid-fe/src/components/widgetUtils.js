/**
 * Shared widget helpers (DRY).
 *
 * These were previously copied verbatim into BarChartCard, LineChartCard,
 * HealthCheckCard, NetworkTestCard, and StatusListCard. Bug fixes had a
 * habit of being made in one copy and forgotten in the others. Centralising
 * them here trims ~50 lines off each card and gives a single place to
 * change the formatting / clamp behaviour.
 */

import { SIZE_UNIT_SCALE } from "../pages/dashboardConstants";

export const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
};

// Convert a half-step "user size" (e.g. 1.5) into the integer grid units the
// layout actually stores. Round to the nearest half-unit to keep stale typing
// like "1.7" from drifting off-grid. Grid units are integers ≥ 1.
export const toGridSize = (userValue) => {
    const n = Number(userValue);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.round(n * SIZE_UNIT_SCALE));
};

export const toUserSize = (gridValue) => {
    const n = Number(gridValue);
    if (!Number.isFinite(n)) return 0;
    return n / SIZE_UNIT_SCALE;
};

// Half-step clamp for user-facing size inputs. Snaps to 0.5 increments and
// keeps the value within [min, max]. min/max are in user units, not grid units.
export const clampHalf = (userValue, min, max, fallback) => {
    const n = Number(userValue);
    if (!Number.isFinite(n)) return fallback;
    const snapped = Math.round(n * SIZE_UNIT_SCALE) / SIZE_UNIT_SCALE;
    return Math.min(max, Math.max(min, snapped));
};

export const formatInterval = (sec) => {
    if (sec >= 3600) return `every ${Math.floor(sec / 3600)}h`;
    if (sec >= 60) return `every ${Math.floor(sec / 60)}m`;
    return `every ${sec}s`;
};

export const formatLocalTime = (date) => {
    if (!date) return null;
    return date.toLocaleTimeString("en-GB", { hour12: false });
};

/**
 * Normalize an API response into chart-friendly rows.
 *
 * Differs from apiCardHelpers.normalizeData in that scalar values nested
 * under an object key are wrapped as `{ value }` so the chart libraries
 * have a stable Y-axis field — table widgets don't need that wrapping.
 */
export const normalizeChartData = (raw) => {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object") {
        return Object.entries(raw).map(([k, v]) => ({
            _key: k,
            ...(typeof v === "object" && v !== null ? v : { value: v }),
        }));
    }
    return [];
};

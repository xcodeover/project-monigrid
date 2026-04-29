/**
 * Shared widget helpers (DRY).
 *
 * These were previously copied verbatim into BarChartCard, LineChartCard,
 * HealthCheckCard, NetworkTestCard, and StatusListCard. Bug fixes had a
 * habit of being made in one copy and forgotten in the others. Centralising
 * them here trims ~50 lines off each card and gives a single place to
 * change the formatting / clamp behaviour.
 */

export const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
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

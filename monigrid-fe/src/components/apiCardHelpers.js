/**
 * Pure helper functions extracted from ApiCard.jsx (SRP).
 *
 * No React imports — these are intentionally pure so they can be unit
 * tested without rendering and reused by future ApiCard sub-components.
 */

export const reorderItems = (items, fromIndex, toIndex) => {
    if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= items.length ||
        toIndex >= items.length
    ) {
        return items;
    }

    const nextItems = [...items];
    const [movedItem] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, movedItem);
    return nextItems;
};

export const clamp = (value, min, max, fallback) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(numericValue)));
};

export const normalizeData = (rawData) => {
    if (Array.isArray(rawData)) {
        return rawData;
    }

    if (typeof rawData === "object" && rawData !== null) {
        return Object.keys(rawData).map((key) => ({
            _key: key,
            ...rawData[key],
        }));
    }

    return [];
};

export const getAllColumns = (rawData) => {
    const rows = normalizeData(rawData);
    const columnSet = new Set();

    rows.forEach((row) => {
        if (typeof row === "object" && row !== null) {
            Object.keys(row).forEach((key) => {
                if (!key.startsWith("_")) {
                    columnSet.add(key);
                }
            });
        }
    });

    return Array.from(columnSet);
};

export const getDefaultColumnWidth = (column) => {
    const label = column
        .replace(/_/g, " ")
        .replace(/\b\w/g, (value) => value.toUpperCase());
    const estimatedWidth = label.length * 9 + 28;
    return Math.max(80, Math.min(420, estimatedWidth));
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

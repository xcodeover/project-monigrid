/**
 * Shared threshold evaluation helpers for LineChart / BarChart widgets.
 *
 * A threshold is user-configurable and looks like:
 *   { key: "cpu", operator: ">=", value: 80, enabled: true, label?: "CPU 경고" }
 *
 * Multiple thresholds are supported so a chart with multiple Y-axis columns
 * can have an independent threshold per column.
 */

export const OPERATORS = [
    { value: ">", label: ">" },
    { value: ">=", label: "≥" },
    { value: "<", label: "<" },
    { value: "<=", label: "≤" },
    { value: "==", label: "=" },
    { value: "!=", label: "≠" },
];

export const THRESHOLD_COLORS = [
    "#ef4444",
    "#f97316",
    "#eab308",
    "#a855f7",
    "#0ea5e9",
    "#ec4899",
];

export const evaluateThreshold = (value, operator, threshold) => {
    const v = Number(value);
    const t = Number(threshold);
    if (!Number.isFinite(v) || !Number.isFinite(t)) return false;
    switch (operator) {
        case ">":
            return v > t;
        case ">=":
            return v >= t;
        case "<":
            return v < t;
        case "<=":
            return v <= t;
        case "==":
            return v === t;
        case "!=":
            return v !== t;
        default:
            return false;
    }
};

/** Returns true if ANY row violates ANY enabled threshold. */
export const hasThresholdViolation = (rows, thresholds) => {
    if (!Array.isArray(thresholds) || thresholds.length === 0) return false;
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const active = thresholds.filter((t) => t?.enabled !== false && t?.key);
    if (active.length === 0) return false;
    return rows.some((row) =>
        active.some((t) =>
            evaluateThreshold(row?.[t.key], t.operator, t.value),
        ),
    );
};

export const normalizeThresholds = (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((t) => ({
            key: String(t?.key ?? "").trim(),
            operator: String(t?.operator ?? ">="),
            value: t?.value ?? "",
            enabled: t?.enabled !== false,
            label: t?.label ? String(t.label) : "",
        }))
        .filter((t) => t.key);
};

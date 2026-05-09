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

// Phase 4 정리: ``hasThresholdViolation`` 은 BE 알람 평가 도입 후 사용처가
// 모두 사라져 제거됐다. 차트 위젯의 임계치 시각화(라인/색)는 여전히 BE
// 정의를 read-only 로 받아 그릴 수 있어 ``OPERATORS``/``THRESHOLD_COLORS``/
// ``normalizeThresholds``/``evaluateThreshold`` 는 그대로 유지한다.

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

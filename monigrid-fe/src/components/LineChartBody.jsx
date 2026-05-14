import { useState } from "react";
import {
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { THRESHOLD_COLORS } from "../utils/chartThresholds.js";

const CHART_COLORS = [
    "#19a0ff",
    "#00cdb0",
    "#ff8ea0",
    "#ffd166",
    "#a29bfe",
    "#fd79a8",
    "#55efc4",
    "#fdcb6e",
    "#74b9ff",
    "#e17055",
];

const formatTooltipValue = (raw) => {
    if (typeof raw === "number") return raw.toLocaleString();
    if (raw == null || raw === "") return "—";
    return String(raw);
};

/**
 * Pure chart-body renderer extracted from LineChartCard (SRP).
 *
 * Mirror of BarChartBody: handles the four render states (error / loading
 * / empty / chart-with-optional-downsample-notice) and the recharts wiring
 * specific to a line chart (no orientation flip, single value axis).
 */
const LineChartBody = ({ error, loading, settings, chartSettings }) => {
    const {
        chartRows,
        filteredRows,
        isDownsampled,
        xAxisKey,
        yAxisKeys,
        activeThresholds,
    } = settings;

    // recharts 3.x 의 LineChart Tooltip 은 payload entry.value 가 0/stale 로
    // 들어오는 케이스가 있다. BarChartBody 와 동일하게 마우스 위치를 직접
    // 추적해 chartRows[idx] 에서 row 를 가져와 row[key] 를 그대로 표시한다.
    const [activeIdx, setActiveIdx] = useState(null);

    if (error) {
        return <div className='lc-state lc-error'>⚠️ 오류: {error}</div>;
    }
    if (loading) {
        return (
            <div className='lc-state'>
                <div className='spinner' />
            </div>
        );
    }
    if (filteredRows.length === 0) {
        return <div className='lc-state lc-empty'>데이터가 없습니다</div>;
    }

    return (
        <>
            {isDownsampled && (
                <div className='lc-downsample-notice'>
                    {filteredRows.length.toLocaleString()}개 →{" "}
                    {chartRows.length}포인트 표시 (다운샘플링)
                </div>
            )}
            <ResponsiveContainer width='100%' height='100%' minWidth={0} minHeight={0}>
                <LineChart
                    data={chartRows}
                    margin={{
                        top: 6,
                        right: 16,
                        left: 0,
                        bottom: 4,
                    }}
                    onMouseMove={(state) => {
                        const raw = state?.activeTooltipIndex;
                        const idx =
                            raw == null || raw === ""
                                ? NaN
                                : Number(raw);
                        if (
                            state?.isTooltipActive &&
                            Number.isInteger(idx) &&
                            idx >= 0
                        ) {
                            setActiveIdx(idx);
                        } else {
                            setActiveIdx(null);
                        }
                    }}
                    onMouseLeave={() => setActiveIdx(null)}
                >
                    <CartesianGrid
                        strokeDasharray='3 3'
                        stroke='rgba(255,255,255,0.06)'
                    />
                    <XAxis
                        dataKey={xAxisKey}
                        tick={{ fill: "#7a90a8", fontSize: 11 }}
                        tickLine={false}
                        axisLine={{
                            stroke: "rgba(255,255,255,0.08)",
                        }}
                        interval='preserveStartEnd'
                    />
                    <YAxis
                        tick={{ fill: "#7a90a8", fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        width={44}
                    />
                    <Tooltip
                        content={(tooltipProps) => {
                            if (!tooltipProps?.active) return null;
                            const idx = activeIdx;
                            if (idx == null || !chartRows[idx]) return null;
                            const row = chartRows[idx];
                            const labelValue = xAxisKey
                                ? row?.[xAxisKey]
                                : tooltipProps.label;
                            return (
                                <div className='lc-tooltip'>
                                    {labelValue != null && labelValue !== "" && (
                                        <p className='lc-tooltip-label'>
                                            {String(labelValue)}
                                        </p>
                                    )}
                                    {yAxisKeys.map((key, i) => {
                                        const color =
                                            CHART_COLORS[i % CHART_COLORS.length];
                                        return (
                                            <div
                                                key={key}
                                                className='lc-tooltip-row'
                                                style={{ color }}
                                            >
                                                <span className='lc-tooltip-name'>
                                                    {key}
                                                </span>
                                                <span className='lc-tooltip-value'>
                                                    {formatTooltipValue(row?.[key])}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        }}
                    />
                    {activeThresholds.map((t, idx) => {
                        const numericValue = Number(t.value);
                        if (!Number.isFinite(numericValue)) return null;
                        const color =
                            THRESHOLD_COLORS[idx % THRESHOLD_COLORS.length];
                        return (
                            <ReferenceLine
                                key={`threshold-${idx}`}
                                y={numericValue}
                                stroke={color}
                                strokeDasharray='4 4'
                                strokeWidth={1.6}
                                ifOverflow='extendDomain'
                                label={{
                                    value:
                                        t.label ||
                                        `${t.key} ${t.operator} ${numericValue}`,
                                    fill: color,
                                    fontSize: 10,
                                    position: "right",
                                }}
                            />
                        );
                    })}
                    {(chartSettings?.showLegend ?? true) && (
                        <Legend
                            wrapperStyle={{
                                fontSize: 11,
                                color: "#7a90a8",
                                paddingTop: 2,
                            }}
                        />
                    )}
                    {yAxisKeys.map((key, i) => (
                        <Line
                            key={key}
                            type='monotone'
                            dataKey={key}
                            stroke={CHART_COLORS[i % CHART_COLORS.length]}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{
                                r: 5,
                                strokeWidth: 0,
                                fill: CHART_COLORS[i % CHART_COLORS.length],
                            }}
                        />
                    ))}
                </LineChart>
            </ResponsiveContainer>
        </>
    );
};

export default LineChartBody;

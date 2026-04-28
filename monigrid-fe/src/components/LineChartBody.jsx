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

const ChartTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className='lc-tooltip'>
            <p className='lc-tooltip-label'>{String(label)}</p>
            {payload.map((entry) => (
                <div
                    key={entry.dataKey}
                    className='lc-tooltip-row'
                    style={{ color: entry.color }}
                >
                    <span className='lc-tooltip-name'>{entry.name}</span>
                    <span className='lc-tooltip-value'>
                        {typeof entry.value === "number"
                            ? entry.value.toLocaleString()
                            : String(entry.value ?? "—")}
                    </span>
                </div>
            ))}
        </div>
    );
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
                    <Tooltip content={<ChartTooltip />} />
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

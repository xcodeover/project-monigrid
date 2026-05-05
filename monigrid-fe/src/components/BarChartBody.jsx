import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    Rectangle,
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

const formatTooltipNumber = (raw) => {
    if (raw == null || raw === "") return "—";
    const num = Number(raw);
    return Number.isFinite(num) ? num.toLocaleString() : String(raw);
};

/**
 * Pure chart-body renderer extracted from BarChartCard (SRP).
 *
 * The five rendering states (error / loading / empty / truncation notice +
 * BarChart) used to live inline in a 280-line ternary nested inside the
 * card. Moving them here makes the card a thin shell again and keeps the
 * recharts wiring (axis flip, threshold lines, per-cell coloring, tooltip
 * lookup) co-located with the data shape it depends on.
 */
const BarChartBody = ({ error, loading, settings }) => {
    const {
        rows,
        chartRows,
        truncated,
        maxBars,
        xAxisKey,
        yAxisKeys,
        labelToIndex,
        isHorizontal,
        rechartsLayout,
        useCellColors,
        singleYMode,
        activeThresholds,
        activeIdx,
        setActiveIdx,
    } = settings;

    if (error) {
        return <div className='bc-state bc-error'>⚠️ 오류: {error}</div>;
    }
    if (loading) {
        return (
            <div className='bc-state'>
                <div className='bc-spinner' />
            </div>
        );
    }
    if (chartRows.length === 0) {
        return <div className='bc-state bc-empty'>데이터가 없습니다</div>;
    }

    return (
        <>
            {truncated && (
                <div className='bc-truncation-notice'>
                    상위 {maxBars.toLocaleString()}개 표시 중 (전체{" "}
                    {rows.length.toLocaleString()}개)
                </div>
            )}
            <ResponsiveContainer width='100%' height='100%' minWidth={0} minHeight={0}>
                <BarChart
                    layout={rechartsLayout}
                    data={chartRows}
                    margin={{ top: 6, right: 16, left: 0, bottom: truncated ? 0 : 4 }}
                    onMouseMove={(state) => {
                        // recharts 3.8.1 의 state.activeTooltipIndex 는
                        // String(clampedIndex) 로 반환되므로 Number 변환이 필요.
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
                    onMouseLeave={() => {
                        setActiveIdx(null);
                    }}
                >
                    <CartesianGrid
                        strokeDasharray='3 3'
                        stroke='rgba(255,255,255,0.06)'
                    />
                    {isHorizontal ? (
                        <>
                            <XAxis
                                type='number'
                                tick={{ fill: "#7a90a8", fontSize: 11 }}
                                tickLine={false}
                                axisLine={false}
                            />
                            <YAxis
                                type='category'
                                dataKey={xAxisKey}
                                tick={{ fill: "#7a90a8", fontSize: 11 }}
                                tickLine={false}
                                axisLine={{
                                    stroke: "rgba(255,255,255,0.08)",
                                }}
                                width={80}
                            />
                        </>
                    ) : (
                        <>
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
                        </>
                    )}
                    <Tooltip
                        cursor={{ fill: "rgba(255,255,255,0.04)" }}
                        content={(tooltipProps) => {
                            if (!tooltipProps?.active) return null;
                            // recharts payload 가 신뢰할 수 없다는 전제로,
                            // 우리가 직접 추적한 activeIdx 를 1순위로 사용하고,
                            // 그것이 없으면 label(카테고리 값)로 chartRows 에서
                            // row 를 찾아낸다.
                            const labelKey = xAxisKey;
                            const labelIdx =
                                labelKey &&
                                tooltipProps.label != null &&
                                tooltipProps.label !== ""
                                    ? labelToIndex.get(
                                          String(tooltipProps.label),
                                      ) ?? -1
                                    : -1;
                            const idx =
                                activeIdx != null
                                    ? activeIdx
                                    : labelIdx >= 0
                                      ? labelIdx
                                      : null;
                            if (idx == null || !chartRows[idx]) return null;
                            const row = chartRows[idx];
                            const labelValue = xAxisKey
                                ? row?.[xAxisKey]
                                : tooltipProps.label;
                            const items = (
                                tooltipProps.payload?.length
                                    ? tooltipProps.payload.map((p) => ({
                                          key:
                                              typeof p?.dataKey === "string"
                                                  ? p.dataKey
                                                  : p?.name,
                                          name: p?.name ?? p?.dataKey,
                                          color:
                                              p?.color ||
                                              p?.fill ||
                                              "#e2e8f0",
                                      }))
                                    : yAxisKeys.map((k, i) => ({
                                          key: k,
                                          name: k,
                                          color:
                                              CHART_COLORS[
                                                  i % CHART_COLORS.length
                                              ],
                                      }))
                            ).filter((it) => it.key);
                            return (
                                <div className='bc-tooltip'>
                                    {labelValue != null &&
                                        labelValue !== "" && (
                                            <div className='bc-tooltip-label'>
                                                {labelValue}
                                            </div>
                                        )}
                                    {items.map((it, i) => (
                                        <div
                                            key={`${it.key}-${i}`}
                                            className='bc-tooltip-item'
                                            style={{ color: it.color }}
                                        >
                                            {it.name}:{" "}
                                            {formatTooltipNumber(
                                                row?.[it.key],
                                            )}
                                        </div>
                                    ))}
                                </div>
                            );
                        }}
                    />
                    {activeThresholds.map((t, idx) => {
                        const numericValue = Number(t.value);
                        if (!Number.isFinite(numericValue)) return null;
                        const color =
                            THRESHOLD_COLORS[idx % THRESHOLD_COLORS.length];
                        // vertical bars (recharts layout="horizontal"):
                        //   value axis = Y  → horizontal threshold line (y=value)
                        // horizontal bars (recharts layout="vertical"):
                        //   value axis = X  → vertical threshold line (x=value)
                        const lineProps = isHorizontal
                            ? { x: numericValue }
                            : { y: numericValue };
                        return (
                            <ReferenceLine
                                key={`threshold-${idx}`}
                                {...lineProps}
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
                                    position: isHorizontal ? "top" : "right",
                                }}
                            />
                        );
                    })}
                    {yAxisKeys.length > 1 && (
                        <Legend
                            wrapperStyle={{
                                fontSize: 11,
                                color: "#7a90a8",
                                paddingTop: 2,
                            }}
                        />
                    )}
                    {yAxisKeys.map((key, i) =>
                        useCellColors ? (
                            // 소량 데이터: 막대별 개별 색상
                            // recharts 3.x: deprecated <Cell> + activeBar 조합은
                            // tooltip payload 가 첫 row 로 고정되는 버그가 있어
                            // shape render prop 으로 per-bar 색상을 적용한다.
                            //
                            // isAnimationActive={false} 이유:
                            // recharts 3.x 의 useAnimationId(props) 는 props 참조가
                            // 바뀔 때마다 animation id 를 갱신한다. BarChartBody 는
                            // setActiveIdx (마우스 이동마다 호출) 로 재렌더되므로
                            // 마우스를 움직일 때마다 애니메이션이 t=0 으로 리셋되어
                            // 막대 height=0 → Rectangle null 반환 → 막대 미표시.
                            // 애니메이션을 끄면 bars 가 즉시 최종 크기로 렌더된다.
                            <Bar
                                key={key}
                                dataKey={key}
                                isAnimationActive={false}
                                radius={
                                    isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]
                                }
                                maxBarSize={40}
                                activeBar={{
                                    fillOpacity: 0.75,
                                    stroke: "rgba(255,255,255,0.18)",
                                    strokeWidth: 1,
                                }}
                                shape={(barProps) => {
                                    const idx = barProps?.index ?? 0;
                                    return (
                                        <Rectangle
                                            {...barProps}
                                            fill={
                                                CHART_COLORS[
                                                    idx % CHART_COLORS.length
                                                ]
                                            }
                                        />
                                    );
                                }}
                            />
                        ) : (
                            // 대량 데이터: 단일/계열 색상
                            // (동일 이유로 isAnimationActive={false})
                            <Bar
                                key={key}
                                dataKey={key}
                                fill={CHART_COLORS[i % CHART_COLORS.length]}
                                isAnimationActive={false}
                                radius={
                                    isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]
                                }
                                maxBarSize={singleYMode ? 40 : 32}
                                activeBar={{
                                    fillOpacity: 0.75,
                                    stroke: "rgba(255,255,255,0.18)",
                                    strokeWidth: 1,
                                }}
                            />
                        ),
                    )}
                </BarChart>
            </ResponsiveContainer>
        </>
    );
};

export default BarChartBody;

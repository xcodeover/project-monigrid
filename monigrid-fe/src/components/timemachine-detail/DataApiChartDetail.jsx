import { useMemo } from "react";
import {
    LineChart, Line, BarChart, Bar,
    XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";

/**
 * DataApiChartDetail — 차트 위젯의 현재 시점 데이터 표시 + 1h sample 카운트
 *
 * Widget chartSettings use xAxisKey / yAxisKeys (array) — not xColumn/yColumn.
 * The plan's assumed shape was inaccurate; corrected here.
 *
 * BE timemachine payload shape (data_api):
 *   { data: [...], endpoint, title }
 */
export default function DataApiChartDetail({ widgetType, widget, currentPayload, series }) {
    // Extract rows from payload — handle { data: [...] } or plain array
    const data = useMemo(() => {
        if (Array.isArray(currentPayload?.data)) return currentPayload.data;
        if (Array.isArray(currentPayload)) return currentPayload;
        return [];
    }, [currentPayload]);

    // Use actual chartSettings field names (xAxisKey / yAxisKeys[0])
    // Fallback: use first two columns detected from data
    const detectedCols = useMemo(() => {
        const set = new Set();
        for (const r of data.slice(0, 20)) {
            Object.keys(r || {}).forEach((k) => set.add(k));
        }
        return Array.from(set);
    }, [data]);

    const xKey = widget?.chartSettings?.xAxisKey
        || widget?.lineChartSettings?.xColumn
        || widget?.barChartSettings?.xColumn
        || detectedCols[0]
        || "x";
    const yKeys = (widget?.chartSettings?.yAxisKeys?.length > 0)
        ? widget.chartSettings.yAxisKeys
        : (widget?.lineChartSettings?.yColumn
            ? [widget.lineChartSettings.yColumn]
            : (widget?.barChartSettings?.yColumn
                ? [widget.barChartSettings.yColumn]
                : detectedCols.filter((c) => c !== xKey).slice(0, 1)));
    const yKey = yKeys[0] || "y";

    const ChartCmp = widgetType === "bar-chart" ? BarChart : LineChart;
    const SeriesCmp = widgetType === "bar-chart" ? Bar : Line;

    const sampleRowCounts = (series || [])
        .map((s) => {
            const d = s?.payload?.data;
            return Array.isArray(d) ? d.length : 0;
        })
        .join(" / ");

    return (
        <>
            <div className="tdm-section">
                <h4>현재 시점의 차트 데이터</h4>
                <ResponsiveContainer width="100%" height={260}>
                    <ChartCmp data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey={xKey} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} />
                        <Tooltip contentStyle={{ background: "#1a2332", border: "1px solid #334155" }} />
                        <SeriesCmp dataKey={yKey} fill="#60a5fa" stroke="#60a5fa" dot={false} />
                    </ChartCmp>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>1시간 내 sample 카운트: {(series || []).length}건</h4>
                {sampleRowCounts && (
                    <p style={{ fontSize: 11, color: "#64748b" }}>
                        각 sample 시각에서의 row count: {sampleRowCounts}
                    </p>
                )}
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}

import { useMemo } from "react";
import { createPortal } from "react-dom";
import {
    Area,
    AreaChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import {
    DETAIL_COLORS,
    MAX_HISTORY,
    formatChartTime,
} from "./serverResourceHelpers";

/**
 * Real-time chart modal for a single server (SRP).
 *
 * Pure presentational — receives the server descriptor, the accumulated
 * history points, and an `onClose` callback. The history accumulation
 * itself stays in ServerResourceCard so this component does not need to
 * own a ref or know about polling.
 */

const DetailTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
        <div className='srv-detail-tooltip'>
            <div className='srv-detail-tooltip-time'>{formatChartTime(label)}</div>
            {payload.map((p) => (
                <div key={p.dataKey} className='srv-detail-tooltip-row'>
                    <span
                        className='srv-detail-tooltip-dot'
                        style={{ backgroundColor: p.color }}
                    />
                    <span className='srv-detail-tooltip-name'>{p.name}</span>
                    <span className='srv-detail-tooltip-val'>
                        {p.value != null ? `${p.value}%` : "-"}
                    </span>
                </div>
            ))}
        </div>
    );
};

const ServerDetailPopup = ({ server, history, onClose }) => {
    const data = history || [];
    const latestData = data.length > 0 ? data[data.length - 1] : null;

    // Collect all disk keys from history
    const diskKeys = useMemo(() => {
        const keys = new Set();
        data.forEach((pt) => {
            Object.keys(pt).forEach((k) => {
                if (k.startsWith("disk_")) keys.add(k);
            });
        });
        return [...keys].sort();
    }, [data]);

    const diskLabels = useMemo(() => {
        const map = {};
        diskKeys.forEach((k) => {
            map[k] = k.replace("disk_", "").toUpperCase();
        });
        return map;
    }, [diskKeys]);

    if (!server) return null;

    return createPortal(
        <div className='row-detail-overlay' onClick={onClose}>
            <div
                className='srv-detail-popup'
                onClick={(e) => e.stopPropagation()}
            >
                <div className='row-detail-header'>
                    <div>
                        <h5>{server.label || server.host}</h5>
                        <p>
                            {server.host}
                            {server.port ? `:${server.port}` : ""}
                        </p>
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>

                <div className='srv-detail-body'>
                    {/* CPU chart */}
                    <div className='srv-detail-chart-section'>
                        <div className='srv-detail-chart-header'>
                            <span
                                className='srv-detail-chart-title'
                                style={{ color: DETAIL_COLORS.cpu }}
                            >
                                CPU
                            </span>
                            {latestData?.cpu != null && (
                                <span
                                    className='srv-detail-chart-current'
                                    style={{ color: DETAIL_COLORS.cpu }}
                                >
                                    {latestData.cpu}%
                                </span>
                            )}
                        </div>
                        <div className='srv-detail-chart-wrap'>
                            <ResponsiveContainer width='100%' height={120}>
                                <AreaChart
                                    data={data}
                                    margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
                                >
                                    <defs>
                                        <linearGradient id='grad-cpu' x1='0' y1='0' x2='0' y2='1'>
                                            <stop offset='5%' stopColor={DETAIL_COLORS.cpu} stopOpacity={0.3} />
                                            <stop offset='95%' stopColor={DETAIL_COLORS.cpu} stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray='3 3' stroke='rgba(148,163,184,0.08)' />
                                    <XAxis dataKey='ts' tickFormatter={formatChartTime} tick={{ fontSize: 9, fill: "#64748b" }} />
                                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                                    <Tooltip content={<DetailTooltip />} />
                                    <Area type='monotone' dataKey='cpu' name='CPU' stroke={DETAIL_COLORS.cpu} fill='url(#grad-cpu)' strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Memory chart */}
                    <div className='srv-detail-chart-section'>
                        <div className='srv-detail-chart-header'>
                            <span
                                className='srv-detail-chart-title'
                                style={{ color: DETAIL_COLORS.memory }}
                            >
                                MEMORY
                            </span>
                            {latestData?.memory != null && (
                                <span
                                    className='srv-detail-chart-current'
                                    style={{ color: DETAIL_COLORS.memory }}
                                >
                                    {latestData.memory}%
                                </span>
                            )}
                        </div>
                        <div className='srv-detail-chart-wrap'>
                            <ResponsiveContainer width='100%' height={120}>
                                <AreaChart
                                    data={data}
                                    margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
                                >
                                    <defs>
                                        <linearGradient id='grad-mem' x1='0' y1='0' x2='0' y2='1'>
                                            <stop offset='5%' stopColor={DETAIL_COLORS.memory} stopOpacity={0.3} />
                                            <stop offset='95%' stopColor={DETAIL_COLORS.memory} stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray='3 3' stroke='rgba(148,163,184,0.08)' />
                                    <XAxis dataKey='ts' tickFormatter={formatChartTime} tick={{ fontSize: 9, fill: "#64748b" }} />
                                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                                    <Tooltip content={<DetailTooltip />} />
                                    <Area type='monotone' dataKey='memory' name='MEM' stroke={DETAIL_COLORS.memory} fill='url(#grad-mem)' strokeWidth={1.5} dot={false} isAnimationActive={false} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Disk chart(s) */}
                    {diskKeys.length > 0 && (
                        <div className='srv-detail-chart-section'>
                            <div className='srv-detail-chart-header'>
                                <span
                                    className='srv-detail-chart-title'
                                    style={{ color: DETAIL_COLORS.disk[0] }}
                                >
                                    DISK
                                </span>
                                {diskKeys.length === 1 && latestData?.[diskKeys[0]] != null && (
                                    <span
                                        className='srv-detail-chart-current'
                                        style={{ color: DETAIL_COLORS.disk[0] }}
                                    >
                                        {diskLabels[diskKeys[0]]}: {latestData[diskKeys[0]]}%
                                    </span>
                                )}
                                {diskKeys.length > 1 && (
                                    <span className='srv-detail-chart-current-multi'>
                                        {diskKeys.map((k, i) => (
                                            <span
                                                key={k}
                                                style={{
                                                    color: DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length],
                                                }}
                                            >
                                                {diskLabels[k]}: {latestData?.[k] ?? "-"}%
                                            </span>
                                        ))}
                                    </span>
                                )}
                            </div>
                            <div className='srv-detail-chart-wrap'>
                                <ResponsiveContainer width='100%' height={diskKeys.length > 1 ? 150 : 120}>
                                    <AreaChart
                                        data={data}
                                        margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
                                    >
                                        <defs>
                                            {diskKeys.map((k, i) => (
                                                <linearGradient key={k} id={`grad-${k}`} x1='0' y1='0' x2='0' y2='1'>
                                                    <stop offset='5%' stopColor={DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length]} stopOpacity={0.25} />
                                                    <stop offset='95%' stopColor={DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length]} stopOpacity={0} />
                                                </linearGradient>
                                            ))}
                                        </defs>
                                        <CartesianGrid strokeDasharray='3 3' stroke='rgba(148,163,184,0.08)' />
                                        <XAxis dataKey='ts' tickFormatter={formatChartTime} tick={{ fontSize: 9, fill: "#64748b" }} />
                                        <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                                        <Tooltip content={<DetailTooltip />} />
                                        {diskKeys.map((k, i) => (
                                            <Area
                                                key={k}
                                                type='monotone'
                                                dataKey={k}
                                                name={diskLabels[k]}
                                                stroke={DETAIL_COLORS.disk[i % DETAIL_COLORS.disk.length]}
                                                fill={`url(#grad-${k})`}
                                                strokeWidth={1.5}
                                                dot={false}
                                                isAnimationActive={false}
                                            />
                                        ))}
                                    </AreaChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}
                </div>

                <div className='row-detail-footer'>
                    <span className='row-detail-live-indicator'>
                        <span className='live-dot' />
                        실시간 반영 중
                    </span>
                    <span className='srv-detail-points'>
                        {data.length} / {MAX_HISTORY} points
                    </span>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default ServerDetailPopup;

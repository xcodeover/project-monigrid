import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * ServerResourceDetail — 1h CPU/MEM/DISK timeseries + criteria 임계선
 *
 * BE timemachine payload shape (monitor:server_resource):
 *   { data: { cpu: { usedPct }, memory: { usedPct }, disks: [{ usedPct }] },
 *     spec: { criteria: { cpu, memory, disk } }, label, ... }
 */
export default function ServerResourceDetail({ widget, series, currentPayload }) {
    // Extract points from series — handle both the plan's assumed shape and
    // the actual BE shape (nested under .data)
    const points = (series || []).map((it) => {
        const p = it.payload;
        // Actual BE shape: p.data.cpu.usedPct etc.
        const cpu = p?.data?.cpu?.usedPct ?? p?.cpuPercent ?? null;
        const mem = p?.data?.memory?.usedPct ?? p?.memPercent ?? null;
        const diskArr = p?.data?.disks;
        const disk = Array.isArray(diskArr) && diskArr.length > 0
            ? diskArr[0]?.usedPct ?? null
            : p?.diskPercent ?? null;
        return { ts: it.tsMs, cpu, mem, disk };
    });

    // Criteria from widget's serverConfig or from the current payload's spec
    const criteria = widget?.serverConfig?.criteria
        || currentPayload?.spec?.criteria
        || {};

    const recent = (series || []).slice(-5).reverse();

    return (
        <>
            <div className="tdm-section">
                <h4>CPU / Memory / Disk · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis domain={[0, 100]} stroke="#64748b" fontSize={10} unit="%" />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="cpu" stroke="#60a5fa" name="CPU" dot={false} />
                        <Line dataKey="mem" stroke="#a78bfa" name="MEM" dot={false} />
                        <Line dataKey="disk" stroke="#fbbf24" name="DISK" dot={false} />
                        {criteria?.cpu != null && (
                            <ReferenceLine y={criteria.cpu} stroke="#60a5fa" strokeDasharray="4 4" label="CPU 임계" />
                        )}
                        {criteria?.memory != null && (
                            <ReferenceLine y={criteria.memory} stroke="#a78bfa" strokeDasharray="4 4" label="MEM 임계" />
                        )}
                        {criteria?.disk != null && (
                            <ReferenceLine y={criteria.disk} stroke="#fbbf24" strokeDasharray="4 4" label="DISK 임계" />
                        )}
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>최근 5개 sample</h4>
                <table className="tdm-table">
                    <thead>
                        <tr><th>시각</th><th>CPU</th><th>MEM</th><th>DISK</th></tr>
                    </thead>
                    <tbody>
                        {recent.map((it) => {
                            const p = it.payload;
                            const cpu = p?.data?.cpu?.usedPct ?? p?.cpuPercent;
                            const mem = p?.data?.memory?.usedPct ?? p?.memPercent;
                            const diskArr = p?.data?.disks;
                            const disk = Array.isArray(diskArr) && diskArr.length > 0
                                ? diskArr[0]?.usedPct ?? null
                                : p?.diskPercent ?? null;
                            return (
                                <tr key={it.tsMs}>
                                    <td>{new Date(it.tsMs).toLocaleString()}</td>
                                    <td>{cpu != null ? cpu.toFixed(1) : "-"}%</td>
                                    <td>{mem != null ? mem.toFixed(1) : "-"}%</td>
                                    <td>{disk != null ? disk.toFixed(1) : "-"}%</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload (현재 시점)</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}

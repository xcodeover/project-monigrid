import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * NetworkDetail — RTT timeseries + recent table
 *
 * BE timemachine payload shape (monitor:network):
 *   { data: { responseTimeMs, success, type, host, message, error, ... },
 *     spec: { host, ... }, label, ... }
 */
export default function NetworkDetail({ series, currentPayload }) {
    const points = (series || []).map((it) => {
        const p = it.payload;
        // Actual BE shape: p.data.responseTimeMs / p.data.success
        // Fallback for old plan shape: p.rttMs / p.ok
        const rtt = p?.data?.responseTimeMs ?? p?.rttMs ?? null;
        const ok = p?.data?.success ?? p?.data?.ok ?? p?.ok ?? false;
        return { ts: it.tsMs, rtt, ok };
    });
    const recent = (series || []).slice(-10).reverse();

    return (
        <>
            <div className="tdm-section">
                <h4>응답 시간 (ms) · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} unit="ms" />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line
                            dataKey="rtt"
                            stroke="#22d3ee"
                            name="RTT"
                            dot={(p) => (
                                <circle
                                    key={p.key}
                                    cx={p.cx}
                                    cy={p.cy}
                                    r={3}
                                    fill={p.payload?.ok ? "#22d3ee" : "#ef4444"}
                                    stroke="none"
                                />
                            )}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>최근 10개 sample</h4>
                <table className="tdm-table">
                    <thead>
                        <tr><th>시각</th><th>OK</th><th>RTT (ms)</th><th>메시지</th></tr>
                    </thead>
                    <tbody>
                        {recent.map((it) => {
                            const p = it.payload;
                            const ok = p?.data?.success ?? p?.data?.ok ?? p?.ok ?? false;
                            const rtt = p?.data?.responseTimeMs ?? p?.rttMs ?? null;
                            const msg = p?.data?.message || p?.data?.error || p?.error || "-";
                            return (
                                <tr key={it.tsMs}>
                                    <td>{new Date(it.tsMs).toLocaleString()}</td>
                                    <td style={{ color: ok ? "#86efac" : "#fca5a5" }}>
                                        {ok ? "✓" : "✗"}
                                    </td>
                                    <td>{rtt ?? "-"}</td>
                                    <td>{String(msg).slice(0, 80)}</td>
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

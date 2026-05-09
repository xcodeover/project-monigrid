import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const codeColor = (code) => {
    if (code == null) return "#64748b";
    if (code < 300) return "#22c55e";
    if (code < 400) return "#60a5fa";
    if (code < 500) return "#fbbf24";
    return "#ef4444";
};

const formatTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * HttpStatusDetail — HTTP 응답 코드 + 응답 시간 시계열
 *
 * BE timemachine payload shape (monitor:http_status):
 *   { data: { httpStatus, responseTimeMs, ok, body, error }, spec: { url }, label, ... }
 */
export default function HttpStatusDetail({ series, currentPayload }) {
    const points = (series || []).map((it) => {
        const p = it.payload;
        // Actual BE shape: nested under .data
        const code = p?.data?.httpStatus ?? p?.httpStatus ?? null;
        const rt = p?.data?.responseTimeMs ?? p?.responseTimeMs ?? null;
        return { ts: it.tsMs, code, rt };
    });
    const recent = (series || []).slice(-10).reverse();

    return (
        <>
            <div className="tdm-section">
                <h4>HTTP 상태 코드 · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} domain={[0, 600]} ticks={[200, 300, 400, 500]} />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line
                            dataKey="code"
                            name="HTTP"
                            stroke="#94a3b8"
                            dot={(p) => (
                                <circle
                                    key={p.key}
                                    cx={p.cx}
                                    cy={p.cy}
                                    r={4}
                                    fill={codeColor(p.payload?.code)}
                                    stroke="none"
                                />
                            )}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>응답 시간 (ms)</h4>
                <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} unit="ms" />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="rt" stroke="#22d3ee" name="응답시간" dot={false} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>최근 10개 sample</h4>
                <table className="tdm-table">
                    <thead>
                        <tr><th>시각</th><th>코드</th><th>응답 시간</th><th>본문 일부</th></tr>
                    </thead>
                    <tbody>
                        {recent.map((it) => {
                            const p = it.payload;
                            const code = p?.data?.httpStatus ?? p?.httpStatus;
                            const rt = p?.data?.responseTimeMs ?? p?.responseTimeMs;
                            const body = p?.data?.body ?? p?.body ?? "";
                            return (
                                <tr key={it.tsMs}>
                                    <td>{new Date(it.tsMs).toLocaleString()}</td>
                                    <td style={{ color: codeColor(code) }}>
                                        {code ?? "-"}
                                    </td>
                                    <td>{rt != null ? `${rt} ms` : "-"}</td>
                                    <td title={String(body || "")}>
                                        {String(body || "").slice(0, 60)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
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

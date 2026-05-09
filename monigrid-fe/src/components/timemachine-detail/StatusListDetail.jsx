import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * StatusListDetail — OK/FAIL 카운트 시계열 + 현재 실패 항목 목록
 *
 * Used for both status-list and health-check widget types.
 *
 * For status-list: currentPayload has shape { items, okCount, failCount }
 * For health-check: currentPayload has shape { ok, httpStatus, responseTimeMs, body, ... }
 *
 * series items: { tsMs, payload } where payload follows the same shapes above.
 */
export default function StatusListDetail({ series, currentPayload }) {
    // Build timeseries points — handle both status-list and health-check payload shapes
    const points = (series || []).map((it) => {
        const p = it.payload;
        let ok = 0, fail = 0;
        if (p?.items != null) {
            // status-list shape
            ok = Number(p.okCount ?? 0);
            fail = Number(p.failCount ?? 0);
        } else if (p?.ok != null) {
            // health-check / single-item shape
            ok = p.ok === true ? 1 : 0;
            fail = p.ok === true ? 0 : 1;
        } else if (p?.data?.ok != null) {
            // http_status monitor shape
            ok = p.data.ok === true ? 1 : 0;
            fail = p.data.ok === true ? 0 : 1;
        }
        return { ts: it.tsMs, ok, fail };
    });

    // Current failed items — handle multiple payload shapes
    const failedNow = (() => {
        if (!currentPayload) return [];
        if (Array.isArray(currentPayload?.items)) {
            return currentPayload.items.filter((i) => !i.ok);
        }
        // health-check or http_status single item
        const ok = currentPayload?.ok ?? currentPayload?.data?.ok ?? true;
        if (!ok) {
            return [{
                label: currentPayload?.label || "—",
                url: currentPayload?.spec?.url || "",
                error: currentPayload?.errorMessage || currentPayload?.data?.error || "-",
            }];
        }
        return [];
    })();

    return (
        <>
            <div className="tdm-section">
                <h4>OK / FAIL 카운트 · 최근 1시간</h4>
                {points.length === 0 ? (
                    <p style={{ fontSize: 11, color: "#64748b" }}>
                        이 위젯 타입은 다중 타깃을 집계하므로 단일 시계열 조회가 지원되지 않습니다.
                    </p>
                ) : (
                    <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={points}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                            <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                            <YAxis stroke="#64748b" fontSize={10} />
                            <Tooltip
                                labelFormatter={(ms) => new Date(ms).toLocaleString()}
                                contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                            />
                            <Line dataKey="ok" stroke="#22c55e" name="OK" dot={false} />
                            <Line dataKey="fail" stroke="#ef4444" name="FAIL" dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                )}
            </div>
            <div className="tdm-section">
                <h4>현재 실패 항목 ({failedNow.length}개)</h4>
                {failedNow.length === 0 ? (
                    <p style={{ fontSize: 11, color: "#86efac" }}>현재 시점에 실패 항목 없음</p>
                ) : (
                    <table className="tdm-table">
                        <thead>
                            <tr><th>라벨</th><th>URL</th><th>오류</th></tr>
                        </thead>
                        <tbody>
                            {failedNow.slice(0, 20).map((it, i) => (
                                <tr key={i}>
                                    <td>{it.label || it.id || "-"}</td>
                                    <td title={it.url}>{String(it.url || "").slice(0, 40)}</td>
                                    <td>{it.error || "-"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
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

import { useMemo, useState } from "react";

/**
 * DataApiTableDetail — 현재 시점의 데이터 API 풀 테이블 + 검색
 *
 * BE timemachine payload shape (data_api):
 *   { data: [...], endpoint, title }
 * where data is the array of rows returned by the endpoint.
 */
export default function DataApiTableDetail({ currentPayload }) {
    const [filter, setFilter] = useState("");

    // Handle both { data: [...] } (actual BE shape) and plain array
    const rows = useMemo(() => {
        if (Array.isArray(currentPayload?.data)) return currentPayload.data;
        if (Array.isArray(currentPayload)) return currentPayload;
        return [];
    }, [currentPayload]);

    const columns = useMemo(() => {
        const set = new Set();
        for (const r of rows.slice(0, 50)) {
            Object.keys(r || {}).forEach((k) => set.add(k));
        }
        return Array.from(set);
    }, [rows]);

    const filtered = useMemo(() => {
        if (!filter.trim()) return rows;
        const q = filter.toLowerCase();
        return rows.filter((r) =>
            columns.some((c) => String(r?.[c] ?? "").toLowerCase().includes(q)),
        );
    }, [rows, columns, filter]);

    return (
        <>
            <div className="tdm-section">
                <h4>현재 시점의 데이터 ({filtered.length}/{rows.length} row)</h4>
                <input
                    className="tdm-filter"
                    placeholder="검색..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <div className="tdm-table-wrap">
                    <table className="tdm-table">
                        <thead>
                            <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
                        </thead>
                        <tbody>
                            {filtered.slice(0, 200).map((r, i) => (
                                <tr key={i}>
                                    {columns.map((c) => (
                                        <td key={c} title={String(r?.[c] ?? "")}>
                                            {String(r?.[c] ?? "")}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {filtered.length > 200 && (
                    <p style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
                        상위 200개만 표시 (필터로 좁혀 보세요)
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

import React from "react";

const formatDateTime = (value) => {
    if (!value) return "-";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return String(value);
    }
    const y = parsed.getFullYear();
    const M = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    const h = String(parsed.getHours()).padStart(2, "0");
    const m = String(parsed.getMinutes()).padStart(2, "0");
    const s = String(parsed.getSeconds()).padStart(2, "0");
    return `${y}-${M}-${d} ${h}:${m}:${s}`;
};

const getSeverityLabel = (level) => {
    const normalizedLevel = String(level || "").toLowerCase();
    if (normalizedLevel.includes("critical") || normalizedLevel.includes("error")) {
        return "HIGH";
    }
    if (normalizedLevel.includes("warn")) {
        return "MEDIUM";
    }
    return "LOW";
};

export default function IncidentTimelineCard({ incidents = [], loading = false, error = null, onRefresh }) {
    return (
        <section className='api-card'>
            <div className='api-card-header'>
                <div className='api-card-title-section'>
                    <div className='api-card-title-row'>
                        <h4>알림 이력</h4>
                        <div className='title-actions'>
                            <button
                                type='button'
                                className='compact-icon-btn'
                                onClick={onRefresh}
                                title='새로고침'
                            >
                                ⟳
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className='api-card-content'>
                {loading && <div>불러오는 중...</div>}
                {error && <div style={{ color: "#ff9b9b" }}>{error}</div>}

                {!loading && !error && incidents.length === 0 && (
                    <div>표시할 알림 이력이 없습니다.</div>
                )}

                {!loading && !error && incidents.length > 0 && (
                    <div style={{ overflow: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                                <tr>
                                    <th style={{ textAlign: "left", padding: "8px" }}>시간</th>
                                    <th style={{ textAlign: "left", padding: "8px" }}>서비스</th>
                                    <th style={{ textAlign: "left", padding: "8px" }}>레벨</th>
                                    <th style={{ textAlign: "left", padding: "8px" }}>메시지</th>
                                </tr>
                            </thead>
                            <tbody>
                                {incidents.map((item, index) => (
                                    <tr key={`${item.alert_id || item.id || "incident"}-${index}`}>
                                        <td style={{ padding: "8px" }}>
                                            {formatDateTime(item.timestamp || item.created_at)}
                                        </td>
                                        <td style={{ padding: "8px" }}>{item.app_name || item.service || "-"}</td>
                                        <td style={{ padding: "8px" }}>
                                            {getSeverityLabel(item.level || item.severity)}
                                        </td>
                                        <td style={{ padding: "8px" }}>{item.message || "-"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </section>
    );
}
import { useEffect, useState } from "react";
import { IconClose } from "./icons";
import { timemachineService } from "../services/api";
import ServerResourceDetail from "./timemachine-detail/ServerResourceDetail";
import NetworkDetail from "./timemachine-detail/NetworkDetail";
import HttpStatusDetail from "./timemachine-detail/HttpStatusDetail";
import DataApiTableDetail from "./timemachine-detail/DataApiTableDetail";
import DataApiChartDetail from "./timemachine-detail/DataApiChartDetail";
import StatusListDetail from "./timemachine-detail/StatusListDetail";
import "./TimemachineDetailModal.css";

const WINDOW_HOURS = 1;

const renderDetailBody = (widgetType, props) => {
    switch (widgetType) {
        case "server-resource": return <ServerResourceDetail {...props} />;
        case "network-test":    return <NetworkDetail {...props} />;
        case "http-status":     return <HttpStatusDetail {...props} />;
        case "table":           return <DataApiTableDetail {...props} />;
        case "line-chart":
        case "bar-chart":       return <DataApiChartDetail {...props} widgetType={widgetType} />;
        case "status-list":
        case "health-check":    return <StatusListDetail {...props} />;
        default:                return <pre>{JSON.stringify(props.currentPayload, null, 2)}</pre>;
    }
};

export default function TimemachineDetailModal({
    widget, atMs, sourceType, sourceId, currentPayload, onClose,
}) {
    const [series, setSeries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!atMs || !sourceType || !sourceId) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        const ac = new AbortController();
        const halfWin = WINDOW_HOURS * 3600_000 / 2;
        (async () => {
            setLoading(true);
            try {
                const data = await timemachineService.queryRange({
                    sourceType, sourceId,
                    from: atMs - halfWin, to: atMs + halfWin, limit: 500,
                }, { signal: ac.signal });
                if (!cancelled) setSeries(data?.items ?? []);
            } catch (e) {
                if (!cancelled && e?.name !== "CanceledError" && e?.name !== "AbortError") {
                    setError(e?.message || "series 조회 실패");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; ac.abort(); };
    }, [atMs, sourceType, sourceId]);

    const widgetType = widget?.type || "table";
    const title = widget?.title || widget?.name || sourceId || "Detail";

    return (
        <div className="tdm-overlay" onClick={onClose}>
            <div className="tdm-modal" onClick={(e) => e.stopPropagation()}>
                <header className="tdm-header">
                    <h3>{title}</h3>
                    <button type="button" className="tdm-close" onClick={onClose} aria-label="닫기">
                        <IconClose size={14} />
                    </button>
                </header>
                <div className="tdm-body">
                    {loading && <div className="tdm-loading">조회 중…</div>}
                    {error && <div className="tdm-error">{error}</div>}
                    {!loading && !error && renderDetailBody(widgetType, {
                        widget, atMs, series: series ?? [], currentPayload,
                    })}
                </div>
            </div>
        </div>
    );
}

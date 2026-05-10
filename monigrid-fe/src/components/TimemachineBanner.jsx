import { useTimemachine } from "../contexts/TimemachineContext";
import "./TimemachineBanner.css";

const formatLocal = (ms) => {
    if (ms == null) return "—";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export default function TimemachineBanner() {
    const tm = useTimemachine();
    if (!tm.enabled) return null;
    return (
        <div className="tm-banner" role="status" aria-live="polite">
            <span className="tm-banner-icon" aria-hidden>⏪</span>
            <span className="tm-banner-label">TIMEMACHINE MODE</span>
            <span className="tm-banner-sep">·</span>
            <span className="tm-banner-ts">{formatLocal(tm.atMs)}</span>
            {tm.loading && <span className="tm-banner-loading">조회 중…</span>}
            {tm.error && <span className="tm-banner-error">{tm.error}</span>}
            <button
                type="button"
                className="tm-banner-live-btn"
                onClick={tm.disable}
                title="LIVE 모드로 복귀"
            >
                LIVE 로 복귀
            </button>
        </div>
    );
}

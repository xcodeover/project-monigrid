import { useEffect, useState } from "react";
import { useTimemachine } from "../contexts/TimemachineContext";
import "./TimemachineControlBar.css";

const dateToInput = (ms) => {
    if (ms == null) return "";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const inputToMs = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
};

export default function TimemachineControlBar() {
    const tm = useTimemachine();
    const [localInput, setLocalInput] = useState(() => dateToInput(tm.atMs));

    useEffect(() => {
        setLocalInput(dateToInput(tm.atMs));
    }, [tm.atMs]);

    // Keyboard shortcuts — Space, ArrowLeft/Right, Esc
    useEffect(() => {
        if (!tm.enabled) return;
        const onKey = (e) => {
            // Don't fire when user is typing in an input/textarea
            if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA" || e.target?.tagName === "SELECT") return;
            if (e.key === " ") {
                e.preventDefault();
                tm.setPlaying(!tm.playing);
            } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                const delta = e.shiftKey ? -5 * tm.frameSizeMs : -tm.frameSizeMs;
                tm.setAtMs((tm.atMs ?? Date.now()) + delta);
            } else if (e.key === "ArrowRight") {
                e.preventDefault();
                const delta = e.shiftKey ? 5 * tm.frameSizeMs : tm.frameSizeMs;
                tm.setAtMs((tm.atMs ?? Date.now()) + delta);
            } else if (e.key === "Escape") {
                tm.disable();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tm.enabled, tm.playing, tm.atMs, tm.frameSizeMs, tm.setPlaying, tm.setAtMs, tm.disable]);

    if (!tm.enabled) return null;

    const earliest = tm.earliestMs ?? Date.now() - 24 * 3600_000;
    const latest = tm.latestMs ?? Date.now();
    const safeAt = tm.atMs ?? latest;

    const onScrubber = (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) tm.setAtMs(v);
    };

    const onInputCommit = () => {
        const ms = inputToMs(localInput);
        if (ms != null) tm.setAtMs(ms);
    };

    return (
        <div className="tm-controlbar">
            <button
                type="button"
                className="tm-cb-mode-btn tm-cb-mode-btn-live"
                onClick={tm.disable}
                title="LIVE 모드로 복귀 (Esc)"
            >
                <span className="tm-cb-mode-dot" aria-hidden />
                LIVE
            </button>
            <div className="tm-cb-left">
                <label className="tm-cb-label">시점</label>
                <input
                    type="datetime-local"
                    value={localInput}
                    onChange={(e) => setLocalInput(e.target.value)}
                    onBlur={onInputCommit}
                    onKeyDown={(e) => e.key === "Enter" && onInputCommit()}
                    className="tm-cb-datetime"
                />
            </div>
            <div className="tm-cb-playback">
                <button
                    type="button"
                    className="tm-cb-play"
                    onClick={() => tm.setPlaying(!tm.playing)}
                    title={tm.playing ? "일시정지 (Space)" : "재생 (Space)"}
                    aria-label={tm.playing ? "일시정지" : "재생"}
                >{tm.playing ? "⏸" : "▶"}</button>
                <select
                    className="tm-cb-select"
                    value={tm.speed}
                    onChange={(e) => tm.setSpeed(Number(e.target.value))}
                    title="재생 속도"
                >
                    <option value={1}>1x</option>
                    <option value={2}>2x</option>
                    <option value={5}>5x</option>
                    <option value={10}>10x</option>
                </select>
                <select
                    className="tm-cb-select"
                    value={tm.frameSizeMs}
                    onChange={(e) => tm.setFrameSizeMs(Number(e.target.value))}
                    title="프레임 간격 (한 tick 당 진행)"
                >
                    <option value={5_000}>5s</option>
                    <option value={10_000}>10s</option>
                    <option value={30_000}>30s</option>
                    <option value={60_000}>1m</option>
                    <option value={600_000}>10m</option>
                    <option value={1_800_000}>30m</option>
                </select>
            </div>
            <div className="tm-cb-center">
                <input
                    type="range"
                    className="tm-cb-scrubber"
                    min={earliest}
                    max={latest}
                    step={1000}
                    value={safeAt}
                    onChange={onScrubber}
                />
            </div>
            <div className="tm-cb-right">
                <span className="tm-cb-tm-indicator" title="타임머신 모드 (과거 시점 데이터)">
                    <span className="tm-cb-tm-dot" aria-hidden />
                    TimeMachine
                </span>
            </div>
        </div>
    );
}

/**
 * Floating entry button — 라이브 모드에서 좌측 하단에 떠 있고, 클릭하면
 * TimemachineControlBar 가 등장하면서 그 안의 LIVE 복귀 버튼이 같은 위치에
 * 자리잡는다 (사용자 mental model: 한 자리에서 토글).
 */
export function TimemachineEntryButton() {
    const tm = useTimemachine();
    if (tm.enabled) return null;
    return (
        <button
            type="button"
            className="tm-entry-btn"
            onClick={() => tm.enable()}
            title="타임머신 모드 진입 — 과거 시점의 대시보드 데이터를 볼 수 있어요"
        >
            <span className="tm-entry-icon" aria-hidden>⏪</span>
            TimeMachine
        </button>
    );
}

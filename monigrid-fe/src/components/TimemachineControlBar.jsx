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

    if (!tm.enabled) return null;

    const earliest = tm.earliestMs ?? Date.now() - 24 * 3600_000;
    const latest = tm.latestMs ?? Date.now();
    const safeAt = tm.atMs ?? latest;

    const step = (deltaMs) => {
        let next = (tm.atMs ?? latest) + deltaMs;
        if (next < earliest) next = earliest;
        if (next > latest) next = latest;
        tm.setAtMs(next);
    };

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
                <button type="button" className="tm-cb-step" onClick={() => step(-3600_000)} title="-1h">-1h</button>
                <button type="button" className="tm-cb-step" onClick={() => step(-900_000)} title="-15m">-15m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(-300_000)} title="-5m">-5m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(300_000)} title="+5m">+5m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(900_000)} title="+15m">+15m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(3600_000)} title="+1h">+1h</button>
                <button
                    type="button"
                    className="tm-cb-live"
                    onClick={tm.disable}
                    title="LIVE 모드로 복귀"
                >LIVE</button>
            </div>
        </div>
    );
}

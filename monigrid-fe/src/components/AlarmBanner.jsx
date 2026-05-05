/**
 * AlarmBanner: fixed top bar shown when any widget is in "dead" state.
 * Plays a Web Audio API beep on alarm. Admin can acknowledge or toggle sound.
 */
import React, { useEffect, useRef, useCallback, useMemo } from "react";
import { useAlarmStore } from "../store/alarmStore.js";
import "./AlarmBanner.css";

// 모듈 단위 단일 AudioContext 인스턴스.
// 매 호출마다 새 AudioContext를 만들면 브라우저당 인스턴스 한도(Chrome ≈ 6)에
// 빠르게 도달하여 알람이 더 이상 울리지 않게 된다 (메모리/리소스 누수).
let _sharedAudioCtx = null;
const getAudioCtx = () => {
    if (_sharedAudioCtx) {
        // 자동재생 정책으로 suspended 상태일 수 있음 — 사용자 인터랙션 후 resume 시도
        if (_sharedAudioCtx.state === "suspended") {
            _sharedAudioCtx.resume().catch(() => {});
        }
        return _sharedAudioCtx;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    _sharedAudioCtx = new Ctor();
    return _sharedAudioCtx;
};

const playSound = (type = "beep") => {
    try {
        const ctx = getAudioCtx();
        if (!ctx) return;

        if (type === "siren") {
            // 사이렌: 300→1400→300 Hz 넓은 범위 스윕 × 3회, sawtooth (거친 경보음)
            [0, 0.62, 1.24].forEach((offset) => {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = "sawtooth";
                osc.frequency.setValueAtTime(300, ctx.currentTime + offset);
                osc.frequency.linearRampToValueAtTime(1400, ctx.currentTime + offset + 0.3);
                osc.frequency.linearRampToValueAtTime(300, ctx.currentTime + offset + 0.58);
                gain.gain.setValueAtTime(0.15, ctx.currentTime + offset);
                gain.gain.setValueAtTime(0.15, ctx.currentTime + offset + 0.52);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.6);
                osc.start(ctx.currentTime + offset);
                osc.stop(ctx.currentTime + offset + 0.62);
            });
        } else if (type === "pulse") {
            // 펄스: 1200 Hz 짧은 sine 5회 급속 연속 (심박 모니터/긴급 경보)
            [0, 0.13, 0.26, 0.39, 0.52].forEach((start) => {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = "sine";
                osc.frequency.value = 1200;
                gain.gain.setValueAtTime(0.18, ctx.currentTime + start);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.08);
                osc.start(ctx.currentTime + start);
                osc.stop(ctx.currentTime + start + 0.09);
            });
        } else {
            // beep (기본): 맑은 sine 단음 2회 (알림벨 스타일)
            [0, 0.38].forEach((start) => {
                const osc  = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.type = "sine";
                osc.frequency.value = 1000;
                gain.gain.setValueAtTime(0.18, ctx.currentTime + start);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + 0.28);
                osc.start(ctx.currentTime + start);
                osc.stop(ctx.currentTime + start + 0.29);
            });
        }
    } catch {
        // AudioContext not available (e.g. no user interaction yet)
    }
};

const AlarmBanner = () => {
    const alarmedWidgets = useAlarmStore((s) => s.alarmedWidgets);
    const acknowledged   = useAlarmStore((s) => s.acknowledged);
    const soundEnabled   = useAlarmStore((s) => s.soundEnabled);
    const alarmSound     = useAlarmStore((s) => s.alarmSound);
    const acknowledgeAlarm = useAlarmStore((s) => s.acknowledgeAlarm);
    const setSoundEnabled  = useAlarmStore((s) => s.setSoundEnabled);

    const isAlarming = alarmedWidgets.size > 0;
    const beepTimerRef = useRef(null);
    // Tracks the sorted join-key of the last alarm set that was processed.
    // Using a string key (instead of size) ensures member-swap detection:
    // e.g. A→B with equal size produces a different key → effect re-fires.
    const lastAlarmKeyRef = useRef("");
    const alarmSoundRef = useRef(alarmSound);
    alarmSoundRef.current = alarmSound;

    // Stable string key derived from Set members — sort() makes it
    // deterministic regardless of insertion order or browser iteration order.
    const alarmKey = useMemo(
        () => Array.from(alarmedWidgets).sort().join(","),
        [alarmedWidgets],
    );

    const stopBeepLoop = useCallback(() => {
        if (beepTimerRef.current) {
            clearInterval(beepTimerRef.current);
            beepTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!isAlarming || acknowledged || !soundEnabled) {
            stopBeepLoop();
            return;
        }

        // New alarm triggered when the member set has changed (includes
        // member-swap: same size but different widgets, e.g. ack A + B goes dead).
        const newAlarm = alarmKey !== lastAlarmKeyRef.current;
        if (newAlarm || !beepTimerRef.current) {
            playSound(alarmSoundRef.current);
            stopBeepLoop();
            beepTimerRef.current = setInterval(() => playSound(alarmSoundRef.current), 8000);
        }
        lastAlarmKeyRef.current = alarmKey;

        return stopBeepLoop;
    }, [isAlarming, acknowledged, soundEnabled, alarmKey, stopBeepLoop]);

    // Memoise the formatted alarm list so the spread + slice + join doesn't
    // run on every render of the parent (this banner re-renders whenever
    // any dashboard widget updates).
    const widgetList = useMemo(
        () => [...alarmedWidgets].slice(0, 5).join(", "),
        [alarmedWidgets],
    );
    const extra = alarmedWidgets.size > 5 ? ` 외 ${alarmedWidgets.size - 5}개` : "";

    if (!isAlarming) return null;

    return (
        <div className={`alarm-banner${acknowledged ? " muted" : ""}`}>
            <span className="alarm-icon">{acknowledged ? "🔕" : "🚨"}</span>

            <span className="alarm-message">
                {acknowledged
                    ? "알람 인지됨 — 장애가 복구되면 자동 해제됩니다."
                    : `${alarmedWidgets.size}개 알람이 발생하였습니다.`}
                <span className="alarm-widgets">
                    ({widgetList}{extra})
                </span>
            </span>

            {!acknowledged && (
                <button
                    className="alarm-btn"
                    onClick={acknowledgeAlarm}
                    title="알람 인지 (소리 중지)"
                >
                    ✓ 인지
                </button>
            )}

            <button
                className="alarm-btn sound-toggle"
                onClick={() => setSoundEnabled(!soundEnabled)}
                title={soundEnabled ? "소리 끄기" : "소리 켜기"}
            >
                {soundEnabled ? "🔊" : "🔇"}
            </button>
        </div>
    );
};

export default AlarmBanner;

/**
 * AlarmBanner: fixed top bar shown when any widget is in "dead" state.
 * Plays a Web Audio API beep on alarm. Admin can acknowledge or toggle sound.
 */
import React, { lazy, Suspense, useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useAlarmStore } from "../store/alarmStore.js";
import { useDashboardStore } from "../store/dashboardStore.js";
import { useAuthStore } from "../store/authStore.js";
import "./AlarmBanner.css";

// Lazy: SendAlertNowModal pulls in extra services we only need on click.
const SendAlertNowModal = lazy(() => import("./SendAlertNowModal.jsx"));

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
    // widget id → 표시용 라벨. 같은 dashboardStore 를 다른 컴포넌트도 구독하지만
    // 셀렉터로 widgets 만 뽑으면 다른 키 변경 시 재렌더되지 않는다.
    const widgets = useDashboardStore((s) => s.widgets);

    const isAlarming = alarmedWidgets.size > 0;
    const beepTimerRef = useRef(null);
    const user = useAuthStore((s) => s.user);
    const isAdmin = user?.role === "admin"
        || String(user?.username || "").trim().toLowerCase() === "admin";
    const [sendNowOpen, setSendNowOpen] = useState(false);
    // Tracks the sorted join-key of the last alarm set that was processed.
    // Using a string key (instead of size) ensures member-swap detection:
    // e.g. A→B with equal size produces a different key → effect re-fires.
    // NOTE: alarmStore.reportWidgetStatus 가 alarmedWidgets 가 비면 acknowledged 를 false 로
    // reset 한다는 계약에 의존. 그 규칙이 바뀌면 ack-then-replacement 시나리오가 silent 하게 깨짐.
    const lastAlarmKeyRef = useRef("");
    const alarmSoundRef = useRef(alarmSound);
    alarmSoundRef.current = alarmSound;

    // Stable string key derived from Set members — sort() makes it
    // deterministic regardless of insertion order or browser iteration order.
    const alarmKey = useMemo(
        () => Array.from(alarmedWidgets).sort().join("|"),
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

    // widget id 대신 사용자에게 의미 있는 위젯 타이틀을 표시. 매핑 실패
    // (예: alarmedWidgets 에 있는 id 가 widgets 에서 사라진 경우) 시 id 그대로
    // 표시해서 디버깅 단서를 남긴다.
    const widgetList = useMemo(() => {
        const titleById = new Map(
            (widgets || []).map((w) => [w.id, w.title || w.id]),
        );
        return [...alarmedWidgets]
            .slice(0, 5)
            .map((id) => titleById.get(id) || id)
            .join(", ");
    }, [alarmedWidgets, widgets]);
    const extra = alarmedWidgets.size > 5 ? ` 외 ${alarmedWidgets.size - 5}개` : "";

    if (!isAlarming) return null;

    return (
        <>
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

            {isAdmin && (
                <button
                    className="alarm-btn"
                    onClick={() => setSendNowOpen(true)}
                    title="활성 알람을 즉시 메일로 발송"
                >
                    📧 메일 보내기
                </button>
            )}

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

        {sendNowOpen && (
            <Suspense fallback={null}>
                <SendAlertNowModal open={sendNowOpen} onClose={() => setSendNowOpen(false)} />
            </Suspense>
        )}
        </>
    );
};

export default AlarmBanner;

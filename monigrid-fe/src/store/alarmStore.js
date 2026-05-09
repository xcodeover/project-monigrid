/**
 * AlarmStore (SRP): tracks widget alarm state and sound mute preference.
 * DashboardPage calls reportWidgetStatus() after each widget poll result.
 */
import { create } from "zustand";
import { STORAGE_KEYS } from "./storageKeys.js";

const SOUND_TYPES = ["beep", "siren", "pulse"];
export { SOUND_TYPES };

const loadSoundEnabled = () => {
    try {
        const v = localStorage.getItem("alarm_sound_enabled");
        return v === null ? true : v !== "false";
    } catch {
        return true;
    }
};

const loadAlarmSound = () => {
    try {
        const v = localStorage.getItem("alarm_sound_type");
        return SOUND_TYPES.includes(v) ? v : "beep";
    } catch {
        return "beep";
    }
};

export const useAlarmStore = create((set, get) => ({
    // Set of widget IDs currently in alarm state
    alarmedWidgets: new Set(),
    // Whether the admin has acknowledged (silenced) the current alarm
    acknowledged: false,
    // Whether sound is globally enabled
    soundEnabled: loadSoundEnabled(),
    // Selected alarm sound type
    alarmSound: loadAlarmSound(),

    /** Per-widget immediate "dead" signal from card-level state.
     *
     * Phase 2 contract:
     *   - status === "dead"  → add the widget id (covers the 5s gap until
     *                           the next BE active-alerts poll fires).
     *   - status === "live"  → NO-OP. Clearing is the sole responsibility of
     *                           ``syncAlarmedWidgets`` (BE polling), so a
     *                           card-level "live" report never silently
     *                           drops a BE-raised alarm.
     *
     * Why no-op for "live":
     *   ServerResourceCard / NetworkTestCard call onAlarmChange on every
     *   data tick with their own evaluation. Before this contract change,
     *   a card-level "live" instantly removed the widget id from the alarm
     *   set even when the BE evaluator had just raised it — the footer
     *   AlarmBanner would never appear. BE is the single source of truth
     *   for alarm state since Phase 2.
     *
     * IMPORTANT: this function is still called on every poll. We must
     * return the same state object (no new Set) in the no-op case;
     * otherwise subscribers see a fresh Set reference and re-render in a
     * loop (the original NetworkTestCard regression).
     */
    reportWidgetStatus: (widgetId, status) => {
        set((state) => {
            if (status !== "dead") {
                // "live" / unknown / etc. — clear path is owned by syncAlarmedWidgets.
                return state;
            }
            if (state.alarmedWidgets.has(widgetId)) {
                return state;
            }
            const next = new Set(state.alarmedWidgets);
            next.add(widgetId);
            return { ...state, alarmedWidgets: next };
        });
    },

    /** Phase 2: BE alert evaluator emits raise/clear transitions and exposes the
     * current active set via `/dashboard/alerts/active`. DashboardPage polls
     * that endpoint, maps source ids to widget ids, and pushes the resulting
     * Set here. Avoids the FE re-evaluating thresholds locally.
     *
     * Same no-op rule as reportWidgetStatus: if the membership is unchanged we
     * MUST return the same state object so subscribers don't see a fresh Set
     * reference and re-render in a loop.
     */
    syncAlarmedWidgets: (incoming) => {
        set((state) => {
            const next = incoming instanceof Set
                ? incoming
                : new Set(Array.isArray(incoming) ? incoming : []);
            const prev = state.alarmedWidgets;
            if (prev.size === next.size) {
                let same = true;
                for (const id of prev) {
                    if (!next.has(id)) { same = false; break; }
                }
                if (same) return state;
            }
            const wasAlarming = prev.size > 0;
            const isAlarmingNow = next.size > 0;
            const shouldResetAck = wasAlarming && !isAlarmingNow;
            return {
                alarmedWidgets: next,
                acknowledged: shouldResetAck ? false : state.acknowledged,
            };
        });
    },

    /** Admin clicks "Acknowledge" — silences the sound for current alarms. */
    acknowledgeAlarm: () => set({ acknowledged: true }),

    /** Toggle sound on/off globally. */
    setSoundEnabled: (enabled) => {
        localStorage.setItem("alarm_sound_enabled", String(enabled));
        set({ soundEnabled: enabled });
    },

    /** Change alarm sound type. */
    setAlarmSound: (sound) => {
        const value = SOUND_TYPES.includes(sound) ? sound : "beep";
        localStorage.setItem("alarm_sound_type", value);
        set({ alarmSound: value });
    },

    get isAlarming() {
        return get().alarmedWidgets.size > 0;
    },
}));

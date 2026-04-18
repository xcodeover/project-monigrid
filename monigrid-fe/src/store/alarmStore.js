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

    /** Called by DashboardPage on every widget result update.
     *
     * IMPORTANT: this function is invoked on every poll — including widgets
     * that are reporting the same "live" status they already had. We MUST
     * return the same state object (no new Set) in the no-op case; otherwise
     * subscribers to `alarmedWidgets` see a fresh Set reference on every call
     * and re-render in an infinite loop (seen with NetworkTestCard calling
     * onAlarmChange from within its own effect). */
    reportWidgetStatus: (widgetId, status) => {
        set((state) => {
            const shouldAlarm = status === "dead";
            const wasAlarming = state.alarmedWidgets.has(widgetId);
            if (shouldAlarm === wasAlarming) {
                // Membership unchanged → return the exact same state object
                // so zustand skips the rerender.
                return state;
            }

            const next = new Set(state.alarmedWidgets);
            if (shouldAlarm) {
                next.add(widgetId);
            } else {
                next.delete(widgetId);
            }
            // If a previously-dead widget recovers and the alarm set goes empty,
            // reset acknowledgement so the next alarm triggers sound again.
            const shouldResetAck = wasAlarming && !shouldAlarm && next.size === 0;
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

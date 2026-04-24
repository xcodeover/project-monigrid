import { create } from "zustand";
import { STORAGE_KEYS } from "./storageKeys.js";
import { preferencesService } from "../services/dashboardService.js";

const DEFAULT_DASHBOARD_SETTINGS = {
    widgetFontSize: 13,
};

// ── Storage helpers (DRY) ─────────────────────────────────────────────────────

const readJson = (key, fallback) => {
    try {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored) : fallback;
    } catch {
        return fallback;
    }
};

const writeJson = (key, value) => {
    localStorage.setItem(key, JSON.stringify(value));
};

// ── Server sync ──────────────────────────────────────────────────────────────
//
// Preferences are persisted on the BE keyed by username so users keep the
// same dashboard across devices / A-A nodes. localStorage remains the
// offline cache and the seed for the first render (before the server
// round-trip completes).
//
// Writes are debounced: pushing on every mutation would hammer the API
// during layout drags (react-grid-layout fires many onLayoutChange calls
// in a short window).

const PUSH_DEBOUNCE_MS = 400;
let pushTimer = null;
let pushPromise = Promise.resolve();
let serverSyncEnabled = false;

const setServerSyncEnabled = (enabled) => {
    serverSyncEnabled = !!enabled;
    if (!enabled && pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
    }
};

const snapshotForServer = (state) => ({
    widgets: state.widgets ?? [],
    layouts: state.layouts ?? {},
    dashboardSettings: state.dashboardSettings ?? DEFAULT_DASHBOARD_SETTINGS,
});

const queueServerPush = () => {
    if (!serverSyncEnabled) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        const state = useDashboardStore.getState();
        pushPromise = preferencesService.save(snapshotForServer(state)).catch((err) => {
            // Intentional: survive transient network errors without dropping
            // local state. localStorage already has the latest, so the next
            // successful push or sync will reconcile.
            if (typeof console !== "undefined") {
                console.warn("[dashboardStore] preferences push failed:", err?.message || err);
            }
        });
    }, PUSH_DEBOUNCE_MS);
};

// ── Initial state loader ──────────────────────────────────────────────────────

const loadInitialState = () => ({
    widgets: (() => {
        const parsed = readJson(STORAGE_KEYS.WIDGETS, null);
        return Array.isArray(parsed) ? parsed : null;
    })(),
    layouts: readJson(STORAGE_KEYS.LAYOUTS, {}),
    dashboardSettings: {
        ...DEFAULT_DASHBOARD_SETTINGS,
        ...readJson(STORAGE_KEYS.DASHBOARD_SETTINGS, {}),
    },
});

// ── Store ─────────────────────────────────────────────────────────────────────

export const useDashboardStore = create((set) => ({
    ...loadInitialState(),

    setWidgets: (widgets) => {
        writeJson(STORAGE_KEYS.WIDGETS, widgets);
        set({ widgets });
        queueServerPush();
    },

    addWidget: (widget) => {
        set((state) => {
            const widgets = [...(state.widgets ?? []), widget];
            writeJson(STORAGE_KEYS.WIDGETS, widgets);
            return { widgets };
        });
        queueServerPush();
    },

    updateWidget: (widgetId, updates) => {
        set((state) => {
            const widgets = (state.widgets ?? []).map((widget) =>
                widget.id === widgetId
                    ? {
                          ...widget,
                          ...updates,
                          tableSettings: { ...widget.tableSettings, ...updates.tableSettings },
                          chartSettings: { ...widget.chartSettings, ...updates.chartSettings },
                          serverConfig: updates.serverConfig !== undefined
                              ? updates.serverConfig
                              : widget.serverConfig,
                          networkConfig: updates.networkConfig !== undefined
                              ? updates.networkConfig
                              : widget.networkConfig,
                      }
                    : widget,
            );
            writeJson(STORAGE_KEYS.WIDGETS, widgets);
            return { widgets };
        });
        queueServerPush();
    },

    removeWidget: (widgetId) => {
        set((state) => {
            const widgets = (state.widgets ?? []).filter((w) => w.id !== widgetId);
            const layouts = Object.fromEntries(
                Object.entries(state.layouts).filter(([key]) => key !== widgetId),
            );
            writeJson(STORAGE_KEYS.WIDGETS, widgets);
            writeJson(STORAGE_KEYS.LAYOUTS, layouts);
            return { widgets, layouts };
        });
        queueServerPush();
    },

    saveLayout: (apiId, layout) => {
        set((state) => {
            const newLayouts = { ...state.layouts, [apiId]: layout };
            writeJson(STORAGE_KEYS.LAYOUTS, newLayouts);
            return { layouts: newLayouts };
        });
        queueServerPush();
    },

    saveLayouts: (layoutMap) => {
        writeJson(STORAGE_KEYS.LAYOUTS, layoutMap);
        set({ layouts: layoutMap });
        queueServerPush();
    },

    updateLayout: (apiId, layout) => {
        set((state) => {
            const newLayouts = { ...state.layouts, [apiId]: { ...state.layouts[apiId], ...layout } };
            writeJson(STORAGE_KEYS.LAYOUTS, newLayouts);
            return { layouts: newLayouts };
        });
        queueServerPush();
    },

    clearLayouts: () => {
        localStorage.removeItem(STORAGE_KEYS.LAYOUTS);
        set({ layouts: {} });
        queueServerPush();
    },

    getLayout: (apiId) => {
        return useDashboardStore.getState().layouts[apiId] || null;
    },

    setDashboardSettings: (nextSettings) => {
        set((state) => {
            const merged = { ...state.dashboardSettings, ...nextSettings };
            writeJson(STORAGE_KEYS.DASHBOARD_SETTINGS, merged);
            return { dashboardSettings: merged };
        });
        queueServerPush();
    },

    /**
     * Pull preferences from the BE and hydrate the store.
     *
     * Called after login / session restore. If the server has no record,
     * uploads the current (localStorage-seeded) state so the user's first
     * login from another device sees the same layout.
     */
    syncPreferencesFromServer: async () => {
        try {
            const remote = await preferencesService.get();
            const hasRemote = remote && (
                Array.isArray(remote.widgets) ||
                (remote.layouts && Object.keys(remote.layouts).length) ||
                remote.dashboardSettings
            );
            if (hasRemote) {
                const widgets = Array.isArray(remote.widgets) ? remote.widgets : null;
                const layouts = remote.layouts && typeof remote.layouts === "object"
                    ? remote.layouts : {};
                const dashboardSettings = {
                    ...DEFAULT_DASHBOARD_SETTINGS,
                    ...(remote.dashboardSettings || {}),
                };
                if (widgets !== null) writeJson(STORAGE_KEYS.WIDGETS, widgets);
                writeJson(STORAGE_KEYS.LAYOUTS, layouts);
                writeJson(STORAGE_KEYS.DASHBOARD_SETTINGS, dashboardSettings);
                set({ widgets, layouts, dashboardSettings });
                setServerSyncEnabled(true);
                return { source: "server" };
            }
            // First login on this user — seed the server from localStorage.
            setServerSyncEnabled(true);
            queueServerPush();
            return { source: "seeded" };
        } catch (err) {
            // Stay in local-only mode on network errors.
            setServerSyncEnabled(false);
            if (typeof console !== "undefined") {
                console.warn("[dashboardStore] preferences sync failed:", err?.message || err);
            }
            return { source: "local", error: err };
        }
    },

    /** Stop pushing to the server (on logout) and drop any pending debounce. */
    disableServerSync: () => {
        setServerSyncEnabled(false);
    },

    exportDashboardConfig: () => {
        const state = useDashboardStore.getState();
        return {
            version: "1.0.0",
            exportedAt: new Date().toISOString(),
            widgets: state.widgets ?? [],
            layouts: state.layouts ?? {},
            dashboardSettings: state.dashboardSettings ?? DEFAULT_DASHBOARD_SETTINGS,
        };
    },

    importDashboardConfig: (config) => {
        if (!config || typeof config !== "object") {
            throw new Error("유효하지 않은 설정 JSON입니다.");
        }
        const widgets = Array.isArray(config.widgets) ? config.widgets : [];
        const layouts = config.layouts && typeof config.layouts === "object" ? config.layouts : {};
        const dashboardSettings = {
            ...DEFAULT_DASHBOARD_SETTINGS,
            ...(config.dashboardSettings ?? {}),
        };
        writeJson(STORAGE_KEYS.WIDGETS, widgets);
        writeJson(STORAGE_KEYS.LAYOUTS, layouts);
        writeJson(STORAGE_KEYS.DASHBOARD_SETTINGS, dashboardSettings);
        set({ widgets, layouts, dashboardSettings });
        queueServerPush();
    },
}));

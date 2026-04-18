import { create } from "zustand";
import { STORAGE_KEYS } from "./storageKeys.js";

const DEFAULT_DASHBOARD_SETTINGS = {
    widgetFontSize: 13,
    contentZoom: 100,
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
    },

    addWidget: (widget) => {
        set((state) => {
            const widgets = [...(state.widgets ?? []), widget];
            writeJson(STORAGE_KEYS.WIDGETS, widgets);
            return { widgets };
        });
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
    },

    saveLayout: (apiId, layout) => {
        set((state) => {
            const newLayouts = { ...state.layouts, [apiId]: layout };
            writeJson(STORAGE_KEYS.LAYOUTS, newLayouts);
            return { layouts: newLayouts };
        });
    },

    saveLayouts: (layoutMap) => {
        writeJson(STORAGE_KEYS.LAYOUTS, layoutMap);
        set({ layouts: layoutMap });
    },

    updateLayout: (apiId, layout) => {
        set((state) => {
            const newLayouts = { ...state.layouts, [apiId]: { ...state.layouts[apiId], ...layout } };
            writeJson(STORAGE_KEYS.LAYOUTS, newLayouts);
            return { layouts: newLayouts };
        });
    },

    clearLayouts: () => {
        localStorage.removeItem(STORAGE_KEYS.LAYOUTS);
        set({ layouts: {} });
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
    },
}));

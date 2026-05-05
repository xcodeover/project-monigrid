import { create } from "zustand";
import { STORAGE_KEYS } from "./storageKeys.js";
import { preferencesService } from "../services/dashboardService.js";
import { LAYOUT_SCALE_VERSION } from "../pages/dashboardConstants.js";

const DEFAULT_DASHBOARD_SETTINGS = {
    widgetFontSize: 13,
    // Width-axis grid scale the layouts are stored at. We doubled the column
    // count from 12 → 24 to support 0.5-unit sizing; layouts persisted before
    // that bump need their x/w/minW/maxW values multiplied by 2 on load.
    layoutScale: LAYOUT_SCALE_VERSION,
};

const _scaleLayout = (layout, factor) => {
    if (!layout || typeof layout !== "object") return layout;
    const next = { ...layout };
    ["x", "w", "minW", "maxW"].forEach((key) => {
        if (typeof next[key] === "number") next[key] = next[key] * factor;
    });
    return next;
};

/**
 * Migrate persisted layouts/widgets to the current LAYOUT_SCALE_VERSION.
 *
 * Old prefs stored on the 12-col grid have w/x in half the value they would
 * be on the new 24-col grid. We detect this by the missing/lower
 * `dashboardSettings.layoutScale` flag and multiply by 2 once.
 */
const migrateLayouts = ({ widgets, layouts, dashboardSettings }) => {
    const storedScale = Number(dashboardSettings?.layoutScale) || 1;
    if (storedScale >= LAYOUT_SCALE_VERSION) {
        return { widgets, layouts, dashboardSettings };
    }
    const factor = LAYOUT_SCALE_VERSION / storedScale;
    const nextLayouts = layouts && typeof layouts === "object"
        ? Object.fromEntries(
              Object.entries(layouts).map(([k, v]) => [k, _scaleLayout(v, factor)]),
          )
        : layouts;
    const nextWidgets = Array.isArray(widgets)
        ? widgets.map((w) =>
              w && w.defaultLayout
                  ? { ...w, defaultLayout: _scaleLayout(w.defaultLayout, factor) }
                  : w,
          )
        : widgets;
    return {
        widgets: nextWidgets,
        layouts: nextLayouts,
        dashboardSettings: {
            ...(dashboardSettings || {}),
            layoutScale: LAYOUT_SCALE_VERSION,
        },
    };
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
// While the post-login pull is in flight, `serverSyncEnabled` is false, so
// a user mutation in that window would normally be a no-op for queueServerPush
// AND its in-memory state would be clobbered when the server response is
// applied via set(). These flags let the sync path detect that conflict and
// preserve the user's local edits (local wins, push to server).
let _syncInFlight = false;
let _dirtyDuringSync = false;

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
    if (_syncInFlight) _dirtyDuringSync = true;
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

/**
 * Flush any pending debounced push immediately and resolve when it completes.
 * Used before destructive page actions (reload, hard navigation) so a debounce
 * window doesn't drop the user's last edits to widget layout / settings.
 */
const flushPendingPush = async () => {
    if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
        if (serverSyncEnabled) {
            const state = useDashboardStore.getState();
            pushPromise = preferencesService.save(snapshotForServer(state)).catch((err) => {
                if (typeof console !== "undefined") {
                    console.warn("[dashboardStore] preferences flush push failed:", err?.message || err);
                }
            });
        }
    }
    try {
        await pushPromise;
    } catch {
        // pushPromise has its own .catch above; awaiting only blocks for completion.
    }
};

// ── Initial state loader ──────────────────────────────────────────────────────

const loadInitialState = () => {
    const widgetsRaw = readJson(STORAGE_KEYS.WIDGETS, null);
    const widgets = Array.isArray(widgetsRaw) ? widgetsRaw : null;
    const layouts = readJson(STORAGE_KEYS.LAYOUTS, {});
    const dashboardSettings = {
        ...DEFAULT_DASHBOARD_SETTINGS,
        ...readJson(STORAGE_KEYS.DASHBOARD_SETTINGS, {}),
    };
    const migrated = migrateLayouts({ widgets, layouts, dashboardSettings });
    if (
        Number(dashboardSettings.layoutScale) !==
        Number(migrated.dashboardSettings.layoutScale)
    ) {
        // Persist the migrated form so the next session reads it directly.
        if (migrated.widgets !== null) {
            writeJson(STORAGE_KEYS.WIDGETS, migrated.widgets);
        }
        writeJson(STORAGE_KEYS.LAYOUTS, migrated.layouts);
        writeJson(STORAGE_KEYS.DASHBOARD_SETTINGS, migrated.dashboardSettings);
    }
    return migrated;
};

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
     *
     * @param {(() => { widgets: any[], layouts: Record<string, any> }) | null} buildDefaults
     *   Optional callback that returns the default widget set + layout map to
     *   seed when the store has no widgets AND the server has no record.
     *   Keeps UI-specific knowledge out of the store while still allowing the
     *   seeding to happen inside the sync window (preventing the local-wins
     *   race that would otherwise overwrite BE prefs with empty defaults).
     */
    syncPreferencesFromServer: async (buildDefaults = null) => {
        _syncInFlight = true;
        _dirtyDuringSync = false;
        try {
            const remote = await preferencesService.get();
            const hasRemote = remote && (
                Array.isArray(remote.widgets) ||
                (remote.layouts && Object.keys(remote.layouts).length) ||
                remote.dashboardSettings
            );
            if (hasRemote) {
                // The user may have mutated state while we were waiting on
                // the server (add widget / drag layout). Their edits are
                // already in localStorage + in-memory; clobbering them with
                // the server snapshot would silently drop the new widget.
                // Detect that and prefer local — push it up to make the
                // server eventually consistent.
                if (_dirtyDuringSync) {
                    setServerSyncEnabled(true);
                    queueServerPush();
                    return { source: "local-wins" };
                }
                const remoteWidgets = Array.isArray(remote.widgets) ? remote.widgets : null;
                const remoteLayouts = remote.layouts && typeof remote.layouts === "object"
                    ? remote.layouts : {};
                const remoteSettings = {
                    ...DEFAULT_DASHBOARD_SETTINGS,
                    ...(remote.dashboardSettings || {}),
                };
                // Apply the half-unit grid migration to anything coming from
                // the server too — old A-A nodes / older clients may still be
                // pushing 12-col-scale layouts.
                const {
                    widgets,
                    layouts,
                    dashboardSettings,
                } = migrateLayouts({
                    widgets: remoteWidgets,
                    layouts: remoteLayouts,
                    dashboardSettings: remoteSettings,
                });
                if (widgets !== null) writeJson(STORAGE_KEYS.WIDGETS, widgets);
                writeJson(STORAGE_KEYS.LAYOUTS, layouts);
                writeJson(STORAGE_KEYS.DASHBOARD_SETTINGS, dashboardSettings);
                set({ widgets, layouts, dashboardSettings });
                setServerSyncEnabled(true);
                if (
                    Number(remoteSettings.layoutScale) !==
                    Number(dashboardSettings.layoutScale)
                ) {
                    // Push the migrated form back so we don't migrate again next sync.
                    queueServerPush();
                }
                return { source: "server" };
            }
            // First login on this user (no server record).
            // If the store also has no widgets (new PC, empty localStorage) and
            // the caller provided a default factory, seed the defaults here —
            // INSIDE the sync window so it does NOT flip _dirtyDuringSync and
            // cannot trigger the local-wins branch.
            if (buildDefaults !== null) {
                const currentWidgets = useDashboardStore.getState().widgets;
                if (currentWidgets === null || currentWidgets.length === 0) {
                    const { widgets: defaultWidgets, layouts: defaultLayouts } =
                        buildDefaults();
                    writeJson(STORAGE_KEYS.WIDGETS, defaultWidgets);
                    writeJson(STORAGE_KEYS.LAYOUTS, defaultLayouts);
                    set({ widgets: defaultWidgets, layouts: defaultLayouts });
                }
            }
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
        } finally {
            _syncInFlight = false;
        }
    },

    /** Stop pushing to the server (on logout) and drop any pending debounce. */
    disableServerSync: () => {
        setServerSyncEnabled(false);
    },

    /**
     * Flush any pending debounced push and wait for it to land. Use before a
     * page reload or hard navigation so the user's most recent edits aren't
     * lost in the debounce window.
     */
    flushPendingPush,

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
        const importedWidgets = Array.isArray(config.widgets) ? config.widgets : [];
        const importedLayouts = config.layouts && typeof config.layouts === "object" ? config.layouts : {};
        const importedSettings = {
            ...DEFAULT_DASHBOARD_SETTINGS,
            ...(config.dashboardSettings ?? {}),
        };
        // Imported configs from older versions still carry 12-col-scale layouts.
        const { widgets, layouts, dashboardSettings } = migrateLayouts({
            widgets: importedWidgets,
            layouts: importedLayouts,
            dashboardSettings: importedSettings,
        });
        writeJson(STORAGE_KEYS.WIDGETS, widgets);
        writeJson(STORAGE_KEYS.LAYOUTS, layouts);
        writeJson(STORAGE_KEYS.DASHBOARD_SETTINGS, dashboardSettings);
        set({ widgets, layouts, dashboardSettings });
        queueServerPush();
    },
}));

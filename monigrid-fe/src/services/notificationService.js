/**
 * Notification subsystem service (Phase 6).
 *
 * Mirrors monigrid-be/app/routes/notification_routes.py. All endpoints under
 * /dashboard/notifications/*. Mutations require admin; reads require auth.
 *
 * Channel config write convention: pass an empty string for `password` to
 * leave the stored password untouched. This lets the UI show a password
 * field that says "(unchanged)" without round-tripping the secret.
 */
import apiClient from "./http.js";

const BASE = "/dashboard/notifications";

// ── global toggle ───────────────────────────────────────────────────────────

export const notificationGlobalService = {
    get: async () => {
        const r = await apiClient.get(`${BASE}/global`);
        return r.data;
    },
    set: async (enabled) => {
        const r = await apiClient.put(`${BASE}/global`, { enabled: !!enabled });
        return r.data;
    },
};

// ── channels ────────────────────────────────────────────────────────────────

export const notificationChannelService = {
    list: async () => {
        const r = await apiClient.get(`${BASE}/channels`);
        return r.data?.channels || [];
    },
    getConfig: async (kind) => {
        const r = await apiClient.get(`${BASE}/channels/${encodeURIComponent(kind)}/config`);
        return r.data;
    },
    save: async (kind, { enabled, config }) => {
        const r = await apiClient.put(
            `${BASE}/channels/${encodeURIComponent(kind)}`,
            { enabled: !!enabled, config: config || {} },
        );
        return r.data;
    },
    sendTest: async (kind, recipient) => {
        const r = await apiClient.post(
            `${BASE}/channels/${encodeURIComponent(kind)}/test`,
            { recipient },
        );
        return r.data;
    },
};

// ── groups ──────────────────────────────────────────────────────────────────

export const notificationGroupService = {
    list: async () => {
        const r = await apiClient.get(`${BASE}/groups`);
        return r.data?.groups || [];
    },
    create: async ({ name, description, enabled = true }) => {
        const r = await apiClient.post(`${BASE}/groups`, { name, description, enabled });
        return r.data;
    },
    update: async (id, patch) => {
        const r = await apiClient.put(`${BASE}/groups/${id}`, patch);
        return r.data;
    },
    remove: async (id) => {
        await apiClient.delete(`${BASE}/groups/${id}`);
    },
};

// ── recipients ──────────────────────────────────────────────────────────────

export const notificationRecipientService = {
    listForGroup: async (groupId) => {
        const r = await apiClient.get(`${BASE}/groups/${groupId}/recipients`);
        return r.data?.recipients || [];
    },
    create: async (groupId, { kind = "email", address, displayName, enabled = true }) => {
        const r = await apiClient.post(
            `${BASE}/groups/${groupId}/recipients`,
            { kind, address, displayName, enabled },
        );
        return r.data;
    },
    update: async (id, patch) => {
        const r = await apiClient.put(`${BASE}/recipients/${id}`, patch);
        return r.data;
    },
    remove: async (id) => {
        await apiClient.delete(`${BASE}/recipients/${id}`);
    },
};

// ── rules ───────────────────────────────────────────────────────────────────

export const notificationRuleService = {
    list: async () => {
        const r = await apiClient.get(`${BASE}/rules`);
        return r.data?.rules || [];
    },
    get: async (id) => {
        const r = await apiClient.get(`${BASE}/rules/${id}`);
        return r.data;
    },
    create: async (rule) => {
        const r = await apiClient.post(`${BASE}/rules`, rule);
        return r.data;
    },
    update: async (id, patch) => {
        const r = await apiClient.put(`${BASE}/rules/${id}`, patch);
        return r.data;
    },
    remove: async (id) => {
        await apiClient.delete(`${BASE}/rules/${id}`);
    },
};

// ── silence rules ───────────────────────────────────────────────────────────

export const notificationSilenceService = {
    list: async () => {
        const r = await apiClient.get(`${BASE}/silences`);
        return r.data?.silences || [];
    },
    listActive: async () => {
        const r = await apiClient.get(`${BASE}/silences/active`);
        return r.data?.silences || [];
    },
    /**
     * Create a silence rule.
     *
     * Quick form: pass `hours` to silence from now for N hours.
     * Explicit form: pass `startsAt` + `endsAt` (ISO strings).
     */
    create: async ({ name, sourceType, sourceIdPattern, metricPattern, hours, startsAt, endsAt, reason }) => {
        const r = await apiClient.post(`${BASE}/silences`, {
            name, sourceType, sourceIdPattern, metricPattern,
            hours, startsAt, endsAt, reason,
        });
        return r.data;
    },
    remove: async (id) => {
        await apiClient.delete(`${BASE}/silences/${id}`);
    },
};

// ── queue ───────────────────────────────────────────────────────────────────

export const notificationQueueService = {
    list: async ({ status, limit = 200, offset = 0 } = {}) => {
        const params = new URLSearchParams();
        if (status) params.set("status", status);
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        const r = await apiClient.get(`${BASE}/queue?${params.toString()}`);
        return r.data;
    },
    retry: async (id) => {
        const r = await apiClient.post(`${BASE}/queue/${id}/retry`);
        return r.data;
    },
    cancel: async (id) => {
        const r = await apiClient.post(`${BASE}/queue/${id}/cancel`);
        return r.data;
    },
};

// ── stats + send-now ───────────────────────────────────────────────────────

export const notificationStatsService = {
    get: async () => {
        const r = await apiClient.get(`${BASE}/stats`);
        return r.data;
    },
};

export const notificationSendNowService = {
    /**
     * Send the given alert event immediately to a list of addresses, bypassing
     * the rule engine. Used by AlarmBanner's "notify operator now" action.
     *
     * @param {{event: object, channelId: number, recipients: string[]}} payload
     */
    send: async ({ event, channelId, recipients }) => {
        const r = await apiClient.post(`${BASE}/send-now`, {
            event, channelId, recipients,
        });
        return r.data;
    },
};

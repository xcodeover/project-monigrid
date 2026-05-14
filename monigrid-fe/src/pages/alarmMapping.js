/**
 * Map BE active alerts → FE widget ids.
 *
 * Phase 2 / Step 2c-A: the BE owns alert evaluation and exposes the current
 * active set at `/dashboard/alerts/active`. The FE polls that endpoint, joins
 * the result against the user's widgets, and pushes the resulting Set into
 * `alarmStore.syncAlarmedWidgets()`.
 *
 * Mapping rules:
 *   - status-list widgets : `widget.targetIds` (top-level) — http_status sourceIds.
 *   - server-resource widgets : `widget.serverConfig.targetIds` — server_resource sourceIds.
 *   - network-test widgets : `widget.networkConfig.targetIds` — network sourceIds.
 *     Different widget types store target ids under different keys because the
 *     widget creation path in DashboardPage writes them there (serverConfig /
 *     networkConfig carry per-type extras alongside the target list). The BE
 *     alert sourceId is the monitor target id, so we intersect against whichever
 *     list the widget type stores.
 *   - data API widgets (table / line-chart / bar-chart) : the BE alert
 *     sourceType is `data_api:<widget_type>` and sourceId is the api id
 *     (= the row id in `monigrid_apis`). Widgets reference an API via
 *     `widget.endpoint` (REST path), so we resolve endpoint → api id from the
 *     `/dashboard/endpoints` catalog.
 *
 * The function is pure / synchronous; the caller fetches inputs.
 */

import {
    WIDGET_TYPE_BAR_CHART,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_NETWORK_TEST,
    WIDGET_TYPE_SERVER_RESOURCE,
    WIDGET_TYPE_STATUS_LIST,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants.js";

const MONITOR_TYPE_TO_WIDGET = {
    server_resource: WIDGET_TYPE_SERVER_RESOURCE,
    network: WIDGET_TYPE_NETWORK_TEST,
    http_status: WIDGET_TYPE_STATUS_LIST,
};

const DATA_API_WIDGET_TYPES = new Set([
    WIDGET_TYPE_TABLE,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_BAR_CHART,
]);

/**
 * @param {Array} activeAlerts - response.items from /dashboard/alerts/active
 * @param {Array} widgets - dashboardStore.widgets
 * @param {Array} endpointCatalog - response from /dashboard/endpoints
 *   (each: {id, endpoint, ...}) — used to resolve widget.endpoint → api id
 * @returns {Set<string>} widget ids that are currently in alarm state
 */
export function computeAlarmedWidgets({
    activeAlerts,
    widgets,
    endpointCatalog,
}) {
    const out = new Set();
    if (!Array.isArray(activeAlerts) || activeAlerts.length === 0) return out;
    if (!Array.isArray(widgets) || widgets.length === 0) return out;

    // Bucket alerts by source type. data_api:<widget_type> share the same
    // sourceId space (api id), so we collapse them into one set keyed by
    // widget_type. Monitor types use the BE source_type as-is.
    const monitorAlertsBySourceType = {};
    // data API 알람은 widget_type 무관 단일 source_type="data_api" 로 통일됨
    // (BE evaluator 단순화). 이전 구현이 남긴 historical "data_api:table" 등
    // 도 같은 set 으로 합쳐 위젯 매핑 시점에서는 구분하지 않는다.
    const dataApiAlertSourceIds = new Set();

    for (const a of activeAlerts) {
        const sourceType = a?.sourceType;
        const sourceId = a?.sourceId;
        if (!sourceType || !sourceId) continue;
        if (sourceType === "data_api" || sourceType.startsWith("data_api:")) {
            dataApiAlertSourceIds.add(sourceId);
        } else {
            (monitorAlertsBySourceType[sourceType] ??= new Set()).add(sourceId);
        }
    }

    // endpoint REST path → api id. catalog 의 endpoint 는 항상 BE 의
    // rest_api_path (예: "/api/status") 인 반면, widget 에 저장된 endpoint 는
    // DashboardPage 가 normalizeUserEndpoint 를 통과시켜 full URL
    // (예: "http://host:5000/api/status") 로 변환해 두는 경우가 있다.
    // 따라서 widget endpoint 를 catalog 키로 풀 때 (a) 원본 그대로, (b) query
    // 제거 후, (c) URL 파싱으로 pathname 추출 — 세 단계로 fallback 해 매칭한다.
    const apiIdByEndpoint = new Map();
    if (Array.isArray(endpointCatalog)) {
        for (const ep of endpointCatalog) {
            const path = ep?.endpoint;
            const id = ep?.id;
            if (path && id) apiIdByEndpoint.set(path, id);
        }
    }

    const resolveApiId = (widget) => {
        if (widget?.apiId) return widget.apiId;
        const ep = widget?.endpoint;
        if (!ep) return undefined;
        // 1) catalog 키와 동일 (relative path 케이스)
        let hit = apiIdByEndpoint.get(ep);
        if (hit) return hit;
        // 2) query string strip 후 매칭
        const stripped = ep.split("?")[0];
        if (stripped !== ep) {
            hit = apiIdByEndpoint.get(stripped);
            if (hit) return hit;
        }
        // 3) full URL 로 저장된 widget — URL 파싱으로 pathname 만 사용
        try {
            const u = new URL(ep, typeof window !== "undefined" ? window.location.origin : undefined);
            hit = apiIdByEndpoint.get(u.pathname);
            if (hit) return hit;
        } catch {
            /* parsing 실패 — 외부 host 가 아닌 잘못된 endpoint, no-op */
        }
        return undefined;
    };

    for (const w of widgets) {
        if (!w || !w.id) continue;
        const widgetId = w.id;

        // ── monitor-target-based widgets ──────────────────────────────
        const monitorSourceType = Object.keys(MONITOR_TYPE_TO_WIDGET).find(
            (st) => MONITOR_TYPE_TO_WIDGET[st] === w.type,
        );
        if (monitorSourceType) {
            const rawIds =
                w.type === WIDGET_TYPE_SERVER_RESOURCE
                    ? w.serverConfig?.targetIds
                    : w.type === WIDGET_TYPE_NETWORK_TEST
                    ? w.networkConfig?.targetIds
                    : w.targetIds;
            const ids = Array.isArray(rawIds) ? rawIds : [];
            const set = monitorAlertsBySourceType[monitorSourceType];
            if (set && ids.some((tid) => set.has(tid))) {
                out.add(widgetId);
            }
            continue;
        }

        // ── data API widgets (table / line-chart / bar-chart) ────────
        if (DATA_API_WIDGET_TYPES.has(w.type)) {
            if (dataApiAlertSourceIds.size === 0) continue;
            const apiId = resolveApiId(w);
            if (apiId && dataApiAlertSourceIds.has(apiId)) {
                out.add(widgetId);
            }
        }
    }

    return out;
}

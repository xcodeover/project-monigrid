/**
 * Phase 2 (revised in 2c-D): merge BE-central widget_configs onto user widgets.
 *
 * Policy update:
 *   - BE 가 관리하는 것 = 알람 임계치(thresholds) 만.
 *   - 표시 컬럼은 BE 가 직접 정의하지 않고, FE 가 BE 쿼리(SQL SELECT) 결과
 *     컬럼 순서를 그대로 따른다 (= 가장 자연스러운 단일 출처).
 *   - 사용자별 위젯 크기 / 컬럼 너비 = user_preferences.
 *
 * 본 모듈은 BE 의 widget_configs 응답을 받아 위젯 객체에 thresholds 메타만
 * 부착해 준다. 알람 평가는 BE 가 수행하므로 FE 가 thresholds 를 평가에
 * 사용하지 않지만, 차트의 임계치 시각화 라인 등 향후 사용을 위해 메타로 보존.
 */

import {
    WIDGET_TYPE_BAR_CHART,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_TABLE,
} from "./dashboardConstants.js";

const MERGEABLE_WIDGET_TYPES = new Set([
    WIDGET_TYPE_TABLE,
    WIDGET_TYPE_LINE_CHART,
    WIDGET_TYPE_BAR_CHART,
]);

/**
 * @param {Array} widgets - raw widgets from dashboardStore
 * @param {Array} widgetConfigs - response.configs from /dashboard/widget-configs
 *   (each: {apiId, widgetType, config:{thresholds, ...}})
 * @param {Array} endpointCatalog - response from /dashboard/endpoints
 *   (each: {id, endpoint, ...}) — used for endpoint→api id resolution
 * @returns {Array} new widgets array with `_beThresholds` attached on
 *   tableSettings / chartSettings (or unchanged when no BE row exists).
 */
export function mergeWidgetsWithBeConfigs({
    widgets,
    widgetConfigs,
    endpointCatalog,
}) {
    if (!Array.isArray(widgets) || widgets.length === 0) return widgets || [];
    if (!Array.isArray(widgetConfigs) || widgetConfigs.length === 0) {
        return widgets;
    }

    const apiIdByEndpoint = new Map();
    if (Array.isArray(endpointCatalog)) {
        for (const ep of endpointCatalog) {
            if (ep?.endpoint && ep?.id) apiIdByEndpoint.set(ep.endpoint, ep.id);
        }
    }

    const configByKey = new Map();
    for (const c of widgetConfigs) {
        if (!c?.apiId || !c?.widgetType) continue;
        configByKey.set(`${c.apiId}|${c.widgetType}`, c.config || {});
    }

    return widgets.map((w) => {
        if (!w || !MERGEABLE_WIDGET_TYPES.has(w.type)) return w;
        const apiId = w.apiId
            || apiIdByEndpoint.get(w.endpoint)
            || apiIdByEndpoint.get((w.endpoint || "").split("?")[0]);
        if (!apiId) return w;
        const beCfg = configByKey.get(`${apiId}|${w.type}`);
        if (!beCfg) return w;

        const beThresholds = Array.isArray(beCfg.thresholds) ? beCfg.thresholds : [];

        if (w.type === WIDGET_TYPE_TABLE) {
            return {
                ...w,
                tableSettings: {
                    ...(w.tableSettings || {}),
                    _beThresholds: beThresholds,
                    _beManaged: true,
                },
            };
        }
        return {
            ...w,
            chartSettings: {
                ...(w.chartSettings || {}),
                _beThresholds: beThresholds,
                _beManaged: true,
            },
        };
    });
}

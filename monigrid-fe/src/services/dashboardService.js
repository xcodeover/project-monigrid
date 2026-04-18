/**
 * Dashboard service (ISP + SRP): split into focused method groups.
 * Each method group handles one concern: endpoints, data, health, SQL, logs, cache.
 */
import apiClient, { getRememberedApiBaseUrl } from "./http.js";

// ── Endpoint catalog ──────────────────────────────────────────────────────────

export const endpointService = {
    getApiEndpoints: async () => {
        const response = await apiClient.get("/dashboard/endpoints");
        return response.data;
    },

    getSqlEditableEndpoints: async () => {
        const response = await apiClient.get("/dashboard/sql-editor/endpoints");
        return response.data;
    },
};

// ── Data fetching ─────────────────────────────────────────────────────────────

export const dataService = {
    /**
     * @param {string|null} _apiId  (호환성을 위해 유지, 사용 안 함)
     * @param {string} endpoint     호출할 경로/URL
     * @param {{fresh?: boolean}} [options]  fresh=true 면 백엔드 캐시를 우회 (?fresh=1).
     *        criteria 기반 알람처럼 실시간성이 필요한 폴링에서 사용.
     */
    getApiData: async (_apiId, endpoint, options = {}) => {
        const url = options?.fresh
            ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}fresh=1`
            : endpoint;
        const response = await apiClient.get(url);
        return response.data;
    },

    getMultipleApiData: async (endpoints) => {
        const promises = endpoints.map(({ id, url }) =>
            apiClient
                .get(url)
                .then((res) => ({ id, data: res.data, status: "success" }))
                .catch((error) => ({
                    id,
                    data: null,
                    status: "error",
                    error: error.response?.data?.message || error.message,
                })),
        );
        return Promise.all(promises);
    },
};

// ── Health checks ─────────────────────────────────────────────────────────────

const isElectron = () =>
    typeof window !== "undefined" && window.desktop?.isElectron === true;

const isCrossOrigin = (url) => {
    try {
        const target = new URL(url, window.location.origin);
        return target.origin !== window.location.origin;
    } catch {
        return false;
    }
};

/**
 * 우리 백엔드(API base)와 동일 origin인지 판정.
 *
 * 헬스체크 프록시(`/dashboard/health-check-proxy*`)는 백엔드가 서버사이드에서
 * 외부 호출을 흉내내는 구조라 Authorization 헤더를 첨부하지 않는다. 따라서
 * 타깃이 인증이 필요한 우리 백엔드 자기 자신을 가리키면 매 폴링마다
 * `Auth rejected reason=missing_token` 경고가 찍힌다.
 *
 * 이를 막기 위해 타깃이 우리 API base와 같은 origin이면 프록시를 우회하고
 * `apiClient`로 직접 호출하여 요청 인터셉터가 Bearer 토큰을 붙이도록 한다.
 */
const isOurBackendUrl = (url) => {
    try {
        const target = new URL(url, window.location.origin);
        const base = new URL(getRememberedApiBaseUrl());
        return target.origin === base.origin;
    } catch {
        return false;
    }
};

const needsProxy = (url) =>
    !isElectron() && isCrossOrigin(url) && !isOurBackendUrl(url);

export const healthService = {
    checkEndpointHealth: async (endpoint) => {
        // In web mode, use the backend proxy for cross-origin URLs to avoid CORS
        if (needsProxy(endpoint)) {
            const startedAt = Date.now();
            try {
                const response = await apiClient.post("/dashboard/health-check-proxy", {
                    url: endpoint,
                    timeout: 10,
                });
                return {
                    httpStatus: response.data.httpStatus,
                    ok: response.data.ok === true,
                    responseTimeMs: response.data.responseTimeMs ?? (Date.now() - startedAt),
                    checkedAt: new Date().toISOString(),
                    body: response.data.body,
                };
            } catch (error) {
                return {
                    httpStatus: null,
                    ok: false,
                    responseTimeMs: Date.now() - startedAt,
                    checkedAt: new Date().toISOString(),
                    body: null,
                    error: error?.message || "Proxy request failed",
                };
            }
        }

        const startedAt = Date.now();
        const response = await apiClient.get(endpoint, { validateStatus: () => true });
        return {
            httpStatus: response.status,
            ok: response.status === 200,
            responseTimeMs: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            body: response.data,
        };
    },

    checkMultipleEndpointsHealth: async (endpoints) => {
        const endpointList = endpoints || [];

        // Separate items with missing URLs
        const emptyItems = [];
        const proxyItems = [];
        const directItems = [];

        endpointList.forEach((item, index) => {
            const label = String(item?.label || item?.title || item?.url || `API ${index + 1}`).trim();
            const url = String(item?.url || "").trim();
            const id = String(item?.id || url || `missing-${index}`);

            if (!url) {
                emptyItems.push({
                    id, label, url, ok: false, httpStatus: null,
                    responseTimeMs: null, checkedAt: new Date().toISOString(),
                    error: "URL이 비어 있습니다.",
                });
            } else if (needsProxy(url)) {
                proxyItems.push({ id, label, url, timeout: 10 });
            } else {
                directItems.push({ id, label, url });
            }
        });

        // Batch proxy request for cross-origin URLs
        let proxyResults = [];
        if (proxyItems.length > 0) {
            try {
                const res = await apiClient.post("/dashboard/health-check-proxy-batch", {
                    urls: proxyItems.map((p) => ({ id: p.id, url: p.url, timeout: p.timeout })),
                });
                const batchResults = res.data?.results || [];
                proxyResults = proxyItems.map((p, i) => {
                    const r = batchResults[i] || {};
                    return {
                        id: p.id, label: p.label, url: p.url,
                        ok: r.ok === true,
                        httpStatus: r.httpStatus ?? null,
                        responseTimeMs: r.responseTimeMs ?? null,
                        checkedAt: new Date().toISOString(),
                        body: r.body ?? null,
                        error: r.ok ? null : (r.error || `HTTP ${r.httpStatus}`),
                    };
                });
            } catch (error) {
                proxyResults = proxyItems.map((p) => ({
                    id: p.id, label: p.label, url: p.url,
                    ok: false, httpStatus: null, responseTimeMs: null,
                    checkedAt: new Date().toISOString(), body: null,
                    error: error?.response?.data?.message || error?.message || "요청 실패",
                }));
            }
        }

        // Direct requests for same-origin URLs (Electron or same-origin)
        const directResults = await Promise.all(
            directItems.map(async (item) => {
                try {
                    const result = await healthService.checkEndpointHealth(item.url);
                    return {
                        id: item.id, label: item.label, url: item.url,
                        ...result,
                        error: result.ok ? null : `HTTP ${result.httpStatus}`,
                    };
                } catch (error) {
                    return {
                        id: item.id, label: item.label, url: item.url,
                        ok: false, httpStatus: null, responseTimeMs: null,
                        checkedAt: new Date().toISOString(), body: null,
                        error: error?.response?.data?.detail || error?.response?.data?.message || error?.message || "요청 실패",
                    };
                }
            }),
        );

        // Merge results back in original order
        const resultMap = {};
        [...emptyItems, ...proxyResults, ...directResults].forEach((r) => { resultMap[r.id] = r; });
        const items = endpointList.map((item, index) => {
            const id = String(item?.id || item?.url || `missing-${index}`);
            return resultMap[id] || {
                id, label: String(item?.label || item?.title || item?.url || `API ${index + 1}`).trim(),
                url: String(item?.url || "").trim(),
                ok: false, httpStatus: null, responseTimeMs: null,
                checkedAt: new Date().toISOString(), error: "Unknown",
            };
        });

        const okCount = items.filter((item) => item.ok).length;
        return {
            items,
            okCount,
            failCount: items.length - okCount,
            checkedAt: new Date().toISOString(),
        };
    },
};

// ── SQL editor ────────────────────────────────────────────────────────────────

export const sqlEditorService = {
    getApiSqlScript: async (apiId) => {
        const response = await apiClient.get(`/dashboard/sql-editor/${apiId}`);
        return response.data;
    },

    getSqlValidationRules: async () => {
        const response = await apiClient.get("/dashboard/sql-editor/validation-rules");
        return response.data;
    },

    updateApiSqlScript: async (apiId, sql) => {
        const response = await apiClient.put(`/dashboard/sql-editor/${apiId}`, { sql });
        return response.data;
    },

    listSqlFiles: async () => {
        const response = await apiClient.get("/dashboard/sql-editor/files");
        return response.data;
    },

    createSqlFile: async (sqlId, sql, { overwrite = true } = {}) => {
        const response = await apiClient.post("/dashboard/sql-editor/files", {
            sqlId, sql, overwrite,
        });
        return response.data;
    },
};

// ── Logs & alerts ─────────────────────────────────────────────────────────────

export const logService = {
    getAlerts: async () => {
        const response = await apiClient.get("/dashboard/alerts");
        return response.data;
    },

    getLogs: async ({
        startDate = null,
        endDate = null,
        maxLines = 1000,
        cursor = null,
        followLatest = false,
    } = {}) => {
        const params = new URLSearchParams();
        if (startDate) params.append("start_date", startDate);
        if (endDate) params.append("end_date", endDate);
        params.append("max_lines", maxLines);
        if (cursor) params.append("cursor", cursor);
        params.append("follow_latest", String(Boolean(followLatest)));
        const response = await apiClient.get(`/logs?${params.toString()}`);
        return response.data;
    },
};

// ── Cache management ──────────────────────────────────────────────────────────

export const cacheService = {
    refreshEndpointCache: async ({
        apiId = null,
        endpoint = null,
        resetConnection = false,
    } = {}) => {
        const response = await apiClient.post("/dashboard/cache/refresh", {
            api_id: apiId,
            endpoint,
            reset_connection: resetConnection,
        });
        return response.data;
    },
};

// ── Backend config management (admin only) ───────────────────────────────────

export const configService = {
    getConfig: async () => {
        const response = await apiClient.get("/dashboard/config");
        return response.data;
    },

    updateConfig: async (configData) => {
        const response = await apiClient.put("/dashboard/config", configData);
        return response.data;
    },

    reloadConfig: async () => {
        const response = await apiClient.post("/dashboard/reload-config");
        return response.data;
    },
};

// ── Backward-compatible aggregate export (preserves existing imports) ─────────

const dashboardService = {
    ...endpointService,
    ...dataService,
    ...healthService,
    ...sqlEditorService,
    ...logService,
    refreshEndpointCache: cacheService.refreshEndpointCache,
    ...configService,
};

export default dashboardService;

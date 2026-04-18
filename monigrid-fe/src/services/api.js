/**
 * Barrel export — maintains backward compatibility with existing imports.
 *
 * Internal logic has been split by responsibility:
 *   http.js          — axios client, interceptors, retry, URL utilities
 *   authService.js   — login / logout
 *   dashboardService.js — data, health, SQL editor, logs, cache
 */
export {
    getRememberedApiBaseUrl,
    rememberApiBaseUrl,
    resolveEndpointWithBase,
    normalizeUserEndpoint,
    isRetryable,
    parseRetryAfterMs,
    retryWithBackoff,
    formatErrorMessage,
    default as apiClient,
} from "./http.js";

export { default as authService } from "./authService.js";
export { default as dashboardService } from "./dashboardService.js";
export {
    endpointService,
    dataService,
    healthService,
    sqlEditorService,
    logService,
    cacheService,
    configService,
} from "./dashboardService.js";

/**
 * HTTP client (SRP): axios instance, interceptors, retry logic, and URL utilities.
 * All other services depend on this module — not on axios directly (DIP).
 */
import axios from "axios";

/**
 * 빌드 시점 환경변수(VITE_API_URL) 해석 규칙:
 *   - 미정의(undefined): 개발 기본값 http://127.0.0.1:5000 사용
 *   - 명시적 빈 문자열(""): "same-origin 모드" — IIS+ARR 같은 단일 호스트 배포.
 *       이 경우 web.config의 rewrite 규칙이 백엔드로 프록시하므로 프론트엔드는
 *       반드시 현재 origin으로 호출해야 한다. (.env.iis 가 이 모드를 사용함)
 *   - 그 외 문자열: 그대로 사용
 *
 * 과거 코드는 `|| "http://127.0.0.1:5000"` 패턴이라 빈 문자열도 falsy 처리되어
 * 프록시를 우회하고 127.0.0.1:5000을 직접 호출하는 버그가 있었다.
 */
const ENV_API_URL = import.meta.env.VITE_API_URL;
const DEV_FALLBACK_API_URL = "http://127.0.0.1:5000";

const computeBuildtimeApiBaseUrl = () => {
    if (ENV_API_URL === undefined || ENV_API_URL === null) {
        return DEV_FALLBACK_API_URL;
    }
    if (ENV_API_URL === "") {
        // same-origin 모드: 브라우저에서 실행 중이면 현재 origin 사용,
        // electron(file://) 등에서는 개발 fallback 사용.
        if (
            typeof window !== "undefined" &&
            window.location?.origin &&
            !window.location.origin.startsWith("file:")
        ) {
            return window.location.origin;
        }
        return DEV_FALLBACK_API_URL;
    }
    return ENV_API_URL;
};

export const API_BASE_URL = computeBuildtimeApiBaseUrl();
const API_TIMEOUT_MS = parseInt(import.meta.env.VITE_API_TIMEOUT_MS || "10000");
const RETRY_ATTEMPTS = parseInt(import.meta.env.VITE_RETRY_ATTEMPTS || "3");
const RETRY_DELAY_MS = parseInt(import.meta.env.VITE_RETRY_DELAY_MS || "1000");
const RATE_LIMIT_WAIT_MS = parseInt(import.meta.env.VITE_RATE_LIMIT_WAIT_MS || "10000");

const REMEMBERED_API_BASE_URL_KEY = "dashboard_api_base_url";

// ── URL utilities ─────────────────────────────────────────────────────────────

export const normalizeApiBaseUrl = (url) =>
    String(url ?? "")
        .trim()
        .replace(/\/+$/, "");

export const getRememberedApiBaseUrl = () => {
    const fallback = normalizeApiBaseUrl(API_BASE_URL);
    if (typeof window === "undefined") return fallback;
    const stored = localStorage.getItem(REMEMBERED_API_BASE_URL_KEY);
    return normalizeApiBaseUrl(stored || fallback);
};

export const rememberApiBaseUrl = (url) => {
    const normalized = normalizeApiBaseUrl(url || API_BASE_URL);
    if (typeof window !== "undefined" && normalized) {
        localStorage.setItem(REMEMBERED_API_BASE_URL_KEY, normalized);
    }
    return normalized;
};

export const resolveEndpointWithBase = (endpoint, baseUrl = null) => {
    const rawEndpoint = String(endpoint ?? "").trim();
    if (!rawEndpoint) return rawEndpoint;
    if (/^https?:\/\//i.test(rawEndpoint)) return rawEndpoint;

    const normalizedBase = normalizeApiBaseUrl(
        baseUrl || getRememberedApiBaseUrl() || API_BASE_URL,
    );
    if (!normalizedBase) return rawEndpoint;

    return rawEndpoint.startsWith("/")
        ? `${normalizedBase}${rawEndpoint}`
        : `${normalizedBase}/${rawEndpoint.replace(/^\/+/, "")}`;
};

/**
 * 사용자가 입력한 endpoint 문자열을 정규화한다.
 *   - "https://example.com/foo" → 그대로
 *   - "/api/foo" → base + "/api/foo" (백엔드 상대경로)
 *   - "www.naver.com" 또는 "example.com:8080/foo" → "http://" + 입력 (외부 호스트로 간주)
 *   - "api/foo" 처럼 첫 세그먼트에 "."가 없는 상대경로 → base + "/api/foo"
 *
 * 헬스 체크 위젯처럼 사용자가 외부 호스트(예: www.naver.com)를 그대로 적는
 * 케이스를 지원하기 위한 휴리스틱 정규화 helper.
 */
export const normalizeUserEndpoint = (endpoint, baseUrl = null) => {
    const trimmed = String(endpoint ?? "").trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith("/")) {
        return resolveEndpointWithBase(trimmed, baseUrl);
    }
    // 첫 path 세그먼트에 "."이 있으면 호스트명으로 간주 (예: www.naver.com, example.com:8080/path)
    const firstSegment = trimmed.split("/")[0];
    if (firstSegment.includes(".")) {
        return `http://${trimmed}`;
    }
    return resolveEndpointWithBase(trimmed, baseUrl);
};

// ── Retry helpers ─────────────────────────────────────────────────────────────

export const isRetryable = (error) => {
    if (!error.response) return true; // network error
    const status = error.response.status;
    // 429 is NOT retryable — retrying rate-limited requests worsens the problem
    return status === 408 || (status >= 500 && status < 600);
};

/**
 * Parse the Retry-After header value (seconds or HTTP-date) into milliseconds.
 * Returns null if the header is missing or unparseable.
 */
export const parseRetryAfterMs = (error) => {
    const header = error?.response?.headers?.["retry-after"];
    if (!header) return null;
    const secs = Number(header);
    if (!Number.isNaN(secs) && secs > 0) return Math.ceil(secs) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return null;
};

export const retryWithBackoff = async (config, attempt = 1) => {
    try {
        return await axios.request(config);
    } catch (error) {
        if (attempt < RETRY_ATTEMPTS && isRetryable(error)) {
            const delayMs = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return retryWithBackoff(config, attempt + 1);
        }
        throw error;
    }
};

// ── Error formatting ──────────────────────────────────────────────────────────

export const formatErrorMessage = (error) => {
    if (error?.response) {
        const status = error.response.status;
        if (status === 429) {
            return "요청이 너무 많습니다. 잠시 후 자동으로 재시도합니다.";
        }
        const serverMessage = error.response?.data?.message || null;
        const serverDetail = error.response?.data?.detail || null;
        const effectiveMessage =
            status === 500 && serverMessage === "Internal Server Error" && serverDetail
                ? serverDetail
                : serverMessage || serverDetail;
        return effectiveMessage
            ? `HTTP ${status} - ${effectiveMessage}`
            : `Request failed with status code ${status}`;
    }
    if (error?.code === "ECONNABORTED" || error?.message?.includes("timeout")) {
        return "요청 시간이 초과되었습니다 (timeout)";
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
        return "오프라인 상태입니다. 인터넷 연결을 확인하세요.";
    }
    return error?.message || "데이터 로드 실패";
};

// ── 429 Rate-limit guard ─────────────────────────────────────────────────────
// When a 429 is received, all subsequent requests are delayed until the
// Retry-After period expires. This prevents the retry storm that makes 429s
// snowball across multiple polling widgets.

let _rateLimitedUntil = 0;

const _waitForRateLimit = () => {
    const remaining = _rateLimitedUntil - Date.now();
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, remaining));
};

// ── Axios instance ────────────────────────────────────────────────────────────

const apiClient = axios.create({
    baseURL: getRememberedApiBaseUrl(),
    timeout: API_TIMEOUT_MS,
    headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.request.use(
    async (config) => {
        // If we are rate-limited, wait before sending the request
        await _waitForRateLimit();
        // Dynamically resolve baseURL so changes via dashboard settings take effect
        config.baseURL = getRememberedApiBaseUrl();
        const token = localStorage.getItem("auth_token");
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => Promise.reject(error),
);

apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        // On 429, record the back-off window so subsequent requests wait
        if (error.response?.status === 429) {
            const waitMs = parseRetryAfterMs(error) || RATE_LIMIT_WAIT_MS;
            _rateLimitedUntil = Math.max(_rateLimitedUntil, Date.now() + waitMs);
        }

        const requestUrl = String(error.config?.url ?? "");
        const isLoginRequest = requestUrl.includes("/auth/login");
        if (error.response?.status === 401 && !isLoginRequest) {
            localStorage.removeItem("auth_token");
            if (window.location.protocol === "file:") {
                window.location.hash = "/login";
            } else {
                window.location.href = "/login";
            }
        }
        return Promise.reject(error);
    },
);

export default apiClient;

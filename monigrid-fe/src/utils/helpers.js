/**
 * 유틸리티 함수 모음
 */

/**
 * 데이터를 배열로 정규화
 * @param {any} data - 정규화할 데이터
 * @returns {Array} 정규화된 배열
 */
export const normalizeToArray = (data) => {
    if (Array.isArray(data)) {
        return data;
    } else if (typeof data === "object" && data !== null) {
        return Object.entries(data).map(([key, value]) => ({
            _key: key,
            ...value,
        }));
    }
    return [];
};

/**
 * 객체의 모든 컬럼 추출
 * @param {Array} dataArray - 데이터 배열
 * @returns {Array} 컬럼 목록
 */
export const extractColumns = (dataArray) => {
    const columnSet = new Set();

    dataArray.forEach((row) => {
        if (typeof row === "object" && row !== null) {
            Object.keys(row).forEach((key) => {
                if (!key.startsWith("_")) {
                    columnSet.add(key);
                }
            });
        }
    });

    return Array.from(columnSet);
};

/**
 * 컬럼명을 읽기 쉬운 형식으로 변환
 * @param {string} column - 컬럼명
 * @returns {string} 변환된 컬럼명
 */
export const formatColumnLabel = (column) => {
    return column.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
};

/**
 * 숫자를 통화 형식으로 포맷
 * @param {number} value - 값
 * @param {string} currency - 통화 코드 (default: 'KRW')
 * @returns {string} 포맷된 문자열
 */
export const formatCurrency = (value, currency = "KRW") => {
    const formatter = new Intl.NumberFormat("ko-KR", {
        style: "currency",
        currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });

    return formatter.format(value);
};

/**
 * 시간을 읽기 쉬운 형식으로 포맷
 * @param {string} timestamp - ISO 시간 문자열
 * @returns {string} 포맷된 시간
 */
export const formatTime = (timestamp) => {
    try {
        const date = new Date(timestamp);
        const y = date.getFullYear();
        const M = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        const h = String(date.getHours()).padStart(2, "0");
        const m = String(date.getMinutes()).padStart(2, "0");
        const s = String(date.getSeconds()).padStart(2, "0");
        return `${y}-${M}-${d} ${h}:${m}:${s}`;
    } catch {
        return timestamp;
    }
};

/**
 * 상대적 시간 표시 (예: "5분 전")
 * @param {string} timestamp - ISO 시간 문자열
 * @returns {string} 상대 시간
 */
export const formatRelativeTime = (timestamp) => {
    try {
        const date = new Date(timestamp);
        const now = new Date();
        const secondsDiff = Math.floor((now - date) / 1000);

        if (secondsDiff < 60) return "방금 전";
        if (secondsDiff < 3600) return `${Math.floor(secondsDiff / 60)}분 전`;
        if (secondsDiff < 86400)
            return `${Math.floor(secondsDiff / 3600)}시간 전`;
        if (secondsDiff < 604800)
            return `${Math.floor(secondsDiff / 86400)}일 전`;

        return formatTime(timestamp);
    } catch {
        return timestamp;
    }
};

/**
 * 바이트를 읽기 쉬운 형식으로 변환
 * @param {number} bytes - 바이트 수
 * @returns {string} 포맷된 텍스트
 */
export const formatBytes = (bytes) => {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};

/**
 * 백분율 포맷
 * @param {number} value - 값 (0-100)
 * @param {number} decimals - 소수점 자리
 * @returns {string} 포맷된 백분율
 */
export const formatPercent = (value, decimals = 1) => {
    return value.toFixed(decimals) + "%";
};

/**
 * 상태값에 따른 CSS 클래스 생성
 * @param {string} status - 상태
 * @returns {string} CSS 클래스 이름
 */
export const getStatusClass = (status) => {
    if (!status) return "";

    const lowerStatus = status.toLowerCase();

    if (
        ["success", "healthy", "active", "ok", "online"].includes(lowerStatus)
    ) {
        return "status-success";
    }

    if (
        ["error", "failed", "critical", "inactive", "offline"].includes(
            lowerStatus,
        )
    ) {
        return "status-error";
    }

    if (["warning", "pending", "busy"].includes(lowerStatus)) {
        return "status-warning";
    }

    return "";
};

/**
 * 상태값에 따른 아이콘 생성
 * @param {string} status - 상태
 * @returns {string} 아이콘 문자
 */
export const getStatusIcon = (status) => {
    if (!status) return "-";

    const lowerStatus = status.toLowerCase();

    if (
        ["success", "healthy", "active", "ok", "online"].includes(lowerStatus)
    ) {
        return "✓";
    }

    if (
        ["error", "failed", "critical", "inactive", "offline"].includes(
            lowerStatus,
        )
    ) {
        return "✗";
    }

    if (["warning", "pending", "busy"].includes(lowerStatus)) {
        return "⚠";
    }

    return "⊘";
};

/**
 * 배열 정렬
 * @param {Array} array - 정렬할 배열
 * @param {string} key - 정렬 기준 키
 * @param {string} direction - 정렬 방향 ('asc' or 'desc')
 * @returns {Array} 정렬된 배열
 */
export const sortArray = (array, key, direction = "asc") => {
    return [...array].sort((a, b) => {
        const aValue = a[key];
        const bValue = b[key];

        if (aValue === null || aValue === undefined) return 1;
        if (bValue === null || bValue === undefined) return -1;

        if (typeof aValue === "string") {
            return direction === "asc"
                ? aValue.localeCompare(bValue)
                : bValue.localeCompare(aValue);
        }

        return direction === "asc" ? aValue - bValue : bValue - aValue;
    });
};

/**
 * 필터링
 * @param {Array} array - 필터링할 배열
 * @param {string} searchText - 검색 텍스트
 * @param {Array} columns - 검색할 컬럼
 * @returns {Array} 필터링된 배열
 */
export const filterArray = (array, searchText, columns = []) => {
    if (!searchText) return array;

    const lowerSearchText = searchText.toLowerCase();

    return array.filter((row) => {
        if (columns.length === 0) {
            // 모든 컬럼에서 검색
            return Object.values(row).some((value) =>
                String(value).toLowerCase().includes(lowerSearchText),
            );
        }

        // 특정 컬럼에서만 검색
        return columns.some((col) =>
            String(row[col]).toLowerCase().includes(lowerSearchText),
        );
    });
};

const coerceComparable = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;

    const text = String(value).trim();
    if (text === "") return "";

    const normalized = text.replace(/,/g, "").replace(/%$/, "");
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) return numeric;

    return text;
};

export const evaluateCriteria = (criterion, rawValue) => {
    if (!criterion?.enabled) return false;

    const operator = criterion.operator ?? ">=";
    const targetRaw = criterion.value ?? "";
    if (String(targetRaw).trim() === "") return false;

    const left = coerceComparable(rawValue);
    const right = coerceComparable(targetRaw);

    if (left === null) return false;

    switch (operator) {
        case ">":
            return left > right;
        case ">=":
            return left >= right;
        case "<":
            return left < right;
        case "<=":
            return left <= right;
        case "==":
            return String(left) === String(right);
        case "!=":
            return String(left) !== String(right);
        case "contains":
            return String(rawValue ?? "").includes(String(targetRaw));
        case "not_contains":
            return !String(rawValue ?? "").includes(String(targetRaw));
        default:
            return false;
    }
};

export const getEnabledCriteriaColumns = (criteriaMap = {}) => {
    return Object.keys(criteriaMap).filter((column) => {
        const criterion = criteriaMap[column];
        return (
            criterion?.enabled && String(criterion?.value ?? "").trim() !== ""
        );
    });
};

export const doesRowMatchCriteria = (row, criteriaMap = {}) => {
    const columns = getEnabledCriteriaColumns(criteriaMap);
    if (columns.length === 0) return false;

    return columns.some((column) =>
        evaluateCriteria(criteriaMap[column], row?.[column]),
    );
};

export const countRowsMatchingCriteria = (rows = [], criteriaMap = {}) => {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    return rows.reduce(
        (count, row) =>
            doesRowMatchCriteria(row, criteriaMap) ? count + 1 : count,
        0,
    );
};

/**
 * 페이지네이션
 * @param {Array} array - 배열
 * @param {number} pageNumber - 페이지 번호 (1부터 시작)
 * @param {number} pageSize - 페이지 크기
 * @returns {Object} {data, total, pages, currentPage}
 */
export const paginate = (array, pageNumber = 1, pageSize = 10) => {
    const total = array.length;
    const pages = Math.ceil(total / pageSize);
    const startIndex = (pageNumber - 1) * pageSize;
    const endIndex = startIndex + pageSize;

    return {
        data: array.slice(startIndex, endIndex),
        total,
        pages,
        currentPage: pageNumber,
    };
};

/**
 * 깊은 복사
 * @param {any} obj - 복사할 객체
 * @returns {any} 복사된 객체
 */
export const deepClone = (obj) => {
    return JSON.parse(JSON.stringify(obj));
};

/**
 * 로컬 스토리지에서 JSON 데이터 가져오기
 * @param {string} key - 저장소 키
 * @param {any} defaultValue - 기본값
 * @returns {any} 저장된 데이터 또는 기본값
 */
export const getFromLocalStorage = (key, defaultValue = null) => {
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
    } catch {
        return defaultValue;
    }
};

/**
 * 로컬 스토리지에 JSON 데이터 저장
 * @param {string} key - 저장소 키
 * @param {any} value - 저장할 값
 */
export const saveToLocalStorage = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.error("Failed to save to localStorage:", error);
    }
};

/**
 * 지연 함수
 * @param {number} ms - 밀리초
 * @returns {Promise}
 */
export const delay = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 재시도 함수
 * @param {Function} fn - 실행할 함수
 * @param {number} maxRetries - 최대 재시도 횟수
 * @param {number} delayMs - 재시도 간격
 * @returns {Promise}
 */
export const retry = async (fn, maxRetries = 3, delayMs = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await delay(delayMs);
        }
    }
};

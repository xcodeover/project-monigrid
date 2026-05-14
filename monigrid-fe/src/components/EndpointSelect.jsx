import { useEffect, useMemo, useState } from "react";
import { endpointService } from "../services/dashboardService";

/**
 * 데이터 API 위젯 (table / line-chart / bar-chart) 에서 widget.endpoint 를
 * BE 등록 API (enabled=true) 중 선택하도록 하는 dropdown.
 *
 * 호환성:
 *  - BE response 의 endpoint 는 항상 relative path (예: "/api/status").
 *  - widget.endpoint 는 과거 사용자가 직접 입력했을 경우 full URL 또는
 *    query string 포함 형태일 수 있다 — 매칭 시 단계적으로 normalize 해서
 *    같은 옵션으로 매핑한다.
 *  - 매칭 실패한 기존 값은 "(등록 외)" 라벨로 보존해 사용자가 모달 열어
 *    저장하지 않아도 정보가 손실되지 않는다.
 *
 * onChange 는 항상 선택된 endpoint 의 path 문자열을 그대로 넘긴다.
 */
const EndpointSelect = ({ id, value, onChange, disabled = false }) => {
    const [catalog, setCatalog] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await endpointService.getApiEndpoints();
                if (cancelled) return;
                setCatalog(Array.isArray(data) ? data : []);
                setError(null);
            } catch (err) {
                if (cancelled) return;
                setError(
                    err?.response?.data?.message ||
                        err?.message ||
                        "데이터 API 목록을 불러올 수 없습니다.",
                );
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // 현재 value 가 catalog 의 어떤 endpoint 와 매칭되는지 — 매칭되면 그 path 를
    // 그대로 사용하고, 안 되면 raw value 를 그대로 select 의 value 로 두고
    // "(등록 외)" 옵션을 추가해 표시한다.
    const matchedOption = useMemo(() => {
        if (!value) return "";
        if (catalog.some((e) => e.endpoint === value)) return value;
        const stripped = value.split("?")[0];
        if (stripped !== value && catalog.some((e) => e.endpoint === stripped)) {
            return stripped;
        }
        try {
            const u = new URL(
                value,
                typeof window !== "undefined" ? window.location.origin : undefined,
            );
            if (catalog.some((e) => e.endpoint === u.pathname)) return u.pathname;
        } catch {
            /* 잘못된 URL — 그대로 raw value 유지 */
        }
        return value;
    }, [value, catalog]);

    const isUnregistered = Boolean(
        value && !catalog.some((e) => e.endpoint === matchedOption),
    );

    return (
        <>
            <select
                id={id}
                value={matchedOption || ""}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled || loading}
            >
                <option value="">— 데이터 API 선택 —</option>
                {catalog.map((ep) => (
                    <option key={ep.id} value={ep.endpoint}>
                        {ep.title || ep.id} · {ep.endpoint}
                    </option>
                ))}
                {isUnregistered && (
                    <option value={value}>(등록 외) {value}</option>
                )}
            </select>
            {error && (
                <span className="form-hint" style={{ color: "#fca5a5" }}>
                    {error}
                </span>
            )}
            {!error && !loading && catalog.length === 0 && (
                <span className="form-hint">
                    등록된 데이터 API 가 없습니다. 백엔드 설정 → 위젯별 설정 →
                    데이터 API 탭에서 먼저 추가하세요.
                </span>
            )}
        </>
    );
};

export default EndpointSelect;

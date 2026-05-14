import React, { useCallback, useEffect, useState } from "react";
import { listMonitorTargetsCached } from "../services/dashboardService";
import "./MonitorTargetPicker.css";

/**
 * 백엔드 설정의 "서버/네트워크 체크" 탭에 등록된 모니터 대상을 다중 선택하는 픽커.
 *
 * 두 가지 사용 모드:
 *  1) 데이터 자체를 자체 로드 (presetTargets 가 비어있을 때): 마운트 시 listTargets 호출
 *  2) 부모가 미리 로드한 목록을 주입 (presetTargets / presetError 사용): 추가 호출 없음
 *
 * @param {object} props
 * @param {"server_resource"|"network"|"http_status"} props.targetType  필터링할 모니터 대상 타입
 * @param {string[]} props.selectedIds                    현재 선택된 id 배열
 * @param {(ids: string[]) => void} props.onChange        선택 변경 콜백
 * @param {Array}    [props.presetTargets]                부모가 이미 로드한 목록(있으면 자체 로드 안함)
 * @param {string|null} [props.presetError]               부모가 가진 에러 메시지
 * @param {string}   [props.emptyHint]                    빈 목록 안내 문구
 */
const MonitorTargetPicker = ({
    targetType,
    selectedIds = [],
    onChange,
    presetTargets,
    presetError = null,
    emptyHint,
}) => {
    const usingPreset = Array.isArray(presetTargets);
    const [targets, setTargets] = useState(usingPreset ? presetTargets : []);
    const [loading, setLoading] = useState(!usingPreset);
    const [error, setError] = useState(presetError);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const data = await listMonitorTargetsCached();
            setTargets(Array.isArray(data?.targets) ? data.targets : []);
            setError(null);
        } catch (err) {
            setError(
                err?.response?.data?.message ||
                    err?.message ||
                    "모니터 대상을 불러올 수 없습니다.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (usingPreset) {
            setTargets(presetTargets);
            setError(presetError);
            setLoading(false);
            return;
        }
        reload();
    }, [usingPreset, presetTargets, presetError, reload]);

    const filtered = targets.filter((t) => t.type === targetType);
    const selectedSet = new Set(selectedIds);

    const toggle = (id) => {
        const next = selectedSet.has(id)
            ? selectedIds.filter((x) => x !== id)
            : [...selectedIds, id];
        onChange(next);
    };

    // 전체 선택은 현재 필터 결과 (= 보이는 목록) 의 id 합집합. 비활성(enabled=false)
    // 대상도 라벨에서 선택 가능하니 전체 선택에도 포함시킨다 — 사용자는 토글로
    // 개별 제외 가능. 전체 해제는 현재 보이는 id 만 selection 에서 빼고 그 외
    // (다른 타입에서 선택된 id) 는 보존 — picker 는 단일 타입을 다루지만
    // selectedIds 자체는 부모가 다른 타입과 공유할 수 있다.
    const filteredIds = filtered.map((t) => t.id);
    const allChecked = filtered.length > 0 && filteredIds.every((id) => selectedSet.has(id));
    const toggleAll = () => {
        if (allChecked) {
            onChange(selectedIds.filter((id) => !filteredIds.includes(id)));
        } else {
            const merged = new Set(selectedIds);
            filteredIds.forEach((id) => merged.add(id));
            onChange(Array.from(merged));
        }
    };

    if (loading) {
        return <div className="target-pick-hint">불러오는 중...</div>;
    }
    if (error) {
        return (
            <div className="target-pick-hint target-pick-hint-error">{error}</div>
        );
    }
    if (filtered.length === 0) {
        const defaultEmptyHintByType = {
            server_resource:
                '등록된 대상이 없습니다. 백엔드 설정 → "서버 리소스" 탭에서 먼저 추가하세요.',
            network:
                '등록된 대상이 없습니다. 백엔드 설정 → "네트워크 체크" 탭에서 먼저 추가하세요.',
            http_status:
                '등록된 대상이 없습니다. 백엔드 설정 → "API 상태" 탭에서 먼저 추가하세요.',
        };
        return (
            <div className="target-pick-hint">
                {emptyHint ||
                    defaultEmptyHintByType[targetType] ||
                    "등록된 대상이 없습니다."}
            </div>
        );
    }

    const someChecked = filteredIds.some((id) => selectedSet.has(id)) && !allChecked;

    return (
        <div className="target-pick-list">
            <label className="target-pick-row target-pick-row-all">
                <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => {
                        // indeterminate 는 DOM property only — JSX prop 으로 지정 불가
                        if (el) el.indeterminate = someChecked;
                    }}
                    onChange={toggleAll}
                />
                <div className="target-pick-title">
                    전체 선택 ({filtered.length}개)
                </div>
                <div className="target-pick-sub">
                    {selectedIds.filter((id) => filteredIds.includes(id)).length}개 선택됨
                </div>
            </label>
            {filtered.map((t) => {
                const checked = selectedSet.has(t.id);
                const sub =
                    targetType === "server_resource"
                        ? `${t.spec?.os_type || "-"} · ${t.spec?.host || "-"}`
                        : targetType === "http_status"
                          ? `${t.spec?.url || "-"}`
                          : `${(t.spec?.type || "ping").toUpperCase()} · ${t.spec?.host || "-"}${
                                t.spec?.type === "telnet" && t.spec?.port
                                    ? `:${t.spec.port}`
                                    : ""
                            }`;
                return (
                    <label
                        key={t.id}
                        className={`target-pick-row${checked ? " checked" : ""}${!t.enabled ? " disabled" : ""}`}
                    >
                        <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(t.id)}
                        />
                        <div className="target-pick-title">
                            {t.label || t.id}
                            {!t.enabled && (
                                <span className="target-pick-badge">꺼짐</span>
                            )}
                        </div>
                        <div className="target-pick-sub">
                            {t.id} · {sub}
                        </div>
                    </label>
                );
            })}
        </div>
    );
};

export default MonitorTargetPicker;

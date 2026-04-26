import React, { useCallback, useEffect, useState } from "react";
import { monitorService } from "../services/dashboardService";
import "./MonitorTargetPicker.css";

/**
 * 백엔드 설정의 "서버/네트워크 체크" 탭에 등록된 모니터 대상을 다중 선택하는 픽커.
 *
 * 두 가지 사용 모드:
 *  1) 데이터 자체를 자체 로드 (presetTargets 가 비어있을 때): 마운트 시 listTargets 호출
 *  2) 부모가 미리 로드한 목록을 주입 (presetTargets / presetError 사용): 추가 호출 없음
 *
 * @param {object} props
 * @param {"server_resource"|"network"} props.targetType  필터링할 모니터 대상 타입
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
            const data = await monitorService.listTargets();
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

    if (loading) {
        return <div className="target-pick-hint">불러오는 중...</div>;
    }
    if (error) {
        return (
            <div className="target-pick-hint target-pick-hint-error">{error}</div>
        );
    }
    if (filtered.length === 0) {
        return (
            <div className="target-pick-hint">
                {emptyHint ||
                    '등록된 대상이 없습니다. 백엔드 설정 → "서버/네트워크 체크" 탭에서 먼저 추가하세요.'}
            </div>
        );
    }

    return (
        <div className="target-pick-list">
            {filtered.map((t) => {
                const checked = selectedSet.has(t.id);
                const sub =
                    targetType === "server_resource"
                        ? `${t.spec?.os_type || "-"} · ${t.spec?.host || "-"}`
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
                        <div className="target-pick-meta">
                            <div className="target-pick-title">
                                {t.label || t.id}
                                {!t.enabled && (
                                    <span className="target-pick-badge">꺼짐</span>
                                )}
                            </div>
                            <div className="target-pick-sub">
                                {t.id} · {sub}
                            </div>
                        </div>
                    </label>
                );
            })}
        </div>
    );
};

export default MonitorTargetPicker;

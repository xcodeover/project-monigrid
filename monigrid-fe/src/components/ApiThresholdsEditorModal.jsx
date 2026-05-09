import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { widgetConfigService } from "../services/api";
import { IconClose, IconPlus, IconTrash } from "./icons";
import "./ApiThresholdsEditorModal.css";

/**
 * 데이터 API row 에서 진입하는 알람 임계치 편집 모달.
 *
 * 정책:
 *   - 임계치는 (api_id, widget_type=table) 한 군데에만 저장. BE 평가는 같은
 *     api_id 의 thresholds 를 모든 widget_type 에 공유 적용 — 사용자가 표/
 *     차트 widget_type 별로 임계치를 따로 입력할 필요 없음 (UX 단순화).
 *   - 자체 저장 버튼: 모달 안에서 즉시 PUT /dashboard/widget-configs.
 *     ConfigEditorPage 의 footer 단일 저장 흐름과 분리 — row-scoped 작업이라
 *     "전체 저장" 시 다른 변경과 묶일 필요 없음.
 */

const OPERATORS = [
    { value: ">=", label: "≥ (이상)" },
    { value: ">", label: "> (초과)" },
    { value: "<=", label: "≤ (이하)" },
    { value: "<", label: "< (미만)" },
    { value: "=", label: "= (같음)" },
    { value: "!=", label: "≠ (다름)" },
    { value: "contains", label: "contains" },
];

const LEVELS = [
    { value: "warn", label: "WARN" },
    { value: "critical", label: "CRITICAL" },
];

const STORAGE_WIDGET_TYPE = "table";

function deepClone(value) { return JSON.parse(JSON.stringify(value)); }
function configsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const EMPTY_THRESHOLDS = [];

const ApiThresholdsEditorModal = ({ open, apiId, apiTitle, onClose, onSaved }) => {
    const [serverThresholds, setServerThresholds] = useState(EMPTY_THRESHOLDS);
    const [draft, setDraft] = useState(EMPTY_THRESHOLDS);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);

    const load = useCallback(async () => {
        if (!apiId) return;
        setLoading(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const row = await widgetConfigService.get(apiId, STORAGE_WIDGET_TYPE);
            const ths = Array.isArray(row?.config?.thresholds) ? row.config.thresholds : [];
            const normalized = ths.map((t) => ({
                column: String(t?.column ?? ""),
                operator: String(t?.operator ?? ">="),
                value: t?.value ?? "",
                level: String(t?.level ?? "warn"),
                message: String(t?.message ?? ""),
            }));
            setServerThresholds(normalized);
            setDraft(deepClone(normalized));
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "임계치를 불러올 수 없습니다.");
        } finally {
            setLoading(false);
        }
    }, [apiId]);

    useEffect(() => {
        if (open && apiId) load();
    }, [open, apiId, load]);

    const isDirty = useMemo(() => !configsEqual(serverThresholds, draft), [serverThresholds, draft]);

    const addRow = () => setDraft((prev) => [
        ...prev,
        { column: "", operator: ">=", value: "", level: "warn", message: "" },
    ]);
    const updateRow = (idx, field, value) => setDraft((prev) =>
        prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
    );
    const removeRow = (idx) => setDraft((prev) => prev.filter((_, i) => i !== idx));
    const resetDraft = () => setDraft(deepClone(serverThresholds));

    const handleSave = async () => {
        for (let i = 0; i < draft.length; i += 1) {
            const t = draft[i];
            if (!t.column?.trim()) {
                setError(`임계치 #${i + 1}: column 이 비어 있습니다.`);
                return;
            }
            if (!t.operator) {
                setError(`임계치 #${i + 1}: operator 가 비어 있습니다.`);
                return;
            }
        }
        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const normalized = draft.map((t) => {
                const isNumOp = [">", ">=", "<", "<="].includes(t.operator);
                if (isNumOp && t.value !== "" && t.value !== null && !Number.isNaN(Number(t.value))) {
                    return { ...t, value: Number(t.value) };
                }
                return t;
            });
            await widgetConfigService.save(apiId, STORAGE_WIDGET_TYPE, {
                thresholds: normalized,
            });
            setServerThresholds(normalized);
            setDraft(deepClone(normalized));
            setSuccessMsg("저장 완료");
            onSaved?.();
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteAll = async () => {
        if (!serverThresholds.length) {
            // 서버에 저장된 게 없으면 단순히 모달 닫기
            onClose?.();
            return;
        }
        const ok = window.confirm(
            `${apiId} 의 모든 임계치를 삭제하시겠습니까?\n` +
            `BE 알람 평가가 이 API 에 대해 동작하지 않습니다.`,
        );
        if (!ok) return;
        setSaving(true);
        setError(null);
        try {
            await widgetConfigService.remove(apiId, STORAGE_WIDGET_TYPE);
            setServerThresholds(EMPTY_THRESHOLDS);
            setDraft(EMPTY_THRESHOLDS);
            setSuccessMsg("삭제 완료");
            onSaved?.();
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "삭제 실패");
        } finally {
            setSaving(false);
        }
    };

    if (!open) return null;

    const stop = (e) => e.stopPropagation();

    const content = (
        <div className="ate-overlay" onMouseDown={stop} onClick={stop}>
            <div className="ate-modal" onMouseDown={stop} onClick={stop}>
                <header className="ate-header">
                    <div className="ate-title-wrap">
                        <h3>알람 임계치</h3>
                        <p>
                            <span className="ate-api-id">{apiId}</span>
                            {apiTitle && apiTitle !== apiId && <span className="ate-api-title"> · {apiTitle}</span>}
                        </p>
                    </div>
                    <button
                        type="button"
                        className="ate-close-btn"
                        onClick={onClose}
                        aria-label="닫기"
                    >
                        <IconClose size={16} />
                    </button>
                </header>

                <div className="ate-body">
                    {loading ? (
                        <div className="ate-loading">불러오는 중...</div>
                    ) : (
                        <>
                            <div className="ate-hint">
                                BE 가 데이터 API 캐시 갱신 직후 모든 row 에 대해 아래 임계치를 평가합니다.
                                위반 transition 발생 시 알람 이벤트가 자동 기록됩니다.
                            </div>

                            <div className="ate-add-row">
                                <button
                                    type="button"
                                    className="cfg-add-btn"
                                    onClick={addRow}
                                    disabled={saving}
                                >
                                    <IconPlus size={14} /> 임계치 추가
                                </button>
                                <span className="ate-count">{draft.length} 건</span>
                            </div>

                            {draft.length === 0 ? (
                                <div className="ate-empty">정의된 임계치가 없습니다.</div>
                            ) : (
                                <div className="ate-grid">
                                    <div className="ate-grid-row ate-grid-head">
                                        <span>Column</span>
                                        <span>Operator</span>
                                        <span>Value</span>
                                        <span>Level</span>
                                        <span>Message</span>
                                        <span></span>
                                    </div>
                                    {draft.map((th, idx) => (
                                        <div key={idx} className="ate-grid-row">
                                            <input
                                                type="text"
                                                value={th.column}
                                                onChange={(e) => updateRow(idx, "column", e.target.value)}
                                                placeholder="cpu_pct"
                                                disabled={saving}
                                            />
                                            <select
                                                value={th.operator}
                                                onChange={(e) => updateRow(idx, "operator", e.target.value)}
                                                disabled={saving}
                                            >
                                                {OPERATORS.map((op) => (
                                                    <option key={op.value} value={op.value}>{op.label}</option>
                                                ))}
                                            </select>
                                            <input
                                                type="text"
                                                value={th.value}
                                                onChange={(e) => updateRow(idx, "value", e.target.value)}
                                                placeholder="80"
                                                disabled={saving}
                                            />
                                            <select
                                                value={th.level}
                                                onChange={(e) => updateRow(idx, "level", e.target.value)}
                                                disabled={saving}
                                            >
                                                {LEVELS.map((lv) => (
                                                    <option key={lv.value} value={lv.value}>{lv.label}</option>
                                                ))}
                                            </select>
                                            <input
                                                type="text"
                                                value={th.message}
                                                onChange={(e) => updateRow(idx, "message", e.target.value)}
                                                placeholder="(선택) 사람-친화 메시지"
                                                disabled={saving}
                                            />
                                            <button
                                                type="button"
                                                className="cfg-remove-btn"
                                                onClick={() => removeRow(idx)}
                                                disabled={saving}
                                                title="삭제"
                                            >
                                                <IconTrash size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>

                <footer className="ate-footer">
                    <span className={`ate-dirty${isDirty ? " ate-dirty-on" : ""}`}>
                        {isDirty ? "변경 사항: 미저장" : "변경 사항 없음"}
                    </span>
                    {error && <span className="ate-error">{error}</span>}
                    {successMsg && <span className="ate-success">{successMsg}</span>}
                    <div className="ate-footer-right">
                        {isDirty && (
                            <button
                                type="button"
                                className="cfg-footer-btn cfg-btn-secondary"
                                onClick={resetDraft}
                                disabled={saving}
                            >
                                되돌리기
                            </button>
                        )}
                        <button
                            type="button"
                            className="cfg-footer-btn cfg-btn-secondary"
                            onClick={handleDeleteAll}
                            disabled={saving || loading}
                            title="이 API 의 임계치 전체 삭제"
                        >
                            전체 삭제
                        </button>
                        <button
                            type="button"
                            className="cfg-footer-btn cfg-btn-secondary"
                            onClick={onClose}
                            disabled={saving}
                        >
                            닫기
                        </button>
                        <button
                            type="button"
                            className="cfg-footer-btn cfg-btn-primary"
                            onClick={handleSave}
                            disabled={!isDirty || saving || loading}
                        >
                            {saving ? "저장 중..." : "저장 & 적용"}
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );

    return createPortal(content, document.body);
};

export default ApiThresholdsEditorModal;

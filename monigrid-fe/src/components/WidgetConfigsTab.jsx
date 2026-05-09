import React, { useCallback, useEffect, useMemo, useState } from "react";
import { configService, widgetConfigService } from "../services/api";
import { IconClose, IconPlus, IconRefresh, IconTrash } from "./icons";

/* ── Constants ────────────────────────────────────────────────── */

const WIDGET_TYPES = [
    { value: "table", label: "표 (Table)" },
    { value: "line-chart", label: "라인 차트" },
    { value: "bar-chart", label: "바 차트" },
];

const OPERATORS = [
    { value: ">=", label: "≥ (이상)" },
    { value: ">", label: "> (초과)" },
    { value: "<=", label: "≤ (이하)" },
    { value: "<", label: "< (미만)" },
    { value: "=", label: "= (같음)" },
    { value: "!=", label: "≠ (다름)" },
    { value: "contains", label: "contains (포함)" },
];

const LEVELS = [
    { value: "warn", label: "WARN" },
    { value: "critical", label: "CRITICAL" },
];

// 표시 컬럼은 BE 가 관리하지 않는다 — FE 가 BE 쿼리 결과(SQL SELECT 컬럼) 순서를
// 그대로 따른다. 임계치만 (api_id, widget_type) 단위로 중앙 관리.
const EMPTY_CONFIG = { thresholds: [] };

/* ── Helpers ──────────────────────────────────────────────────── */

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function configsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object") return deepClone(EMPTY_CONFIG);
    return {
        thresholds: Array.isArray(raw.thresholds)
            ? raw.thresholds.map((t) => ({
                  column: String(t?.column ?? ""),
                  operator: String(t?.operator ?? ">="),
                  value: t?.value ?? "",
                  level: String(t?.level ?? "warn"),
                  message: String(t?.message ?? ""),
              }))
            : [],
    };
}

/* ══════════════════════════════════════════════════════════════════
   WidgetConfigsTab
   ══════════════════════════════════════════════════════════════════ */

/**
 * Phase 2 (revised): data API 단위로 알람 임계치만 중앙 관리한다.
 *
 * 표시 컬럼은 BE 쿼리(SQL SELECT) 의 컬럼 순서를 FE 가 그대로 따르므로
 * 별도 입력 UI 가 없다. 사용자별 위젯 크기 / 컬럼 너비는 user_preferences.
 */
export default function WidgetConfigsTab() {
    const [apis, setApis] = useState([]);
    const [apisLoading, setApisLoading] = useState(true);
    const [apisError, setApisError] = useState(null);

    const [apiId, setApiId] = useState("");
    const [widgetType, setWidgetType] = useState(WIDGET_TYPES[0].value);

    const [serverConfig, setServerConfig] = useState(deepClone(EMPTY_CONFIG));
    const [draft, setDraft] = useState(deepClone(EMPTY_CONFIG));
    const [exists, setExists] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);

    const loadApis = useCallback(async () => {
        setApisLoading(true);
        setApisError(null);
        try {
            const cfg = await configService.getConfig();
            const list = Array.isArray(cfg?.apis) ? cfg.apis : [];
            setApis(list);
            if (!apiId && list.length > 0) {
                setApiId(list[0].id || "");
            }
        } catch (e) {
            setApisError(e?.response?.data?.message || e?.message || "데이터 API 목록을 불러올 수 없습니다.");
        } finally {
            setApisLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => { loadApis(); }, [loadApis]);

    const loadConfig = useCallback(async () => {
        if (!apiId || !widgetType) return;
        setLoading(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const row = await widgetConfigService.get(apiId, widgetType);
            if (row) {
                const cfg = normalizeConfig(row.config);
                setServerConfig(cfg);
                setDraft(deepClone(cfg));
                setExists(true);
            } else {
                const empty = deepClone(EMPTY_CONFIG);
                setServerConfig(empty);
                setDraft(deepClone(empty));
                setExists(false);
            }
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "위젯 설정을 불러올 수 없습니다.");
        } finally {
            setLoading(false);
        }
    }, [apiId, widgetType]);

    useEffect(() => { loadConfig(); }, [loadConfig]);

    const isDirty = useMemo(() => !configsEqual(serverConfig, draft), [serverConfig, draft]);

    /* ── 임계치 ──────────────────────────────────────────── */
    const handleThresholdAdd = () => {
        setDraft((prev) => ({
            ...prev,
            thresholds: [...prev.thresholds, {
                column: "", operator: ">=", value: "", level: "warn", message: "",
            }],
        }));
    };
    const handleThresholdChange = (idx, field, value) => {
        setDraft((prev) => ({
            ...prev,
            thresholds: prev.thresholds.map((t, i) =>
                i === idx ? { ...t, [field]: value } : t,
            ),
        }));
    };
    const handleThresholdRemove = (idx) => {
        setDraft((prev) => ({
            ...prev,
            thresholds: prev.thresholds.filter((_, i) => i !== idx),
        }));
    };

    /* ── 저장 / 삭제 ────────────────────────────────────── */
    const handleSave = async () => {
        if (!apiId) return;
        for (let i = 0; i < draft.thresholds.length; i += 1) {
            const t = draft.thresholds[i];
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
            const normalizedThresholds = draft.thresholds.map((t) => {
                const isNumOp = [">", ">=", "<", "<="].includes(t.operator);
                if (isNumOp && t.value !== "" && t.value !== null && !Number.isNaN(Number(t.value))) {
                    return { ...t, value: Number(t.value) };
                }
                return t;
            });
            const payload = { thresholds: normalizedThresholds };
            await widgetConfigService.save(apiId, widgetType, payload);
            setSuccessMsg("저장 완료");
            setServerConfig(payload);
            setDraft(deepClone(payload));
            setExists(true);
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!apiId || !exists) return;
        const ok = window.confirm(
            `${apiId} / ${widgetType} 의 임계치 설정을 삭제하시겠습니까?\n` +
            `삭제 시 BE 알람 평가는 이 (api, widget) 조합에 대해 동작하지 않습니다.`,
        );
        if (!ok) return;
        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            await widgetConfigService.remove(apiId, widgetType);
            const empty = deepClone(EMPTY_CONFIG);
            setServerConfig(empty);
            setDraft(deepClone(empty));
            setExists(false);
            setSuccessMsg("삭제 완료");
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "삭제 실패");
        } finally {
            setSaving(false);
        }
    };

    const handleResetDraft = () => {
        setDraft(deepClone(serverConfig));
    };

    const apiOptions = apis.map((a) => ({
        value: a.id,
        label: a.title ? `${a.id} — ${a.title}` : a.id,
    }));

    return (
        <div className="cfg-section wcfg-pane">
            <div className="cfg-section-header wcfg-header">
                <div className="wcfg-header-selectors">
                    <label className="wcfg-selector">
                        <span>data API</span>
                        <select
                            value={apiId}
                            onChange={(e) => setApiId(e.target.value)}
                            disabled={apisLoading || saving}
                        >
                            <option value="">-- 선택 --</option>
                            {apiOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </label>
                    <label className="wcfg-selector">
                        <span>위젯 종류</span>
                        <select
                            value={widgetType}
                            onChange={(e) => setWidgetType(e.target.value)}
                            disabled={saving}
                        >
                            {WIDGET_TYPES.map((wt) => (
                                <option key={wt.value} value={wt.value}>{wt.label}</option>
                            ))}
                        </select>
                    </label>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        type="button"
                        className="cfg-add-btn"
                        onClick={loadConfig}
                        disabled={loading || saving}
                        title="새로고침"
                    >
                        <IconRefresh size={14} /> 새로고침
                    </button>
                </div>
            </div>

            {apisError && <div className="cfg-msg cfg-msg-error">{apisError}</div>}

            <div className="wcfg-body">
                {!apiId ? (
                    <div className="cfg-empty">data API 를 먼저 선택하세요.</div>
                ) : loading ? (
                    <div className="cfg-loading">불러오는 중...</div>
                ) : (
                    <>
                        <div className="wcfg-hint">
                            표시 컬럼은 BE 쿼리(SQL SELECT) 의 컬럼 순서를 그대로 따릅니다.
                            여기서는 알람 임계치만 (data API, 위젯 종류) 단위로 중앙 관리합니다.
                            {!exists && (
                                <> <strong>현재 ({apiId}, {widgetType}) 에 대한 설정 행이 없습니다 — 항목을 추가하고 저장하면 새로 생성됩니다.</strong></>
                            )}
                        </div>

                        <section className="wcfg-group">
                            <header className="wcfg-group-header">
                                <h3>알람 임계치</h3>
                                <button
                                    type="button"
                                    className="cfg-add-btn"
                                    onClick={handleThresholdAdd}
                                    disabled={saving}
                                >
                                    <IconPlus size={14} /> 임계치 추가
                                </button>
                            </header>
                            {draft.thresholds.length === 0 ? (
                                <div className="cfg-empty">정의된 임계치가 없습니다.</div>
                            ) : (
                                <div className="wcfg-table wcfg-table-thresholds">
                                    <div className="wcfg-row wcfg-row-head">
                                        <span>Column</span>
                                        <span>Operator</span>
                                        <span>Value</span>
                                        <span>Level</span>
                                        <span>Message</span>
                                        <span></span>
                                    </div>
                                    {draft.thresholds.map((th, idx) => (
                                        <div key={idx} className="wcfg-row">
                                            <input
                                                type="text"
                                                value={th.column}
                                                onChange={(e) => handleThresholdChange(idx, "column", e.target.value)}
                                                placeholder="cpu_pct"
                                                disabled={saving}
                                            />
                                            <select
                                                value={th.operator}
                                                onChange={(e) => handleThresholdChange(idx, "operator", e.target.value)}
                                                disabled={saving}
                                            >
                                                {OPERATORS.map((op) => (
                                                    <option key={op.value} value={op.value}>{op.label}</option>
                                                ))}
                                            </select>
                                            <input
                                                type="text"
                                                value={th.value}
                                                onChange={(e) => handleThresholdChange(idx, "value", e.target.value)}
                                                placeholder="80"
                                                disabled={saving}
                                            />
                                            <select
                                                value={th.level}
                                                onChange={(e) => handleThresholdChange(idx, "level", e.target.value)}
                                                disabled={saving}
                                            >
                                                {LEVELS.map((lv) => (
                                                    <option key={lv.value} value={lv.value}>{lv.label}</option>
                                                ))}
                                            </select>
                                            <input
                                                type="text"
                                                value={th.message}
                                                onChange={(e) => handleThresholdChange(idx, "message", e.target.value)}
                                                placeholder="(선택) 사람-친화 메시지"
                                                disabled={saving}
                                            />
                                            <button
                                                type="button"
                                                className="cfg-remove-btn"
                                                onClick={() => handleThresholdRemove(idx)}
                                                disabled={saving}
                                                title="삭제"
                                            >
                                                <IconTrash size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>
                    </>
                )}
            </div>

            <div className="dirty-list-summary wcfg-footer">
                <span className={`dls-summary-text${isDirty ? "" : " dls-summary-empty"}`}>
                    {isDirty ? "변경 사항: 미저장" : "변경 사항 없음"}
                </span>
                {error && <span className="dls-invalid-badge">{error}</span>}
                {successMsg && <span className="wcfg-success">{successMsg}</span>}
                <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                    {isDirty && (
                        <button
                            type="button"
                            className="cfg-footer-btn cfg-btn-secondary"
                            onClick={handleResetDraft}
                            disabled={saving}
                        >
                            되돌리기
                        </button>
                    )}
                    {exists && (
                        <button
                            type="button"
                            className="cfg-footer-btn cfg-btn-secondary"
                            onClick={handleDelete}
                            disabled={saving || loading}
                            title="이 (api, widget) 의 중앙 설정 행 삭제"
                        >
                            <IconClose size={14} /> 삭제
                        </button>
                    )}
                    <button
                        type="button"
                        className="dls-save-btn"
                        onClick={handleSave}
                        disabled={!isDirty || saving || loading || !apiId}
                    >
                        {saving ? "저장 중…" : "저장 & 적용"}
                    </button>
                </div>
            </div>
        </div>
    );
}

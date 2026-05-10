import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { configService } from "../services/api";
import { useDirtyList } from "../hooks/useDirtyList";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import DirtyListSummary from "./DirtyListSummary";
import PasswordInput from "./PasswordInput";
import MonitorTargetsTab from "./MonitorTargetsTab";
import {
    IconChevronRight,
    IconClose,
    IconCopy,
    IconPlus,
    IconTrash,
} from "./icons";
import "./ConfigEditorModal.css";

/* ── Section metadata for the config editor ────────────────────── */

const OS_TYPE_LABELS = {
    oracle: "Oracle",
    mariadb: "MariaDB",
    mssql: "MS SQL Server",
};

const LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];

/* ── Helpers ───────────────────────────────────────────────────── */

// "status" → "status-2", "ms-sql-123" → "ms-sql-124". Mirrors the pattern used
// by the server-resource widget so the copy UX feels consistent across modals.
const incrementLabel = (label) => {
    const text = String(label || "");
    const m = text.match(/^(.*?)(\d+)$/);
    if (m) return m[1] + (parseInt(m[2], 10) + 1);
    return text ? `${text}-2` : "";
};

const nextAvailable = (label, existing) => {
    let candidate = incrementLabel(label);
    while (candidate && existing.has(candidate)) {
        candidate = incrementLabel(candidate);
    }
    return candidate;
};

const insertAfter = (arr, idx, item) => [
    ...arr.slice(0, idx + 1),
    item,
    ...arr.slice(idx + 1),
];

// Shift index-keyed collapsed-state map so entries after `idx` move down by one,
// and mark the newly inserted slot (idx+1) as expanded.
const shiftCollapsedForInsert = (prev, idx) => {
    const next = {};
    Object.keys(prev).forEach((k) => {
        const i = Number(k);
        if (i <= idx) next[i] = prev[k];
        else next[i + 1] = prev[k];
    });
    next[idx + 1] = false;
    return next;
};

/* ── Sub-components ────────────────────────────────────────────── */

const ConnectionEditor = ({ conn, index, onChange, onRemove, onDuplicate, collapsed, onToggle }) => {
    const update = (field, value) => onChange(index, { ...conn, [field]: value });
    return (
        <div className={`cfg-card ${collapsed ? "cfg-card-collapsed" : ""}`}>
            <div className="cfg-card-header" onClick={onToggle} style={{ cursor: "pointer" }}>
                <span className={`cfg-card-chevron ${collapsed ? "" : "open"}`}><IconChevronRight size={12} /></span>
                <span className="cfg-card-title">{conn.id || `Connection ${index + 1}`}</span>
                <span className="cfg-card-badge">{OS_TYPE_LABELS[conn.db_type] || conn.db_type}</span>
                <button type="button" className="cfg-duplicate-btn" onClick={(e) => { e.stopPropagation(); onDuplicate(index); }} title="복제"><IconCopy size={14} /></button>
                <button type="button" className="cfg-remove-btn" onClick={(e) => { e.stopPropagation(); onRemove(index); }} title="삭제"><IconTrash size={14} /></button>
            </div>
            {!collapsed && (
                <div className="cfg-card-body">
                    <div className="cfg-row-2">
                        <label><span>Connection ID</span>
                            <input type="text" value={conn.id || ""} onChange={(e) => update("id", e.target.value)} placeholder="oracle-main" />
                        </label>
                        <label><span>DB 타입</span>
                            <select value={conn.db_type || ""} onChange={(e) => update("db_type", e.target.value)}>
                                <option value="oracle">Oracle</option>
                                <option value="mariadb">MariaDB</option>
                                <option value="mssql">MS SQL Server</option>
                            </select>
                        </label>
                    </div>
                    <label><span>JDBC Driver Class</span>
                        <input type="text" value={conn.jdbc_driver_class || ""} onChange={(e) => update("jdbc_driver_class", e.target.value)} placeholder="oracle.jdbc.OracleDriver" />
                    </label>
                    <label><span>JDBC URL</span>
                        <input type="text" value={conn.jdbc_url || ""} onChange={(e) => update("jdbc_url", e.target.value)} placeholder="jdbc:oracle:thin:@//localhost:1521/XEPDB1" />
                    </label>
                    <div className="cfg-row-2">
                        <label><span>사용자</span>
                            <input type="text" value={conn.username || ""} onChange={(e) => update("username", e.target.value)} />
                        </label>
                        <label><span>비밀번호</span>
                            <PasswordInput value={conn.password || ""} onChange={(e) => update("password", e.target.value)} />
                        </label>
                    </div>
                </div>
            )}
        </div>
    );
};

/**
 * ApiEndpointEditor — card for a single data API endpoint.
 * Augmented with dirty-state styling (rowStateClass) and soft-delete restore.
 */
const ApiEndpointEditor = ({
    api,
    rowStateClass,
    validationError,
    connectionIds,
    onUpdate,
    onRemove,
    onRestore,
    onDuplicate,
    collapsed,
    onToggle,
}) => {
    const update = (field, value) => onUpdate({ ...api, [field]: value });
    const isDeleted = !!api._isDeleted;

    const cardClasses = [
        "cfg-card",
        collapsed ? "cfg-card-collapsed" : "",
        rowStateClass || "",
        validationError ? "row-state-invalid" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={cardClasses} data-row-id={api.id}>
            <div className="cfg-card-header" onClick={onToggle} style={{ cursor: "pointer" }}>
                <span className={`cfg-card-chevron ${collapsed ? "" : "open"}`}><IconChevronRight size={12} /></span>
                {!isDeleted && (
                    <label className="cfg-toggle" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={api.enabled ?? false} onChange={(e) => update("enabled", e.target.checked)} />
                        <span className="cfg-toggle-slider" />
                    </label>
                )}
                <span className="cfg-card-title">{api.id || "(ID 없음)"}</span>
                <span className="cfg-card-badge">{api.rest_api_path || "/"}</span>
                {api._isNew && <span className="cfg-card-badge">신규</span>}
                {isDeleted && <span className="cfg-card-badge" style={{ color: "#ff6b6b" }}>삭제 예정</span>}
                {!isDeleted && (
                    <button type="button" className="cfg-duplicate-btn" onClick={(e) => { e.stopPropagation(); onDuplicate(); }} title="복제"><IconCopy size={14} /></button>
                )}
                {isDeleted ? (
                    <button type="button" className="row-restore-btn" onClick={(e) => { e.stopPropagation(); onRestore(); }} title="복원" aria-label="복원">
                        ↺ 복원
                    </button>
                ) : (
                    <button type="button" className="cfg-remove-btn" onClick={(e) => { e.stopPropagation(); onRemove(); }} title="삭제"><IconTrash size={14} /></button>
                )}
            </div>
            {!collapsed && !isDeleted && (
                <div className="cfg-card-body">
                    <div className="cfg-row-2">
                        <label><span>API ID</span>
                            <input
                                type="text"
                                value={api.id || ""}
                                onChange={(e) => update("id", e.target.value)}
                                placeholder="status"
                                disabled={!api._isNew}
                            />
                        </label>
                        <label><span>REST API Path</span>
                            <input type="text" value={api.rest_api_path || ""} onChange={(e) => update("rest_api_path", e.target.value)} placeholder="/api/status" />
                        </label>
                    </div>
                    <div className="cfg-row-3">
                        <label><span>Connection</span>
                            <select value={api.connection_id || ""} onChange={(e) => update("connection_id", e.target.value)}>
                                <option value="">-- 선택 --</option>
                                {connectionIds.map((id) => (
                                    <option key={id} value={id}>{id}</option>
                                ))}
                            </select>
                        </label>
                        <label><span>SQL ID</span>
                            <input type="text" value={api.sql_id || ""} onChange={(e) => update("sql_id", e.target.value)} placeholder="status" />
                        </label>
                        <label><span>갱신 주기(초)</span>
                            <input type="number" value={api.refresh_interval_sec ?? 5} onChange={(e) => update("refresh_interval_sec", Number(e.target.value))} min="1" max="3600" />
                        </label>
                    </div>
                    {validationError && (
                        <div className="row-state-invalid-msg">{validationError}</div>
                    )}
                </div>
            )}
        </div>
    );
};

/* ── Endpoint validator (spec §5.1) ───────────────────────────── */

function buildEndpointValidator(allItems) {
    return (item) => {
        const id = (item.id || "").trim();
        if (!id) return "API ID는 필수입니다.";
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return "API ID는 영문자·숫자·밑줄·하이픈만 허용됩니다.";

        // duplicate check (ignore the item's own entry)
        const dupCount = allItems.filter(
            (it) => !it._isDeleted && (it.id || "").trim() === id && it !== item,
        ).length;
        if (dupCount > 0) return "API ID가 중복됩니다.";

        const path = (item.rest_api_path || "").trim();
        if (!path) return "REST API Path는 필수입니다.";
        if (!path.startsWith("/")) return "REST API Path는 '/'로 시작해야 합니다.";

        if (!item.sql_id || !(item.sql_id + "").trim()) return "SQL ID는 필수입니다.";

        const timeout = item.refresh_interval_sec;
        if (timeout === undefined || timeout === null || timeout === "") return "갱신 주기(초)는 필수입니다.";
        if (!Number.isInteger(Number(timeout)) || Number(timeout) < 1) return "갱신 주기(초)는 1 이상의 정수여야 합니다.";

        return null;
    };
}

/* ══════════════════════════════════════════════════════════════════
   ConfigEditorModal — main component
   ══════════════════════════════════════════════════════════════════ */

export default function ConfigEditorModal({ open, onClose }) {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);
    const [activeTab, setActiveTab] = useState("server");

    // Draft state (editable copy of config)
    const [server, setServer] = useState({});
    const [auth, setAuth] = useState({});
    const [logging, setLogging] = useState({});
    const [connections, setConnections] = useState([]);
    const [globalJdbcJars, setGlobalJdbcJars] = useState("");
    const [sqlValidation, setSqlValidation] = useState({});

    // Collapsible cards
    const [collapsedConns, setCollapsedConns] = useState({});
    const [collapsedApis, setCollapsedApis] = useState({});

    // JSON raw editor mode
    const [jsonMode, setJsonMode] = useState(false);
    const [rawJson, setRawJson] = useState("");

    // ── monitor tab dirty signals (lifted from MonitorTargetsTab) ──────────
    // Key: targetType  Value: { isDirty, count }
    const [monitorDirtyMap, setMonitorDirtyMap] = useState({});

    const handleMonitorDirtyChange = useCallback((targetType, isDirty, count) => {
        setMonitorDirtyMap((prev) => {
            if (prev[targetType]?.isDirty === isDirty && prev[targetType]?.count === count) {
                return prev; // no change, avoid re-render
            }
            return { ...prev, [targetType]: { isDirty, count } };
        });
    }, []);

    const monitorTotalDirty = Object.values(monitorDirtyMap).reduce(
        (sum, v) => sum + (v?.count || 0),
        0,
    );

    // ── useDirtyList for the "데이터 API" tab ─────────────────────────────
    // validator needs access to the full visible list for duplicate check,
    // so we build it lazily via a ref that updates each render.
    const visibleApiItemsRef = useRef([]);

    const endpointValidator = useCallback((item) => {
        return buildEndpointValidator(visibleApiItemsRef.current)(item);
    }, []);

    const endpointNewItemFactory = useCallback(
        () => ({
            id: "",
            rest_api_path: "/api/",
            connection_id: "",
            sql_id: "",
            refresh_interval_sec: 5,
            enabled: true,
        }),
        [],
    );

    const apiList = useDirtyList({
        initial: [],
        idKey: "id",
        newItemFactory: endpointNewItemFactory,
        validator: endpointValidator,
    });

    // keep ref in sync with visible items
    visibleApiItemsRef.current = apiList.visibleItems;

    // ── modal-wide dirty aggregation ───────────────────────────────────────
    const isModalDirty = apiList.isDirty || monitorTotalDirty > 0;
    const modalDirtyCount = apiList.dirtyCount.total + monitorTotalDirty;

    // ── close guard ─────────────────────────────────────────────────────────
    const guardedClose = useUnsavedChangesGuard({
        isDirty: isModalDirty,
        dirtyCount: modalDirtyCount,
        onClose,
        isBlocked: saving,
    });

    const loadConfig = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await configService.getConfig();
            setServer(data.server || {});
            setAuth(data.auth || {});
            setLogging(data.logging || {});
            const loadedConnections = Array.isArray(data.connections) ? data.connections : [];
            const loadedApis = Array.isArray(data.apis) ? data.apis : [];
            setConnections(loadedConnections);
            // 이미 등록되어 있는 항목들은 기본적으로 접힌 상태로 보여 화면이 길어지는 것을 방지한다.
            setCollapsedConns(
                Object.fromEntries(loadedConnections.map((_, i) => [i, true])),
            );
            // Initialize useDirtyList with the server snapshot.
            // Collapse keyed by id (stable) rather than index.
            apiList.reset(loadedApis);
            setCollapsedApis(
                Object.fromEntries(loadedApis.map((a) => [a.id, true])),
            );
            setGlobalJdbcJars(data.global_jdbc_jars || "");
            setSqlValidation(data.sql_validation || {});
            setRawJson(JSON.stringify(data, null, 2));
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "설정을 불러오지 못했습니다.");
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (open) loadConfig();
    }, [open, loadConfig]);

    // Build the final apis array by applying the useDirtyList diff onto the
    // original snapshot, so the PUT payload contains the full correct list.
    const buildApisForSave = useCallback(() => {
        const diff = apiList.computeDiff();
        // Start from the current visible items that are NOT deleted and NOT new
        // (i.e., existing, possibly modified), then append creates.
        const existing = apiList.visibleItems
            .filter((it) => !it._isNew && !it._isDeleted)
            .map((it) => {
                // Strip internal _* flags
                const { _isNew: _n, _isDeleted: _d, ...clean } = it;
                return clean;
            });
        const created = diff.creates.map(({ _isNew: _n, _isDeleted: _d, ...clean }) => clean);
        return [...existing, ...created];
    }, [apiList]);

    const buildConfigObject = () => {
        if (jsonMode) {
            return JSON.parse(rawJson);
        }
        return {
            server,
            auth,
            logging,
            global_jdbc_jars: globalJdbcJars,
            sql_validation: sqlValidation,
            connections,
            apis: buildApisForSave(),
        };
    };

    const handleSave = async () => {
        // Validate endpoint list before saving
        if (apiList.isDirty && !apiList.isValid) {
            const firstInvalidId = apiList.invalidIds[0];
            const el = document.querySelector(`[data-row-id="${firstInvalidId}"]`);
            if (el) {
                setActiveTab("apis");
                el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            setError(`데이터 API 설정에 ${apiList.invalidIds.length}개 오류가 있습니다. 확인 후 다시 저장하세요.`);
            return;
        }

        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const configObj = buildConfigObject();
            const result = await configService.updateConfig(configObj);
            setSuccessMsg(
                `저장 완료! API ${result.endpointCount ?? "?"}개, Connection ${result.connectionCount ?? "?"}개 로드됨.`,
            );
            // sync rawJson with form state
            setRawJson(JSON.stringify(configObj, null, 2));
            // After successful save, reset the dirty list to the new server state
            apiList.reset(configObj.apis || []);
        } catch (e) {
            if (e instanceof SyntaxError) {
                setError("JSON 형식이 올바르지 않습니다.");
            } else {
                setError(e?.response?.data?.message || e?.message || "저장 실패");
            }
        } finally {
            setSaving(false);
        }
    };

    const handleReloadOnly = async () => {
        setSaving(true);
        setError(null);
        setSuccessMsg(null);
        try {
            const result = await configService.reloadConfig();
            setSuccessMsg(result.message || "설정 리로드 완료.");
        } catch (e) {
            setError(e?.response?.data?.message || e?.message || "리로드 실패");
        } finally {
            setSaving(false);
        }
    };

    // sync form → rawJson when switching to JSON mode
    const handleToggleJsonMode = () => {
        if (!jsonMode) {
            try {
                setRawJson(JSON.stringify(buildConfigObject(), null, 2));
            } catch { /* ignore */ }
        } else {
            // switching back from JSON to form — parse rawJson into form fields
            try {
                const data = JSON.parse(rawJson);
                setServer(data.server || {});
                setAuth(data.auth || {});
                setLogging(data.logging || {});
                const parsedConnections = Array.isArray(data.connections) ? data.connections : [];
                const parsedApis = Array.isArray(data.apis) ? data.apis : [];
                setConnections(parsedConnections);
                setCollapsedConns(
                    Object.fromEntries(parsedConnections.map((_, i) => [i, true])),
                );
                apiList.reset(parsedApis);
                setCollapsedApis(
                    Object.fromEntries(parsedApis.map((a) => [a.id, true])),
                );
                setGlobalJdbcJars(data.global_jdbc_jars || "");
                setSqlValidation(data.sql_validation || {});
            } catch {
                setError("JSON 파싱 실패. 형식을 확인해 주세요.");
                return; // don't switch
            }
        }
        setJsonMode(!jsonMode);
    };

    /* ── connection helpers ────────────────── */
    const handleConnectionChange = (idx, updated) => {
        setConnections((prev) => prev.map((c, i) => (i === idx ? updated : c)));
    };
    const handleConnectionRemove = (idx) => {
        setConnections((prev) => prev.filter((_, i) => i !== idx));
        // 인덱스 기반 접힘 상태도 한 칸씩 당겨준다 (잘못된 카드가 접혀 보이는 것 방지).
        setCollapsedConns((prev) => {
            const next = {};
            Object.keys(prev).forEach((k) => {
                const i = Number(k);
                if (i < idx) next[i] = prev[k];
                else if (i > idx) next[i - 1] = prev[k];
            });
            return next;
        });
    };
    const handleConnectionAdd = () => {
        setConnections((prev) => [
            ...prev,
            { id: "", db_type: "oracle", jdbc_driver_class: "oracle.jdbc.OracleDriver", jdbc_url: "", username: "", password: "" },
        ]);
    };
    const handleConnectionDuplicate = (idx) => {
        setConnections((prev) => {
            const src = prev[idx];
            if (!src) return prev;
            const existingIds = new Set(prev.map((c) => c.id).filter(Boolean));
            const dup = { ...src, id: nextAvailable(src.id, existingIds) };
            return insertAfter(prev, idx, dup);
        });
        setCollapsedConns((prev) => shiftCollapsedForInsert(prev, idx));
    };

    /* ── api helpers (now delegated to useDirtyList) ─────────────── */
    const connectionIds = connections.map((c) => c.id).filter(Boolean);

    const handleApiUpdate = useCallback((id, updated) => {
        const { _isNew: _n, _isDeleted: _d, ...patch } = updated;
        apiList.updateItem(id, patch);
    }, [apiList]);

    const handleApiAdd = useCallback(() => {
        const tmpId = apiList.addItem({
            connection_id: connectionIds[0] || "",
        });
        setCollapsedApis((prev) => ({ ...prev, [tmpId]: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiList, connectionIds]);

    const handleApiRemove = useCallback((id) => {
        apiList.deleteItem(id);
    }, [apiList]);

    const handleApiRestore = useCallback((id) => {
        apiList.restoreItem(id);
    }, [apiList]);

    const handleApiDuplicate = useCallback((id) => {
        const src = apiList.visibleItems.find((a) => a.id === id);
        if (!src) return;
        const existingIds = new Set(
            apiList.visibleItems.map((a) => a.id).filter(Boolean),
        );
        const existingPaths = new Set(
            apiList.visibleItems.map((a) => a.rest_api_path).filter(Boolean),
        );
        const tmpId = apiList.addItem({
            ...endpointNewItemFactory(),
            sql_id: src.sql_id,
            connection_id: src.connection_id,
            refresh_interval_sec: src.refresh_interval_sec,
            enabled: src.enabled,
            rest_api_path: nextAvailable(src.rest_api_path, existingPaths),
        });
        setCollapsedApis((prev) => ({ ...prev, [tmpId]: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiList, endpointNewItemFactory]);

    if (!open) return null;

    // 배경(overlay) 클릭으로 팝업이 닫히지 않도록 보장한다.
    // 사용자 요구: 명시적인 "닫기" 버튼(헤더 ✕ / 푸터 닫기)으로만 닫는다.
    // onMouseDown까지 삼켜야 드래그 선택 → 외부 mouseup에서 닫힘이 발생하는 케이스도 방지된다.
    const handleOverlayMouseEvent = (e) => {
        e.stopPropagation();
    };

    const content = (
        <div
            className="settings-overlay"
            onMouseDown={handleOverlayMouseEvent}
            onClick={handleOverlayMouseEvent}
        >
            <div
                className="settings-popup cfg-editor-popup"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="settings-popup-header">
                    <div>
                        <h5>백엔드 설정</h5>
                        <p>서버, DB 연결, 데이터 API 설정을 관리합니다. 저장 시 설정 DB에 기록되어 모든 A-A 노드에 즉시 반영됩니다.</p>
                    </div>
                    <button type="button" className="close-settings-btn" onClick={guardedClose} aria-label="닫기"><IconClose size={16} /></button>
                </div>

                {/* ── Tab bar ────────────────────────────── */}
                <div className="cfg-tab-bar">
                    {[
                        { key: "server", label: "서버" },
                        { key: "auth", label: "인증" },
                        { key: "connections", label: "DB 연결" },
                        { key: "apis", label: "데이터 API" },
                        { key: "serverTargets", label: "서버 리소스" },
                        { key: "networkTargets", label: "네트워크 체크" },
                        { key: "httpStatusTargets", label: "API 상태" },
                        { key: "logging", label: "로깅" },
                        { key: "advanced", label: "고급" },
                    ].map((tab) => (
                        <button
                            key={tab.key}
                            type="button"
                            className={`cfg-tab ${activeTab === tab.key ? "active" : ""}`}
                            onClick={() => setActiveTab(tab.key)}
                            disabled={jsonMode}
                        >
                            {tab.label}
                        </button>
                    ))}
                    <button
                        type="button"
                        className={`cfg-tab cfg-tab-json ${jsonMode ? "active" : ""}`}
                        onClick={handleToggleJsonMode}
                    >
                        JSON
                    </button>
                </div>

                {/* ── Body ───────────────────────────────── */}
                <div className="cfg-editor-body">
                    {loading ? (
                        <div className="cfg-loading">설정을 불러오는 중...</div>
                    ) : jsonMode ? (
                        <textarea
                            className="cfg-raw-json"
                            value={rawJson}
                            onChange={(e) => setRawJson(e.target.value)}
                            spellCheck={false}
                        />
                    ) : (
                        <>
                            {/* ── Server tab ──────────────── */}
                            {activeTab === "server" && (
                                <div className="cfg-section">
                                    <div className="cfg-row-2">
                                        <label><span>Host</span>
                                            <input type="text" value={server.host || ""} disabled className="input-disabled" />
                                        </label>
                                        <label><span>Port</span>
                                            <input type="number" value={server.port ?? 5000} disabled className="input-disabled" />
                                        </label>
                                    </div>
                                    <div className="cfg-row-3">
                                        <label><span>Thread Pool Size</span>
                                            <input type="number" value={server.thread_pool_size ?? 16} onChange={(e) => setServer((p) => ({ ...p, thread_pool_size: Number(e.target.value) }))} min="1" max="64" />
                                        </label>
                                        <label><span>Refresh Interval (초)</span>
                                            <input type="number" value={server.refresh_interval_sec ?? 5} onChange={(e) => setServer((p) => ({ ...p, refresh_interval_sec: Number(e.target.value) }))} min="1" />
                                        </label>
                                        <label><span>Query Timeout (초)</span>
                                            <input type="number" value={server.query_timeout_sec ?? 10} onChange={(e) => setServer((p) => ({ ...p, query_timeout_sec: Number(e.target.value) }))} min="1" />
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* ── Auth tab ────────────────── */}
                            {activeTab === "auth" && (
                                <div className="cfg-section">
                                    <div className="cfg-row-2">
                                        <label><span>Username</span>
                                            <input type="text" value={auth.username || ""} onChange={(e) => setAuth((p) => ({ ...p, username: e.target.value }))} />
                                        </label>
                                        <label><span>Password</span>
                                            <PasswordInput value={auth.password || ""} onChange={(e) => setAuth((p) => ({ ...p, password: e.target.value }))} />
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* ── Connections tab ─────────── */}
                            {activeTab === "connections" && (
                                <div className="cfg-section">
                                    <div className="cfg-section-header">
                                        <span>DB 연결 ({connections.length}개)</span>
                                        <button type="button" className="cfg-add-btn" onClick={handleConnectionAdd}><IconPlus size={14} /> 추가</button>
                                    </div>
                                    {connections.length === 0 ? (
                                        <div className="cfg-empty">등록된 연결이 없습니다.</div>
                                    ) : (
                                        connections.map((conn, i) => (
                                            <ConnectionEditor key={i} conn={conn} index={i}
                                                onChange={handleConnectionChange}
                                                onRemove={handleConnectionRemove}
                                                onDuplicate={handleConnectionDuplicate}
                                                collapsed={!!collapsedConns[i]}
                                                onToggle={() => setCollapsedConns((p) => ({ ...p, [i]: !p[i] }))}
                                            />
                                        ))
                                    )}
                                </div>
                            )}

                            {/* ── APIs tab ────────────────── */}
                            {activeTab === "apis" && (
                                <div className="cfg-section">
                                    <div className="cfg-section-header">
                                        <span>데이터 API ({apiList.visibleItems.filter((a) => !a._isDeleted).length}개)</span>
                                        <button type="button" className="cfg-add-btn" onClick={handleApiAdd}><IconPlus size={14} /> 추가</button>
                                    </div>
                                    {apiList.visibleItems.length === 0 ? (
                                        <div className="cfg-empty">등록된 API가 없습니다.</div>
                                    ) : (
                                        apiList.visibleItems.map((api) => {
                                            const state = apiList.rowState(api.id);
                                            const rowStateClass =
                                                state === "new"
                                                    ? "row-state-new"
                                                    : state === "modified"
                                                        ? "row-state-modified"
                                                        : state === "deleted"
                                                            ? "row-state-deleted"
                                                            : "";
                                            const valError = apiList.validationError(api.id);
                                            return (
                                                <ApiEndpointEditor
                                                    key={api.id}
                                                    api={api}
                                                    rowStateClass={rowStateClass}
                                                    validationError={valError}
                                                    connectionIds={connectionIds}
                                                    onUpdate={(next) => handleApiUpdate(api.id, next)}
                                                    onRemove={() => handleApiRemove(api.id)}
                                                    onRestore={() => handleApiRestore(api.id)}
                                                    onDuplicate={() => handleApiDuplicate(api.id)}
                                                    collapsed={!!collapsedApis[api.id]}
                                                    onToggle={() => setCollapsedApis((p) => ({ ...p, [api.id]: !p[api.id] }))}
                                                />
                                            );
                                        })
                                    )}
                                    {/* Summary bar — no save button (modal footer owns save) */}
                                    <DirtyListSummary
                                        count={apiList.dirtyCount}
                                        isValid={apiList.isValid}
                                        invalidCount={apiList.invalidIds.length}
                                        isSaving={saving}
                                        hideSaveButton
                                    />
                                </div>
                            )}

                            {/* ── Server targets tab ──────── */}
                            {activeTab === "serverTargets" && (
                                <MonitorTargetsTab
                                    targetType="server_resource"
                                    onDirtyChange={(isDirty, count) =>
                                        handleMonitorDirtyChange("server_resource", isDirty, count)
                                    }
                                />
                            )}

                            {/* ── Network targets tab ─────── */}
                            {activeTab === "networkTargets" && (
                                <MonitorTargetsTab
                                    targetType="network"
                                    onDirtyChange={(isDirty, count) =>
                                        handleMonitorDirtyChange("network", isDirty, count)
                                    }
                                />
                            )}

                            {/* ── HTTP status targets tab ─── */}
                            {activeTab === "httpStatusTargets" && (
                                <MonitorTargetsTab
                                    targetType="http_status"
                                    onDirtyChange={(isDirty, count) =>
                                        handleMonitorDirtyChange("http_status", isDirty, count)
                                    }
                                />
                            )}

                            {/* ── Logging tab ─────────────── */}
                            {activeTab === "logging" && (
                                <div className="cfg-section">
                                    <div className="cfg-row-2">
                                        <label><span>Log Directory</span>
                                            <input type="text" value={logging.directory || ""} onChange={(e) => setLogging((p) => ({ ...p, directory: e.target.value }))} />
                                        </label>
                                        <label><span>File Prefix</span>
                                            <input type="text" value={logging.file_prefix || ""} onChange={(e) => setLogging((p) => ({ ...p, file_prefix: e.target.value }))} />
                                        </label>
                                    </div>
                                    <div className="cfg-row-3">
                                        <label><span>Log Level</span>
                                            <select value={logging.level || "INFO"} onChange={(e) => setLogging((p) => ({ ...p, level: e.target.value }))}>
                                                {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                                            </select>
                                        </label>
                                        <label><span>Retention (일)</span>
                                            <input type="number" value={logging.retention_days ?? 7} onChange={(e) => setLogging((p) => ({ ...p, retention_days: Number(e.target.value) }))} min="1" />
                                        </label>
                                        <label><span>Slow Query Threshold (초)</span>
                                            <input type="number" value={logging.slow_query_threshold_sec ?? 10} onChange={(e) => setLogging((p) => ({ ...p, slow_query_threshold_sec: Number(e.target.value) }))} min="1" />
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* ── Advanced tab ────────────── */}
                            {activeTab === "advanced" && (
                                <div className="cfg-section">
                                    <label><span>Global JDBC JARs (세미콜론 구분)</span>
                                        <input type="text" value={globalJdbcJars} onChange={(e) => setGlobalJdbcJars(e.target.value)} placeholder="drivers/ojdbc11.jar;drivers/mariadb-java-client.jar" />
                                    </label>
                                    <label><span>SQL Validation (typo patterns) — JSON</span>
                                        <textarea
                                            className="cfg-json-mini"
                                            value={JSON.stringify(sqlValidation, null, 2)}
                                            onChange={(e) => {
                                                try {
                                                    setSqlValidation(JSON.parse(e.target.value));
                                                } catch { /* allow transient invalid state */ }
                                            }}
                                            spellCheck={false}
                                        />
                                    </label>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* ── Status messages ────────────────────── */}
                {error && <div className="cfg-msg cfg-msg-error">{error}</div>}
                {successMsg && <div className="cfg-msg cfg-msg-success">{successMsg}</div>}

                {/* ── Footer ─────────────────────────────── */}
                <div className="cfg-footer">
                    <button type="button" className="cfg-footer-btn cfg-btn-secondary" onClick={handleReloadOnly} disabled={saving}>
                        Reload Only
                    </button>
                    <div className="cfg-footer-right">
                        <button type="button" className="cfg-footer-btn cfg-btn-secondary" onClick={guardedClose}>
                            닫기
                        </button>
                        <button type="button" className="cfg-footer-btn cfg-btn-primary" onClick={handleSave} disabled={saving || loading}>
                            {saving ? "저장 중..." : "저장 & 적용"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    return createPortal(content, document.body);
}

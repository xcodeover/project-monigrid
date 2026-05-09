import React, { useCallback, useEffect, useRef, useState } from "react";
import { monitorService, invalidateMonitorTargetsCache } from "../services/dashboardService";
import { DEFAULT_CRITERIA, OS_OPTIONS } from "./serverResourceHelpers";
import PasswordInput from "./PasswordInput";
import { useDirtyList } from "../hooks/useDirtyList";
import { useConfigFooterRegister, useConfigFooterUnregister } from "../pages/configFooterContext";
import {
    IconCopy,
    IconPlus,
    IconRefresh,
    IconTrash,
} from "./icons";

/**
 * ConfigEditorModal 내부의 모니터 대상 관리 탭.
 *
 * targetType prop 으로 표시/추가할 종류를 한정한다 (서버 리소스 / 네트워크).
 * 별도 백엔드 엔드포인트(`/dashboard/monitor-targets`)를 사용하므로
 * ConfigEditorModal 푸터의 "저장 & 적용" 과 결합되지 않고 배치 저장한다.
 */

const NETWORK_TYPE_OPTIONS = [
    { value: "ping", label: "Ping (ICMP)" },
    { value: "telnet", label: "Telnet (TCP)" },
];

const HTTP_STATUS_DEFAULT_TIMEOUT_SEC = 10;

const buildEmpty = (targetType) => {
    const base = {
        type: targetType,
        label: "",
        interval_sec: 30,
        enabled: true,
    };
    if (targetType === "server_resource") {
        return {
            ...base,
            spec: {
                os_type: "linux-generic",
                host: "",
                criteria: { ...DEFAULT_CRITERIA },
            },
        };
    }
    if (targetType === "network") {
        return { ...base, spec: { type: "ping", host: "" } };
    }
    if (targetType === "http_status") {
        return {
            ...base,
            spec: { url: "", timeout_sec: HTTP_STATUS_DEFAULT_TIMEOUT_SEC },
        };
    }
    return { ...base, spec: {} };
};

const needsServerCreds = (target) => {
    if (target?.type !== "server_resource") return false;
    const osType = target.spec?.os_type || "linux-generic";
    if (osType === "windows-winrm") return true;
    if (osType?.startsWith("linux") || osType === "windows-ssh") {
        const host = target.spec?.host || "";
        return !!host && host !== "localhost" && host !== "127.0.0.1";
    }
    return false;
};

/* ── Grid row (Phase: 사용자 요구 ③ — 카드 → grid 전환) ────────────
 * server_resource / network / http_status 가 컬럼 구성이 다르므로 각자
 * grid-template-columns 가 다른 별도 row 컴포넌트로 분기한다. 사용자 입력
 * 가능한 모든 필드를 한 행에 inline 으로 노출 — 가로 스크롤 허용.
 *  ───────────────────────────────────────────────────────────────── */

const RowActions = ({ isDeleted, isNew, onDuplicate, onRemove, onRestore }) => (
    <div className="cfg-grid-actions">
        {!isDeleted && (
            <button
                type="button"
                className="cfg-duplicate-btn"
                onClick={onDuplicate}
                title="복제"
            >
                <IconCopy size={14} />
            </button>
        )}
        {isDeleted ? (
            <button
                type="button"
                className="row-restore-btn"
                onClick={onRestore}
                title="복원"
            >
                ↺
            </button>
        ) : (
            <button
                type="button"
                className="cfg-remove-btn"
                onClick={onRemove}
                title="삭제"
            >
                <IconTrash size={14} />
            </button>
        )}
    </div>
);

const RowFlags = ({ isNew, isDeleted }) => (
    <span className="cfg-grid-flags">
        {isNew && <span className="cfg-card-badge">신규</span>}
        {isDeleted && <span className="cfg-card-badge" style={{ color: "#ff6b6b" }}>삭제 예정</span>}
    </span>
);

const ServerResourceRow = ({
    target, index, onChange, onRemove, onRestore, onDuplicate,
    rowStateClass, validationError,
}) => {
    const update = (field, value) => onChange({ ...target, [field]: value });
    const updateSpec = (field, value) =>
        onChange({ ...target, spec: { ...(target.spec || {}), [field]: value } });
    const updateCriteria = (field, value) =>
        onChange({
            ...target,
            spec: {
                ...(target.spec || {}),
                criteria: {
                    ...(target.spec?.criteria || {}),
                    [field]: value === "" ? "" : Number(value),
                },
            },
        });
    const osType = target.spec?.os_type || "linux-generic";
    const criteria = target.spec?.criteria || {};
    const showCreds = needsServerCreds(target);
    const isDeleted = target._isDeleted;
    const rowClasses = [
        "cfg-grid-row",
        rowStateClass || "",
        validationError ? "row-state-invalid" : "",
        isDeleted ? "cfg-grid-row-deleted" : "",
    ].filter(Boolean).join(" ");

    return (
        <>
            <div className={rowClasses} data-row-id={target.id}>
                <span className="cfg-grid-no">{index + 1}</span>
                <label className="cfg-toggle" title={target.enabled ? "수집 켜짐" : "수집 꺼짐"}>
                    <input
                        type="checkbox"
                        checked={!!target.enabled}
                        onChange={(e) => update("enabled", e.target.checked)}
                        disabled={isDeleted}
                    />
                    <span className="cfg-toggle-slider" />
                </label>
                <input
                    type="text"
                    value={target.id || ""}
                    onChange={(e) => update("id", e.target.value)}
                    placeholder="db-01"
                    disabled={!target._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={target.label || ""}
                    onChange={(e) => update("label", e.target.value)}
                    placeholder="prod DB"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    value={target.interval_sec ?? 30}
                    onChange={(e) => update("interval_sec", Number(e.target.value) || 0)}
                    disabled={isDeleted}
                />
                <input
                    type="text"
                    value={target.spec?.host || ""}
                    onChange={(e) => updateSpec("host", e.target.value)}
                    placeholder="192.168.0.10"
                    disabled={isDeleted}
                />
                <select
                    value={osType}
                    onChange={(e) => updateSpec("os_type", e.target.value)}
                    disabled={isDeleted}
                >
                    {OS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <input
                    type="text"
                    value={target.spec?.username || ""}
                    onChange={(e) => updateSpec("username", e.target.value)}
                    placeholder={showCreds ? "user" : "(불필요)"}
                    disabled={isDeleted || !showCreds}
                />
                <PasswordInput
                    value={target.spec?.password || ""}
                    onChange={(e) => updateSpec("password", e.target.value)}
                    placeholder={showCreds ? "" : "(불필요)"}
                    disabled={isDeleted || !showCreds}
                />
                <input
                    type="number"
                    min="1"
                    max="100"
                    value={criteria.cpu ?? ""}
                    onChange={(e) => updateCriteria("cpu", e.target.value)}
                    placeholder={String(DEFAULT_CRITERIA.cpu)}
                    title="CPU 알람 임계치 (%)"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    max="100"
                    value={criteria.memory ?? ""}
                    onChange={(e) => updateCriteria("memory", e.target.value)}
                    placeholder={String(DEFAULT_CRITERIA.memory)}
                    title="Memory 알람 임계치 (%)"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    max="100"
                    value={criteria.disk ?? ""}
                    onChange={(e) => updateCriteria("disk", e.target.value)}
                    placeholder={String(DEFAULT_CRITERIA.disk)}
                    title="Disk 알람 임계치 (%)"
                    disabled={isDeleted}
                />
                <RowFlags isNew={target._isNew} isDeleted={isDeleted} />
                <RowActions
                    isDeleted={isDeleted}
                    isNew={target._isNew}
                    onDuplicate={onDuplicate}
                    onRemove={onRemove}
                    onRestore={onRestore}
                />
            </div>
            {validationError && <div className="cfg-grid-error-row">{validationError}</div>}
        </>
    );
};

const NetworkRow = ({
    target, index, onChange, onRemove, onRestore, onDuplicate,
    rowStateClass, validationError,
}) => {
    const update = (field, value) => onChange({ ...target, [field]: value });
    const updateSpec = (field, value) =>
        onChange({ ...target, spec: { ...(target.spec || {}), [field]: value } });
    const networkKind = target.spec?.type || "ping";
    const isDeleted = target._isDeleted;
    const rowClasses = [
        "cfg-grid-row",
        rowStateClass || "",
        validationError ? "row-state-invalid" : "",
        isDeleted ? "cfg-grid-row-deleted" : "",
    ].filter(Boolean).join(" ");

    return (
        <>
            <div className={rowClasses} data-row-id={target.id}>
                <span className="cfg-grid-no">{index + 1}</span>
                <label className="cfg-toggle" title={target.enabled ? "수집 켜짐" : "수집 꺼짐"}>
                    <input
                        type="checkbox"
                        checked={!!target.enabled}
                        onChange={(e) => update("enabled", e.target.checked)}
                        disabled={isDeleted}
                    />
                    <span className="cfg-toggle-slider" />
                </label>
                <input
                    type="text"
                    value={target.id || ""}
                    onChange={(e) => update("id", e.target.value)}
                    placeholder="net-01"
                    disabled={!target._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={target.label || ""}
                    onChange={(e) => update("label", e.target.value)}
                    placeholder="DC-A 게이트웨이"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    value={target.interval_sec ?? 30}
                    onChange={(e) => update("interval_sec", Number(e.target.value) || 0)}
                    disabled={isDeleted}
                />
                <select
                    value={networkKind}
                    onChange={(e) => updateSpec("type", e.target.value)}
                    disabled={isDeleted}
                >
                    {NETWORK_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
                <input
                    type="text"
                    value={target.spec?.host || ""}
                    onChange={(e) => updateSpec("host", e.target.value)}
                    placeholder="192.168.0.10"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    max="65535"
                    value={target.spec?.port || ""}
                    onChange={(e) => updateSpec("port", e.target.value)}
                    placeholder={networkKind === "telnet" ? "443" : "(불필요)"}
                    disabled={isDeleted || networkKind !== "telnet"}
                />
                <input
                    type="number"
                    min="1"
                    max="30"
                    value={target.spec?.timeout || 5}
                    onChange={(e) => updateSpec("timeout", e.target.value)}
                    title="Timeout (초)"
                    disabled={isDeleted}
                />
                <RowFlags isNew={target._isNew} isDeleted={isDeleted} />
                <RowActions
                    isDeleted={isDeleted}
                    isNew={target._isNew}
                    onDuplicate={onDuplicate}
                    onRemove={onRemove}
                    onRestore={onRestore}
                />
            </div>
            {validationError && <div className="cfg-grid-error-row">{validationError}</div>}
        </>
    );
};

const HttpStatusRow = ({
    target, index, onChange, onRemove, onRestore, onDuplicate,
    rowStateClass, validationError,
}) => {
    const update = (field, value) => onChange({ ...target, [field]: value });
    const updateSpec = (field, value) =>
        onChange({ ...target, spec: { ...(target.spec || {}), [field]: value } });
    const isDeleted = target._isDeleted;
    const rowClasses = [
        "cfg-grid-row",
        rowStateClass || "",
        validationError ? "row-state-invalid" : "",
        isDeleted ? "cfg-grid-row-deleted" : "",
    ].filter(Boolean).join(" ");

    return (
        <>
            <div className={rowClasses} data-row-id={target.id}>
                <span className="cfg-grid-no">{index + 1}</span>
                <label className="cfg-toggle" title={target.enabled ? "수집 켜짐" : "수집 꺼짐"}>
                    <input
                        type="checkbox"
                        checked={!!target.enabled}
                        onChange={(e) => update("enabled", e.target.checked)}
                        disabled={isDeleted}
                    />
                    <span className="cfg-toggle-slider" />
                </label>
                <input
                    type="text"
                    value={target.id || ""}
                    onChange={(e) => update("id", e.target.value)}
                    placeholder="api-status-01"
                    disabled={!target._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={target.label || ""}
                    onChange={(e) => update("label", e.target.value)}
                    placeholder="결제 API"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    value={target.interval_sec ?? 30}
                    onChange={(e) => update("interval_sec", Number(e.target.value) || 0)}
                    disabled={isDeleted}
                />
                <input
                    type="text"
                    value={target.spec?.url || ""}
                    onChange={(e) => updateSpec("url", e.target.value)}
                    placeholder="https://api.example.com/health"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={isDeleted}
                />
                <input
                    type="number"
                    min="1"
                    max="30"
                    value={target.spec?.timeout_sec ?? HTTP_STATUS_DEFAULT_TIMEOUT_SEC}
                    onChange={(e) => updateSpec("timeout_sec", Number(e.target.value) || HTTP_STATUS_DEFAULT_TIMEOUT_SEC)}
                    title="Timeout (초)"
                    disabled={isDeleted}
                />
                <RowFlags isNew={target._isNew} isDeleted={isDeleted} />
                <RowActions
                    isDeleted={isDeleted}
                    isNew={target._isNew}
                    onDuplicate={onDuplicate}
                    onRemove={onRemove}
                    onRestore={onRestore}
                />
            </div>
            {validationError && <div className="cfg-grid-error-row">{validationError}</div>}
        </>
    );
};

const TargetGridHeader = ({ targetType }) => {
    if (targetType === "server_resource") {
        return (
            <div className="cfg-grid-row cfg-grid-head" role="row">
                <span>No</span>
                <span>활성</span>
                <span>ID</span>
                <span>이름</span>
                <span>주기(초)</span>
                <span>호스트</span>
                <span>OS 유형</span>
                <span>Username</span>
                <span>Password</span>
                <span>CPU%</span>
                <span>Mem%</span>
                <span>Disk%</span>
                <span>상태</span>
                <span></span>
            </div>
        );
    }
    if (targetType === "network") {
        return (
            <div className="cfg-grid-row cfg-grid-head" role="row">
                <span>No</span>
                <span>활성</span>
                <span>ID</span>
                <span>이름</span>
                <span>주기(초)</span>
                <span>유형</span>
                <span>호스트</span>
                <span>Port</span>
                <span>Timeout</span>
                <span>상태</span>
                <span></span>
            </div>
        );
    }
    // http_status
    return (
        <div className="cfg-grid-row cfg-grid-head" role="row">
            <span>No</span>
            <span>활성</span>
            <span>ID</span>
            <span>이름</span>
            <span>주기(초)</span>
            <span>URL</span>
            <span>Timeout</span>
            <span>상태</span>
            <span></span>
        </div>
    );
};

const TargetGridRow = (props) => {
    const t = props.target?.type;
    if (t === "server_resource") return <ServerResourceRow {...props} />;
    if (t === "network") return <NetworkRow {...props} />;
    return <HttpStatusRow {...props} />;
};


/**
 * @param {string}   targetType    - "server_resource" | "network" | "http_status"
 * @param {Function} [onDirtyChange] - optional callback `(isDirty, total) => void`
 *   invoked whenever the tab's dirty count changes. Used by ConfigEditorModal
 *   to aggregate the dirty signal for the modal-level close guard.
 */
const MonitorTargetsTab = ({ targetType, onDirtyChange }) => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [collapsed, setCollapsed] = useState({});
    const [isSaving, setIsSaving] = useState(false);

    // ── validator ──────────────────────────────────────────────────────────────
    const validator = useCallback((item) => {
        const label = (item.label || "").trim();
        if (!label) return "이름(label)은 필수입니다.";
        if (label.length > 64) return "이름은 64자 이하여야 합니다.";
        if (!item.type) return "유형(type)은 필수입니다.";

        if (item.type === "http_status") {
            const url = (item.spec?.url || "").trim();
            if (!url) return "URL은 필수입니다.";
            return null;
        }

        const host = (item.spec?.host || "").trim();
        if (!host) return "호스트(host)는 필수입니다.";

        const port = item.spec?.port;
        if (port !== undefined && port !== "" && port !== null) {
            const n = Number(port);
            if (!Number.isFinite(n) || n < 1 || n > 65535) return "포트는 1-65535 범위여야 합니다.";
        }

        if (item.type === "server_resource") {
            const osType = item.spec?.os_type || "linux-generic";
            const needsCreds =
                osType === "windows-winrm" ||
                ((osType?.startsWith("linux") || osType === "windows-ssh") &&
                    !!host &&
                    host !== "localhost" &&
                    host !== "127.0.0.1");
            if (needsCreds) {
                const username = item.spec?.username;
                if (!username || !(username + "").trim()) return "Username은 필수입니다.";
            }
        }

        return null;
    }, []);

    // ── newItemFactory ─────────────────────────────────────────────────────────
    const newItemFactory = useCallback(() => buildEmpty(targetType), [targetType]);

    // ── useDirtyList ───────────────────────────────────────────────────────────
    const list = useDirtyList({
        initial: [],
        idKey: "id",
        newItemFactory,
        validator,
    });

    // ── notify parent of dirty changes ────────────────────────────────────────
    useEffect(() => {
        if (onDirtyChange) {
            onDirtyChange(list.isDirty, list.dirtyCount.total);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [list.isDirty, list.dirtyCount.total]);

    // ── 페이지 footer 의 단일 저장 버튼에 binding 등록 (요구 ①) ────────────
    // handleBatchSave 는 매 렌더 새 closure 라 ref 를 통해 latest 를 호출.
    const registerFooter = useConfigFooterRegister();
    const unregisterFooter = useConfigFooterUnregister();
    const handleBatchSaveRef = useRef();

    // ── server load ────────────────────────────────────────────────────────────
    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await monitorService.listTargets();
            const items = Array.isArray(data?.targets) ? data.targets : [];
            const filtered = items.filter((t) => t.type === targetType);
            list.reset(filtered);
            setCollapsed(Object.fromEntries(filtered.map((t) => [t.id, true])));
        } catch (err) {
            setError(
                err?.response?.data?.message ||
                    err?.message ||
                    "대상 목록을 불러올 수 없습니다.",
            );
        } finally {
            setLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetType]);

    useEffect(() => {
        reload();
    }, [reload]);

    // ── handlers ───────────────────────────────────────────────────────────────
    const handleAdd = () => {
        const tmpId = list.addItem();
        setCollapsed((prev) => ({ ...prev, [tmpId]: false }));
    };

    const handleDuplicate = (id) => {
        const src = list.visibleItems.find((t) => t.id === id);
        if (!src) return;
        const dupId = list.addItem({
            ...buildEmpty(targetType),
            type: src.type,
            label: src.label ? `${src.label} (사본)` : "",
            interval_sec: src.interval_sec,
            enabled: src.enabled,
            spec: { ...(src.spec || {}) },
        });
        setCollapsed((prev) => ({ ...prev, [dupId]: false }));
    };

    const handleChange = (id, updated) => {
        // Strip _isNew/_isDeleted from the patch — useDirtyList manages those
        const { _isNew: _n, _isDeleted: _d, ...patch } = updated;
        list.updateItem(id, patch);
    };

    const handleRemove = (id) => {
        list.deleteItem(id);
    };

    const handleRestore = (id) => {
        list.restoreItem(id);
    };

    const toggleCollapsed = (id) =>
        setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

    // ── batch save ─────────────────────────────────────────────────────────────
    const handleBatchSave = async () => {
        if (!list.isValid) {
            const firstInvalidId = list.invalidIds[0];
            const el = document.querySelector(`[data-row-id="${firstInvalidId}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
            window.alert(`${list.invalidIds.length}개 항목에 오류가 있습니다.`);
            return;
        }

        const diff = list.computeDiff();
        setIsSaving(true);
        try {
            const result = await monitorService.applyTargetsBatch(
                diff.creates,
                diff.updates,
                diff.deletes,
            );
            if (result.success) {
                invalidateMonitorTargetsCache();
                await reload();
            } else {
                const failed = result.failedItem;
                window.alert(`저장 실패: ${failed?.message || result.error}`);
                if (failed?.id) {
                    const el = document.querySelector(`[data-row-id="${failed.id}"]`);
                    el?.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }
        } catch (err) {
            window.alert(`저장 실패: ${err?.response?.data?.error || err?.response?.data?.message || err.message}`);
        } finally {
            setIsSaving(false);
        }
    };

    // ── footer binding (페이지 footer 단일 저장 버튼) ─────────────────────
    useEffect(() => { handleBatchSaveRef.current = handleBatchSave; });
    useEffect(() => {
        // _key 는 ConfigEditorPage 가 activeBindingKey 로 매칭하는 키와 동일.
        const key = targetType === "server_resource"
            ? "serverTargets"
            : targetType === "network"
              ? "networkTargets"
              : "httpStatusTargets";
        registerFooter({
            _key: key,
            isDirty: list.isDirty,
            dirtyCount: list.dirtyCount.total,
            isSaving,
            save: () => handleBatchSaveRef.current?.(),
            saveLabel: "저장 & 적용",
        });
        return () => unregisterFooter(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetType, list.isDirty, list.dirtyCount.total, isSaving]);

    // ── render ─────────────────────────────────────────────────────────────────
    const headerLabel =
        targetType === "server_resource"
            ? "서버 리소스"
            : targetType === "network"
              ? "네트워크 체크"
              : targetType === "http_status"
                ? "API 상태"
                : "대상";

    // visibleItems already includes the targetType-filtered list (reset only loaded this type)
    const targets = list.visibleItems;

    return (
        <div className="cfg-section">
            <div className="cfg-section-header">
                <span>
                    {headerLabel} ({targets.filter((t) => !t._isDeleted).length}개)
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        type="button"
                        className="cfg-add-btn"
                        onClick={reload}
                        disabled={loading || isSaving}
                        title="새로고침"
                    >
                        <IconRefresh size={14} />
                        새로고침
                    </button>
                    <button
                        type="button"
                        className="cfg-add-btn"
                        onClick={handleAdd}
                        disabled={isSaving}
                        title="추가"
                    >
                        <IconPlus size={14} />
                        추가
                    </button>
                </div>
            </div>
            {error && <div className="cfg-msg cfg-msg-error">{error}</div>}
            {loading ? (
                <div className="cfg-loading">불러오는 중...</div>
            ) : targets.length === 0 ? (
                <div className="cfg-empty">등록된 대상이 없습니다.</div>
            ) : (
                <div className={`cfg-grid cfg-grid-monitor cfg-grid-monitor-${targetType}`} role="grid">
                    <TargetGridHeader targetType={targetType} />
                    {targets.map((t, idx) => {
                        const state = list.rowState(t.id);
                        const rowStateClass =
                            state === "new"
                                ? "row-state-new"
                                : state === "modified"
                                  ? "row-state-modified"
                                  : state === "deleted"
                                    ? "row-state-deleted"
                                    : "";
                        const valError = list.validationError(t.id);
                        return (
                            <TargetGridRow
                                key={t.id}
                                target={t}
                                index={idx}
                                onChange={(next) => handleChange(t.id, next)}
                                onRemove={() => handleRemove(t.id)}
                                onRestore={() => handleRestore(t.id)}
                                onDuplicate={() => handleDuplicate(t.id)}
                                rowStateClass={rowStateClass}
                                validationError={valError}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default MonitorTargetsTab;
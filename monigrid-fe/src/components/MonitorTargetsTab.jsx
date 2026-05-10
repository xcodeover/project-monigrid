import React, { useCallback, useEffect, useRef, useState } from "react";
import { monitorService, invalidateMonitorTargetsCache } from "../services/dashboardService";
import { DEFAULT_CRITERIA, OS_OPTIONS } from "./serverResourceHelpers";
import PasswordInput from "./PasswordInput";
import { useDirtyList } from "../hooks/useDirtyList";
import { useConfigFooterRegister, useConfigFooterUnregister } from "../pages/configFooterContext";
import AuditCells from "./AuditCells.jsx";
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

// 데이터 API 탭과 동일한 per-cell 필수값 표시 헬퍼.
// validationTriggered 가 true 이고 value 가 trim 후 비었으면 cfg-cell-invalid
// 클래스 + placeholder "Required" 로 빨간 테두리 시각.
const requiredCell = (value, fallback, { triggered, disabled = false } = {}) => {
    if (disabled) return { className: "", placeholder: fallback };
    const empty = !String(value ?? "").trim();
    const invalid = triggered && empty;
    return {
        className: invalid ? "cfg-cell-invalid" : "",
        placeholder: invalid ? "Required" : fallback,
    };
};

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

const ServerResourceRow = ({
    target, index, onChange, onRemove, onRestore, onDuplicate,
    rowStateClass, validationError, validationTriggered,
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
            <div className={rowClasses} data-row-id={target._key || target.id}>
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
                    {...requiredCell(target.id, "db-01", {
                        triggered: validationTriggered,
                        disabled: !target._isNew || isDeleted,
                    })}
                    disabled={!target._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={target.label || ""}
                    onChange={(e) => update("label", e.target.value)}
                    {...requiredCell(target.label, "prod DB", {
                        triggered: validationTriggered,
                        disabled: isDeleted,
                    })}
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
                    {...requiredCell(target.spec?.host, "192.168.0.10", {
                        triggered: validationTriggered,
                        disabled: isDeleted,
                    })}
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
                    type="number"
                    min="1"
                    max="65535"
                    value={target.spec?.port ?? ""}
                    onChange={(e) =>
                        updateSpec(
                            "port",
                            e.target.value === "" ? "" : Number(e.target.value),
                        )
                    }
                    placeholder={
                        osType === "windows-winrm"
                            ? "5985"
                            : osType === "windows"
                                ? "(불필요)"
                                : "22"
                    }
                    title={
                        osType === "windows-winrm"
                            ? "WinRM port (HTTP=5985, HTTPS=5986)"
                            : osType === "windows"
                                ? "WMI 로컬 — port 미사용"
                                : "SSH port (default 22)"
                    }
                    disabled={isDeleted || osType === "windows"}
                />
                <input
                    type="text"
                    value={target.spec?.username || ""}
                    onChange={(e) => updateSpec("username", e.target.value)}
                    {...requiredCell(target.spec?.username, showCreds ? "user" : "(불필요)", {
                        triggered: validationTriggered && showCreds,
                        disabled: isDeleted || !showCreds,
                    })}
                    disabled={isDeleted || !showCreds}
                />
                <PasswordInput
                    value={target.spec?.password || ""}
                    onChange={(e) => updateSpec("password", e.target.value)}
                    placeholder={showCreds ? "" : "(불필요)"}
                    disabled={isDeleted || !showCreds}
                />
                <input
                    type="text"
                    value={target.spec?.domain || ""}
                    onChange={(e) => updateSpec("domain", e.target.value)}
                    placeholder={
                        osType === "windows" || osType === "windows-winrm"
                            ? "WORKGROUP"
                            : "(불필요)"
                    }
                    title={
                        osType === "windows" || osType === "windows-winrm"
                            ? "Windows 도메인/워크그룹 (선택)"
                            : "Linux/SSH 에서는 사용하지 않음"
                    }
                    disabled={
                        isDeleted
                        || (osType !== "windows" && osType !== "windows-winrm")
                    }
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
                <AuditCells updatedAt={target.updated_at} updatedBy={target.updated_by} />
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
    rowStateClass, validationError, validationTriggered,
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
            <div className={rowClasses} data-row-id={target._key || target.id}>
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
                    {...requiredCell(target.id, "net-01", {
                        triggered: validationTriggered,
                        disabled: !target._isNew || isDeleted,
                    })}
                    disabled={!target._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={target.label || ""}
                    onChange={(e) => update("label", e.target.value)}
                    {...requiredCell(target.label, "DC-A 게이트웨이", {
                        triggered: validationTriggered,
                        disabled: isDeleted,
                    })}
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
                    {...requiredCell(target.spec?.host, "192.168.0.10", {
                        triggered: validationTriggered,
                        disabled: isDeleted,
                    })}
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
                <AuditCells updatedAt={target.updated_at} updatedBy={target.updated_by} />
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
    rowStateClass, validationError, validationTriggered,
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
            <div className={rowClasses} data-row-id={target._key || target.id}>
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
                    {...requiredCell(target.id, "api-status-01", {
                        triggered: validationTriggered,
                        disabled: !target._isNew || isDeleted,
                    })}
                    disabled={!target._isNew || isDeleted}
                />
                <input
                    type="text"
                    value={target.label || ""}
                    onChange={(e) => update("label", e.target.value)}
                    {...requiredCell(target.label, "결제 API", {
                        triggered: validationTriggered,
                        disabled: isDeleted,
                    })}
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
                    {...requiredCell(target.spec?.url, "https://api.example.com/health", {
                        triggered: validationTriggered,
                        disabled: isDeleted,
                    })}
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
                <AuditCells updatedAt={target.updated_at} updatedBy={target.updated_by} />
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
                <span>Port</span>
                <span>Username</span>
                <span>Password</span>
                <span>Domain</span>
                <span>CPU%</span>
                <span>Mem%</span>
                <span>Disk%</span>
                <span>수정 시각</span>
                <span>편집자</span>
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
                <span>수정 시각</span>
                <span>편집자</span>
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
            <span>수정 시각</span>
            <span>편집자</span>
            <span></span>
        </div>
    );
};

const TargetGridRow = (props) => {
    const t = props.target?.type;
    // validationTriggered 는 모든 row 타입에 동일하게 props 로 흘려준다.
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
    // 데이터 API 탭과 동일 패턴 — 저장 시도 시 필수값 빈 셀이 있으면 ON.
    // 사용자가 셀을 채우면 자동으로 무효화 시각이 사라짐 (cell-level recompute).
    const [validationTriggered, setValidationTriggered] = useState(false);

    // ── validator ──────────────────────────────────────────────────────────────
    const validator = useCallback((item) => {
        const id = (item.id || "").trim();
        if (!id) return "ID는 필수입니다.";
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) return "ID는 영문자·숫자·밑줄·하이픈만 허용됩니다.";
        if (id.length > 128) return "ID는 128자 이하여야 합니다.";
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
        // id 는 stable _key 라 lookup 도 _key 로 일치시킨다.
        const src = list.visibleItems.find((t) => t._key === id);
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
            // 필수값 빈 셀에 빨간 테두리 + "Required" placeholder 시각 표시.
            // 데이터 API 탭과 동일한 패턴.
            setValidationTriggered(true);
            const firstInvalidId = list.invalidIds[0];
            const el = document.querySelector(`[data-row-id="${firstInvalidId}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
            window.alert(`${list.invalidIds.length}개 항목에 오류가 있습니다. 빨간 셀을 채워 주세요.`);
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
                setValidationTriggered(false);
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
                        // useDirtyList 가 노출하는 stable map key. id 필드 편집과 무관.
                        const stableKey = t._key;
                        const state = list.rowState(stableKey);
                        const rowStateClass =
                            state === "new"
                                ? "row-state-new"
                                : state === "modified"
                                  ? "row-state-modified"
                                  : state === "deleted"
                                    ? "row-state-deleted"
                                    : "";
                        const valError = list.validationError(stableKey);
                        return (
                            <TargetGridRow
                                key={stableKey}
                                target={t}
                                index={idx}
                                onChange={(next) => handleChange(stableKey, next)}
                                onRemove={() => handleRemove(stableKey)}
                                onRestore={() => handleRestore(stableKey)}
                                onDuplicate={() => handleDuplicate(stableKey)}
                                rowStateClass={rowStateClass}
                                validationError={valError}
                                validationTriggered={validationTriggered}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default MonitorTargetsTab;
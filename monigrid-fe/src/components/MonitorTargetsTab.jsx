import React, { useCallback, useEffect, useState } from "react";
import { monitorService, invalidateMonitorTargetsCache } from "../services/dashboardService";
import { DEFAULT_CRITERIA, OS_OPTIONS } from "./serverResourceHelpers";
import PasswordInput from "./PasswordInput";
import { useDirtyList } from "../hooks/useDirtyList";
import DirtyListSummary from "./DirtyListSummary";
import {
    IconChevronRight,
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

const TargetCard = ({
    target,
    collapsed,
    onToggle,
    onChange,
    onRemove,
    onRestore,
    onDuplicate,
    rowStateClass,
    validationError,
}) => {
    const update = (field, value) => onChange({ ...target, [field]: value });
    const updateSpec = (field, value) =>
        onChange({ ...target, spec: { ...(target.spec || {}), [field]: value } });

    const isServer = target.type === "server_resource";
    const isNetwork = target.type === "network";
    const isHttp = target.type === "http_status";
    const networkKind = target.spec?.type || "ping";
    const osType = target.spec?.os_type || "linux-generic";
    const showCreds = needsServerCreds(target);
    const isDeleted = target._isDeleted;

    // server_resource 의 알람 임계치(%) — 운영자가 등록 시 함께 입력해
    // BE 에 중앙 저장한다. 빈 입력은 fallback 으로 DEFAULT_CRITERIA 사용.
    const criteria = target.spec?.criteria || {};
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

    const cardClasses = [
        "cfg-card",
        collapsed ? "cfg-card-collapsed" : "",
        rowStateClass || "",
        validationError ? "row-state-invalid" : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div
            className={cardClasses}
            data-row-id={target.id}
        >
            <div
                className="cfg-card-header"
                onClick={onToggle}
                style={{ cursor: "pointer" }}
            >
                <span className={`cfg-card-chevron ${collapsed ? "" : "open"}`}>
                    <IconChevronRight size={12} />
                </span>
                {!isDeleted && (
                    <label
                        className="cfg-toggle"
                        onClick={(e) => e.stopPropagation()}
                        title={target.enabled ? "수집 켜짐" : "수집 꺼짐"}
                    >
                        <input
                            type="checkbox"
                            checked={!!target.enabled}
                            onChange={(e) => update("enabled", e.target.checked)}
                        />
                        <span className="cfg-toggle-slider" />
                    </label>
                )}
                <span className="cfg-card-title">
                    {target.label || target.id || "(이름 없음)"}
                </span>
                <span className="cfg-card-badge">
                    {target.type === "http_status"
                        ? target.spec?.url || "-"
                        : target.spec?.host || "-"}
                </span>
                {target._isNew && <span className="cfg-card-badge">신규</span>}
                {isDeleted && <span className="cfg-card-badge" style={{ color: "#ff6b6b" }}>삭제 예정</span>}
                {!isDeleted && (
                    <button
                        type="button"
                        className="cfg-duplicate-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            onDuplicate();
                        }}
                        title="복제"
                        aria-label="복제"
                    >
                        <IconCopy size={14} />
                    </button>
                )}
                {isDeleted ? (
                    <button
                        type="button"
                        className="row-restore-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRestore();
                        }}
                        title="복원"
                        aria-label="복원"
                    >
                        ↺ 복원
                    </button>
                ) : (
                    <button
                        type="button"
                        className="cfg-remove-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove();
                        }}
                        title="삭제"
                        aria-label="삭제"
                    >
                        <IconTrash size={14} />
                    </button>
                )}
            </div>
            {!collapsed && !isDeleted && (
                <div className="cfg-card-body">
                    <div className="cfg-row-2">
                        <label>
                            <span>ID</span>
                            <input
                                type="text"
                                value={target.id || ""}
                                onChange={(e) => update("id", e.target.value)}
                                placeholder="예: db-01"
                                disabled={!target._isNew}
                            />
                        </label>
                        <label>
                            <span>이름</span>
                            <input
                                type="text"
                                value={target.label || ""}
                                onChange={(e) => update("label", e.target.value)}
                                placeholder="예: prod DB"
                            />
                        </label>
                    </div>

                    <div className="cfg-row-2">
                        <label>
                            <span>주기(초)</span>
                            <input
                                type="number"
                                min="1"
                                value={target.interval_sec ?? 30}
                                onChange={(e) =>
                                    update("interval_sec", Number(e.target.value) || 0)
                                }
                            />
                        </label>
                        {!isHttp && (
                            <label>
                                <span>호스트</span>
                                <input
                                    type="text"
                                    value={target.spec?.host || ""}
                                    onChange={(e) => updateSpec("host", e.target.value)}
                                    placeholder={
                                        isServer
                                            ? "192.168.0.10 or localhost"
                                            : "192.168.0.10"
                                    }
                                />
                            </label>
                        )}
                    </div>

                    {isServer && (
                        <fieldset className="cfg-fieldset">
                            <legend>Server Resource</legend>
                            <label>
                                <span>OS 유형</span>
                                <select
                                    value={osType}
                                    onChange={(e) => updateSpec("os_type", e.target.value)}
                                >
                                    {OS_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>
                                            {o.label}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {showCreds && (
                                <>
                                    <div className="cfg-row-2">
                                        <label>
                                            <span>Username</span>
                                            <input
                                                type="text"
                                                value={target.spec?.username || ""}
                                                onChange={(e) =>
                                                    updateSpec("username", e.target.value)
                                                }
                                            />
                                        </label>
                                        <label>
                                            <span>Password</span>
                                            <PasswordInput
                                                value={target.spec?.password || ""}
                                                onChange={(e) =>
                                                    updateSpec("password", e.target.value)
                                                }
                                            />
                                        </label>
                                    </div>
                                    <div className="cfg-row-2">
                                        <label>
                                            <span>Domain (선택)</span>
                                            <input
                                                type="text"
                                                value={target.spec?.domain || ""}
                                                onChange={(e) =>
                                                    updateSpec("domain", e.target.value)
                                                }
                                            />
                                        </label>
                                        <label>
                                            <span>Port (선택)</span>
                                            <input
                                                type="number"
                                                value={target.spec?.port || ""}
                                                onChange={(e) =>
                                                    updateSpec("port", e.target.value)
                                                }
                                            />
                                        </label>
                                    </div>
                                    {osType === "windows-winrm" && (
                                        <label>
                                            <span>Transport</span>
                                            <select
                                                value={target.spec?.transport || ""}
                                                onChange={(e) =>
                                                    updateSpec("transport", e.target.value)
                                                }
                                            >
                                                <option value="">(기본)</option>
                                                <option value="ntlm">ntlm</option>
                                                <option value="basic">basic</option>
                                                <option value="kerberos">kerberos</option>
                                            </select>
                                        </label>
                                    )}
                                </>
                            )}
                            <div
                                className="cfg-row-3"
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "1fr 1fr 1fr",
                                    gap: 8,
                                }}
                            >
                                <label>
                                    <span>CPU 알람 임계치 (%)</span>
                                    <input
                                        type="number"
                                        min="1"
                                        max="100"
                                        value={criteria.cpu ?? ""}
                                        onChange={(e) =>
                                            updateCriteria("cpu", e.target.value)
                                        }
                                        placeholder={String(DEFAULT_CRITERIA.cpu)}
                                    />
                                </label>
                                <label>
                                    <span>Memory 알람 임계치 (%)</span>
                                    <input
                                        type="number"
                                        min="1"
                                        max="100"
                                        value={criteria.memory ?? ""}
                                        onChange={(e) =>
                                            updateCriteria("memory", e.target.value)
                                        }
                                        placeholder={String(DEFAULT_CRITERIA.memory)}
                                    />
                                </label>
                                <label>
                                    <span>Disk 알람 임계치 (%)</span>
                                    <input
                                        type="number"
                                        min="1"
                                        max="100"
                                        value={criteria.disk ?? ""}
                                        onChange={(e) =>
                                            updateCriteria("disk", e.target.value)
                                        }
                                        placeholder={String(DEFAULT_CRITERIA.disk)}
                                    />
                                </label>
                            </div>
                        </fieldset>
                    )}

                    {isNetwork && (
                        <fieldset className="cfg-fieldset">
                            <legend>Network</legend>
                            <div className="cfg-row-2">
                                <label>
                                    <span>테스트 유형</span>
                                    <select
                                        value={networkKind}
                                        onChange={(e) => updateSpec("type", e.target.value)}
                                    >
                                        {NETWORK_TYPE_OPTIONS.map((o) => (
                                            <option key={o.value} value={o.value}>
                                                {o.label}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                {networkKind === "telnet" && (
                                    <label>
                                        <span>Port</span>
                                        <input
                                            type="number"
                                            min="1"
                                            max="65535"
                                            value={target.spec?.port || ""}
                                            onChange={(e) => updateSpec("port", e.target.value)}
                                        />
                                    </label>
                                )}
                            </div>
                            <label>
                                <span>Timeout (초)</span>
                                <input
                                    type="number"
                                    min="1"
                                    max="30"
                                    value={target.spec?.timeout || 5}
                                    onChange={(e) => updateSpec("timeout", e.target.value)}
                                />
                            </label>
                        </fieldset>
                    )}

                    {isHttp && (
                        <fieldset className="cfg-fieldset">
                            <legend>API 상태 체크</legend>
                            <label>
                                <span>URL</span>
                                <input
                                    type="text"
                                    value={target.spec?.url || ""}
                                    onChange={(e) => updateSpec("url", e.target.value)}
                                    placeholder="https://api.example.com/health"
                                    spellCheck={false}
                                    autoComplete="off"
                                />
                            </label>
                            <label>
                                <span>Timeout (초)</span>
                                <input
                                    type="number"
                                    min="1"
                                    max="30"
                                    value={
                                        target.spec?.timeout_sec ??
                                        HTTP_STATUS_DEFAULT_TIMEOUT_SEC
                                    }
                                    onChange={(e) =>
                                        updateSpec(
                                            "timeout_sec",
                                            Number(e.target.value) || HTTP_STATUS_DEFAULT_TIMEOUT_SEC,
                                        )
                                    }
                                />
                            </label>
                        </fieldset>
                    )}

                    {validationError && (
                        <div className="row-state-invalid-msg">{validationError}</div>
                    )}
                </div>
            )}
        </div>
    );
};

const MonitorTargetsTab = ({ targetType }) => {
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
                targets.map((t) => {
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
                        <TargetCard
                            key={t.id}
                            target={t}
                            collapsed={!!collapsed[t.id]}
                            onToggle={() => toggleCollapsed(t.id)}
                            onChange={(next) => handleChange(t.id, next)}
                            onRemove={() => handleRemove(t.id)}
                            onRestore={() => handleRestore(t.id)}
                            onDuplicate={() => handleDuplicate(t.id)}
                            rowStateClass={rowStateClass}
                            validationError={valError}
                        />
                    );
                })
            )}
            <DirtyListSummary
                count={list.dirtyCount}
                isValid={list.isValid}
                invalidCount={list.invalidIds.length}
                isSaving={isSaving}
                onSave={handleBatchSave}
            />
        </div>
    );
};

export default MonitorTargetsTab;

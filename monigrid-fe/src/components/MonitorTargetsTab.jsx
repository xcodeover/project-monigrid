import React, { useCallback, useEffect, useState } from "react";
import { monitorService } from "../services/dashboardService";
import { OS_OPTIONS } from "./serverResourceHelpers";
import PasswordInput from "./PasswordInput";
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
 * ConfigEditorModal 푸터의 "저장 & 적용" 과 결합되지 않고 카드 단위로 즉시 저장한다.
 */

const NETWORK_TYPE_OPTIONS = [
    { value: "ping", label: "Ping (ICMP)" },
    { value: "telnet", label: "Telnet (TCP)" },
];

const HTTP_STATUS_DEFAULT_TIMEOUT_SEC = 10;

const buildEmpty = (targetType) => {
    const base = {
        _local: true,
        id: `mt-${Date.now().toString(36)}`,
        type: targetType,
        label: "",
        interval_sec: 30,
        enabled: true,
    };
    if (targetType === "server_resource") {
        return { ...base, spec: { os_type: "linux-generic", host: "" } };
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

// "db-01" → "db-02", "db" → "db-2" 식으로 끝의 숫자를 증가시키며,
// 이미 존재하는 id 와 충돌하지 않을 때까지 반복한다.
const nextAvailableId = (sourceId, existing) => {
    const text = String(sourceId || "");
    const bump = (s) => {
        const m = s.match(/^(.*?)(\d+)$/);
        if (m) return m[1] + (parseInt(m[2], 10) + 1);
        return s ? `${s}-2` : `mt-${Date.now().toString(36)}`;
    };
    let candidate = bump(text);
    while (existing.has(candidate)) candidate = bump(candidate);
    return candidate;
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
    onDuplicate,
    onSave,
    saving,
    rowError,
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

    return (
        <div className={`cfg-card ${collapsed ? "cfg-card-collapsed" : ""}`}>
            <div
                className="cfg-card-header"
                onClick={onToggle}
                style={{ cursor: "pointer" }}
            >
                <span className={`cfg-card-chevron ${collapsed ? "" : "open"}`}>
                    <IconChevronRight size={12} />
                </span>
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
                <span className="cfg-card-title">
                    {target.label || target.id || "(이름 없음)"}
                </span>
                <span className="cfg-card-badge">
                    {target.type === "http_status"
                        ? target.spec?.url || "-"
                        : target.spec?.host || "-"}
                </span>
                {target._local && <span className="cfg-card-badge">신규</span>}
                {target._dirty && !target._local && (
                    <span className="cfg-card-badge">변경됨</span>
                )}
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
            </div>
            {!collapsed && (
                <div className="cfg-card-body">
                    <div className="cfg-row-2">
                        <label>
                            <span>ID</span>
                            <input
                                type="text"
                                value={target.id || ""}
                                onChange={(e) => update("id", e.target.value)}
                                placeholder="예: db-01"
                                disabled={!target._local}
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

                    {rowError && <div className="cfg-msg cfg-msg-error">{rowError}</div>}

                    <div className="cfg-card-footer">
                        <button
                            type="button"
                            className="cfg-footer-btn cfg-btn-primary"
                            onClick={onSave}
                            disabled={saving || (!target._dirty && !target._local)}
                        >
                            {saving ? "저장 중..." : target._local ? "추가" : "저장"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

const MonitorTargetsTab = ({ targetType }) => {
    const [allTargets, setAllTargets] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [collapsed, setCollapsed] = useState({});
    const [savingIds, setSavingIds] = useState({});
    const [rowErrors, setRowErrors] = useState({});

    const reload = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await monitorService.listTargets();
            const list = Array.isArray(data?.targets) ? data.targets : [];
            setAllTargets(list);
            setCollapsed(Object.fromEntries(list.map((t) => [t.id, true])));
            setRowErrors({});
        } catch (err) {
            setError(
                err?.response?.data?.message ||
                    err?.message ||
                    "대상 목록을 불러올 수 없습니다.",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    // 현재 탭 type 에 해당하는 항목만 + 상단에 신규(_local) 항목.
    const targets = allTargets.filter(
        (t) => (t._local && t.type === targetType) || t.type === targetType,
    );

    const setRowSaving = (id, value) =>
        setSavingIds((prev) => ({ ...prev, [id]: value }));
    const setRowError = (id, msg) =>
        setRowErrors((prev) => ({ ...prev, [id]: msg }));

    const handleAdd = () => {
        const empty = buildEmpty(targetType);
        setAllTargets((prev) => [empty, ...prev]);
        setCollapsed((prev) => ({ ...prev, [empty.id]: false }));
    };

    const handleDuplicate = (id) => {
        const src = allTargets.find((t) => t.id === id);
        if (!src) return;
        const existingIds = new Set(allTargets.map((t) => t.id));
        const dup = {
            ...src,
            _local: true,
            _dirty: false,
            id: nextAvailableId(src.id, existingIds),
            label: src.label ? `${src.label} (사본)` : "",
            spec: { ...(src.spec || {}) },
        };
        setAllTargets((prev) => {
            const idx = prev.findIndex((t) => t.id === id);
            if (idx === -1) return [dup, ...prev];
            return [...prev.slice(0, idx + 1), dup, ...prev.slice(idx + 1)];
        });
        setCollapsed((prev) => ({ ...prev, [dup.id]: false }));
    };

    const handleChange = (id, updated) => {
        setAllTargets((prev) =>
            prev.map((t) =>
                t.id === id ? { ...updated, _dirty: !updated._local } : t,
            ),
        );
    };

    const handleRemove = async (id) => {
        const t = allTargets.find((x) => x.id === id);
        if (!t) return;
        if (t._local) {
            setAllTargets((prev) => prev.filter((x) => x.id !== id));
            setCollapsed((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
            return;
        }
        if (!window.confirm(`대상 "${t.label || t.id}" 을(를) 삭제할까요?`)) return;
        setRowSaving(id, true);
        try {
            await monitorService.deleteTarget(id);
            await reload();
        } catch (err) {
            setRowError(
                id,
                err?.response?.data?.message || err?.message || "삭제 실패",
            );
        } finally {
            setRowSaving(id, false);
        }
    };

    const handleSave = async (id) => {
        const t = allTargets.find((x) => x.id === id);
        if (!t) return;
        const finalId = (t.id || "").trim();
        if (!finalId) {
            setRowError(id, "id가 필요합니다.");
            return;
        }
        const body = {
            id: finalId,
            type: t.type,
            label: t.label || "",
            interval_sec: Number(t.interval_sec) || 30,
            enabled: !!t.enabled,
            spec: t.spec || {},
        };
        setRowSaving(id, true);
        setRowError(id, null);
        try {
            if (t._local) {
                await monitorService.createTarget(body);
            } else {
                await monitorService.updateTarget(finalId, body);
            }
            await reload();
        } catch (err) {
            setRowError(
                id,
                err?.response?.data?.message || err?.message || "저장 실패",
            );
        } finally {
            setRowSaving(id, false);
        }
    };

    const toggleCollapsed = (id) =>
        setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

    const headerLabel =
        targetType === "server_resource"
            ? "서버 리소스"
            : targetType === "network"
              ? "네트워크 체크"
              : targetType === "http_status"
                ? "API 상태"
                : "대상";

    return (
        <div className="cfg-section">
            <div className="cfg-section-header">
                <span>
                    {headerLabel} ({targets.length}개)
                </span>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        type="button"
                        className="cfg-add-btn"
                        onClick={reload}
                        disabled={loading}
                        title="새로고침"
                    >
                        <IconRefresh size={14} />
                        새로고침
                    </button>
                    <button
                        type="button"
                        className="cfg-add-btn"
                        onClick={handleAdd}
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
                targets.map((t) => (
                    <TargetCard
                        key={t.id}
                        target={t}
                        collapsed={!!collapsed[t.id]}
                        onToggle={() => toggleCollapsed(t.id)}
                        onChange={(next) => handleChange(t.id, next)}
                        onRemove={() => handleRemove(t.id)}
                        onDuplicate={() => handleDuplicate(t.id)}
                        onSave={() => handleSave(t.id)}
                        saving={!!savingIds[t.id]}
                        rowError={rowErrors[t.id]}
                    />
                ))
            )}
        </div>
    );
};

export default MonitorTargetsTab;

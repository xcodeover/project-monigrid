import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { monitorService } from "../services/dashboardService";
import { OS_OPTIONS } from "../components/serverResourceHelpers";
import "./MonitorTargetsPage.css";

/**
 * Admin-only page for managing BE-collected monitor targets.
 *
 * Admins define what each A-A backend node should probe. End users then
 * reference these by id from their widgets — no credentials leave the BE.
 */

const EMPTY_TARGET = () => ({
    id: "",
    type: "server_resource",
    label: "",
    interval_sec: 30,
    enabled: true,
    spec: {},
});

const TYPE_OPTIONS = [
    { value: "server_resource", label: "Server Resource (CPU/MEM/Disk)" },
    { value: "network", label: "Network (Ping/Telnet)" },
];

const NETWORK_TYPE_OPTIONS = [
    { value: "ping", label: "Ping (ICMP)" },
    { value: "telnet", label: "Telnet (TCP)" },
];

const isAdminUser = (user) =>
    user?.role === "admin" ||
    String(user?.username || "").trim().toLowerCase() === "admin";

export default function MonitorTargetsPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const admin = isAdminUser(user);

    const [targets, setTargets] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [editing, setEditing] = useState(null); // null or target being edited
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);

    useEffect(() => {
        if (!isAuthenticated) {
            navigate("/login");
        } else if (!admin) {
            navigate("/dashboard");
        }
    }, [isAuthenticated, admin, navigate]);

    const loadTargets = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await monitorService.listTargets();
            setTargets(Array.isArray(data?.targets) ? data.targets : []);
        } catch (err) {
            setError(err?.response?.data?.message || err?.message || "대상 목록을 불러올 수 없습니다.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && admin) loadTargets();
    }, [isAuthenticated, admin, loadTargets]);

    const handleNew = () => {
        setSaveError(null);
        setEditing({
            ...EMPTY_TARGET(),
            id: `mt-${Date.now().toString(36)}`,
            spec: { os_type: "linux-generic", host: "" },
        });
    };

    const handleEdit = (t) => {
        setSaveError(null);
        setEditing({ ...t, spec: { ...(t.spec || {}) } });
    };

    const handleDelete = async (t) => {
        if (!window.confirm(`대상 "${t.label || t.id}" 을(를) 삭제할까요?`)) return;
        try {
            await monitorService.deleteTarget(t.id);
            await loadTargets();
        } catch (err) {
            window.alert(err?.response?.data?.message || "삭제 실패");
        }
    };

    const handleToggleEnabled = async (t) => {
        try {
            await monitorService.updateTarget(t.id, { ...t, enabled: !t.enabled });
            await loadTargets();
        } catch (err) {
            window.alert(err?.response?.data?.message || "상태 변경 실패");
        }
    };

    const handleSave = async () => {
        if (!editing) return;
        const body = {
            id: editing.id?.trim(),
            type: editing.type,
            label: editing.label,
            interval_sec: Number(editing.interval_sec) || 30,
            enabled: !!editing.enabled,
            spec: editing.spec || {},
        };
        if (!body.id) {
            setSaveError("id가 필요합니다.");
            return;
        }
        setSaving(true);
        setSaveError(null);
        try {
            const existing = targets.find((t) => t.id === body.id);
            if (existing) {
                await monitorService.updateTarget(body.id, body);
            } else {
                await monitorService.createTarget(body);
            }
            setEditing(null);
            await loadTargets();
        } catch (err) {
            setSaveError(err?.response?.data?.message || err?.message || "저장 실패");
        } finally {
            setSaving(false);
        }
    };

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    if (!admin) return null;

    return (
        <div className="monitor-targets-page">
            <header className="mt-header">
                <div className="mt-title-wrap">
                    <h1>🛰 모니터 대상 관리</h1>
                    <p>백엔드가 주기적으로 수집할 서버 리소스 / 네트워크 대상을 관리합니다.</p>
                </div>
                <div className="mt-actions">
                    <span className="mt-user">@{user?.username || "admin"}</span>
                    <button type="button" className="mt-btn" onClick={() => navigate("/dashboard")}>
                        대시보드
                    </button>
                    <button type="button" className="mt-btn mt-btn-primary" onClick={handleNew}>
                        ＋ 새 대상
                    </button>
                    <button type="button" className="mt-btn" onClick={loadTargets}>
                        ⟳ 새로고침
                    </button>
                    <button type="button" className="mt-btn" onClick={handleLogout}>
                        로그아웃
                    </button>
                </div>
            </header>

            <main className="mt-main">
                {error && <div className="mt-error">{error}</div>}
                {loading ? (
                    <div className="mt-loading">불러오는 중...</div>
                ) : targets.length === 0 ? (
                    <div className="mt-empty">
                        <p>등록된 대상이 없습니다.</p>
                        <button type="button" className="mt-btn mt-btn-primary" onClick={handleNew}>
                            첫 대상 추가
                        </button>
                    </div>
                ) : (
                    <table className="mt-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>유형</th>
                                <th>이름</th>
                                <th>호스트</th>
                                <th>주기(s)</th>
                                <th>상태</th>
                                <th>작업</th>
                            </tr>
                        </thead>
                        <tbody>
                            {targets.map((t) => (
                                <tr key={t.id}>
                                    <td className="mt-mono">{t.id}</td>
                                    <td>{t.type}</td>
                                    <td>{t.label || "-"}</td>
                                    <td>{t.spec?.host || "-"}</td>
                                    <td>{t.interval_sec}</td>
                                    <td>
                                        <button
                                            type="button"
                                            className={`mt-toggle${t.enabled ? " on" : ""}`}
                                            onClick={() => handleToggleEnabled(t)}
                                            title={t.enabled ? "끄기" : "켜기"}
                                        >
                                            {t.enabled ? "ON" : "OFF"}
                                        </button>
                                    </td>
                                    <td className="mt-row-actions">
                                        <button type="button" className="mt-btn" onClick={() => handleEdit(t)}>수정</button>
                                        <button type="button" className="mt-btn mt-btn-danger" onClick={() => handleDelete(t)}>삭제</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </main>

            {editing && (
                <TargetEditorModal
                    target={editing}
                    saving={saving}
                    errorMessage={saveError}
                    onChange={setEditing}
                    onCancel={() => setEditing(null)}
                    onSave={handleSave}
                />
            )}
        </div>
    );
}

/* ── editor modal ─────────────────────────────────────────────────────── */

function TargetEditorModal({ target, saving, errorMessage, onChange, onCancel, onSave }) {
    const updateTop = (field, value) => onChange({ ...target, [field]: value });
    const updateSpec = (field, value) =>
        onChange({ ...target, spec: { ...(target.spec || {}), [field]: value } });

    const isServer = target.type === "server_resource";
    const isNetwork = target.type === "network";
    const networkKind = target.spec?.type || "ping";
    const osType = target.spec?.os_type || "linux-generic";
    const needsCredsForServer = useMemo(() => {
        if (!isServer) return false;
        if (osType === "windows-winrm") return true;
        if (osType?.startsWith("linux") || osType === "windows-ssh") {
            const host = target.spec?.host || "";
            return host && host !== "localhost" && host !== "127.0.0.1";
        }
        return false;
    }, [isServer, osType, target.spec?.host]);

    return (
        <div className="mt-modal-overlay" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mt-modal">
                <div className="mt-modal-header">
                    <h3>모니터 대상 편집</h3>
                    <button type="button" className="mt-icon-btn" onClick={onCancel}>✕</button>
                </div>
                <div className="mt-modal-body">
                    <div className="mt-grid-2">
                        <label>
                            <span>ID</span>
                            <input
                                type="text"
                                value={target.id}
                                onChange={(e) => updateTop("id", e.target.value)}
                                placeholder="예: db-01"
                            />
                        </label>
                        <label>
                            <span>유형</span>
                            <select value={target.type} onChange={(e) => updateTop("type", e.target.value)}>
                                {TYPE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <div className="mt-grid-2">
                        <label>
                            <span>이름</span>
                            <input
                                type="text"
                                value={target.label || ""}
                                onChange={(e) => updateTop("label", e.target.value)}
                                placeholder="예: prod DB"
                            />
                        </label>
                        <label>
                            <span>주기(초)</span>
                            <input
                                type="number"
                                min="1"
                                value={target.interval_sec}
                                onChange={(e) => updateTop("interval_sec", e.target.value)}
                            />
                        </label>
                    </div>

                    <label className="mt-checkbox">
                        <input
                            type="checkbox"
                            checked={!!target.enabled}
                            onChange={(e) => updateTop("enabled", e.target.checked)}
                        />
                        <span>수집 활성화</span>
                    </label>

                    {isServer && (
                        <fieldset className="mt-fieldset">
                            <legend>Server Resource</legend>
                            <div className="mt-grid-2">
                                <label>
                                    <span>OS 유형</span>
                                    <select value={osType} onChange={(e) => updateSpec("os_type", e.target.value)}>
                                        {OS_OPTIONS.map((o) => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    <span>호스트</span>
                                    <input
                                        type="text"
                                        value={target.spec?.host || ""}
                                        onChange={(e) => updateSpec("host", e.target.value)}
                                        placeholder="192.168.0.10 or localhost"
                                    />
                                </label>
                            </div>
                            {needsCredsForServer && (
                                <>
                                    <div className="mt-grid-2">
                                        <label>
                                            <span>Username</span>
                                            <input
                                                type="text"
                                                value={target.spec?.username || ""}
                                                onChange={(e) => updateSpec("username", e.target.value)}
                                            />
                                        </label>
                                        <label>
                                            <span>Password</span>
                                            <input
                                                type="password"
                                                value={target.spec?.password || ""}
                                                onChange={(e) => updateSpec("password", e.target.value)}
                                            />
                                        </label>
                                    </div>
                                    <div className="mt-grid-2">
                                        <label>
                                            <span>Domain (선택)</span>
                                            <input
                                                type="text"
                                                value={target.spec?.domain || ""}
                                                onChange={(e) => updateSpec("domain", e.target.value)}
                                            />
                                        </label>
                                        <label>
                                            <span>Port (선택)</span>
                                            <input
                                                type="number"
                                                value={target.spec?.port || ""}
                                                onChange={(e) => updateSpec("port", e.target.value)}
                                            />
                                        </label>
                                    </div>
                                    {osType === "windows-winrm" && (
                                        <label>
                                            <span>Transport</span>
                                            <select
                                                value={target.spec?.transport || ""}
                                                onChange={(e) => updateSpec("transport", e.target.value)}
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
                        <fieldset className="mt-fieldset">
                            <legend>Network</legend>
                            <div className="mt-grid-2">
                                <label>
                                    <span>테스트 유형</span>
                                    <select value={networkKind} onChange={(e) => updateSpec("type", e.target.value)}>
                                        {NETWORK_TYPE_OPTIONS.map((o) => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                        ))}
                                    </select>
                                </label>
                                <label>
                                    <span>호스트</span>
                                    <input
                                        type="text"
                                        value={target.spec?.host || ""}
                                        onChange={(e) => updateSpec("host", e.target.value)}
                                        placeholder="192.168.0.10"
                                    />
                                </label>
                            </div>
                            <div className="mt-grid-2">
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
                            </div>
                        </fieldset>
                    )}

                    {errorMessage && <div className="mt-error">{errorMessage}</div>}
                </div>
                <div className="mt-modal-footer">
                    <button type="button" className="mt-btn" onClick={onCancel} disabled={saving}>취소</button>
                    <button type="button" className="mt-btn mt-btn-primary" onClick={onSave} disabled={saving}>
                        {saving ? "저장 중..." : "저장"}
                    </button>
                </div>
            </div>
        </div>
    );
}

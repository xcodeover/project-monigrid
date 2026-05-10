import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { adminUserService } from "../services/dashboardService";
import PasswordInput from "../components/PasswordInput";
import { IconArrowLeft, IconClose, IconLogout, IconPlus, IconRefresh } from "../components/icons";
import "./UserManagementPage.css";

/**
 * Admin-only page for managing `monigrid_users` accounts.
 *
 * Passwords are never returned from the BE — the edit modal treats the
 * password field as a write-only "set new password" input. An empty
 * password on edit leaves the existing hash untouched.
 */

const ROLE_OPTIONS = [
    { value: "user",  label: "User" },
    { value: "admin", label: "Admin" },
];

const EMPTY_USER = () => ({
    username: "",
    password: "",
    role: "user",
    display_name: "",
    enabled: true,
});

const isAdminUser = (user) =>
    user?.role === "admin" ||
    String(user?.username || "").trim().toLowerCase() === "admin";

const formatDate = (value) => {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
};

export default function UserManagementPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const user = useAuthStore((s) => s.user);
    const logout = useAuthStore((s) => s.logout);
    const admin = isAdminUser(user);

    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [editing, setEditing] = useState(null); // { mode: "create"|"edit", draft: {...} }
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);

    useEffect(() => {
        if (!isAuthenticated) {
            navigate("/login");
        } else if (!admin) {
            navigate("/dashboard");
        }
    }, [isAuthenticated, admin, navigate]);

    const loadUsers = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await adminUserService.list();
            setUsers(Array.isArray(list) ? list : []);
        } catch (err) {
            setError(err?.response?.data?.message || err?.message || "사용자 목록을 불러올 수 없습니다.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && admin) loadUsers();
    }, [isAuthenticated, admin, loadUsers]);

    const handleNew = () => {
        setSaveError(null);
        setEditing({ mode: "create", draft: EMPTY_USER() });
    };

    const handleEdit = (u) => {
        setSaveError(null);
        setEditing({
            mode: "edit",
            draft: {
                username: u.username,
                password: "",
                role: u.role || "user",
                display_name: u.display_name || "",
                enabled: !!u.enabled,
            },
        });
    };

    const handleDelete = async (u) => {
        if (!window.confirm(`사용자 "${u.username}" 을(를) 삭제할까요?`)) return;
        try {
            await adminUserService.remove(u.username);
            await loadUsers();
        } catch (err) {
            window.alert(err?.response?.data?.message || "삭제 실패");
        }
    };

    const handleToggleEnabled = async (u) => {
        try {
            await adminUserService.update(u.username, { enabled: !u.enabled });
            await loadUsers();
        } catch (err) {
            window.alert(err?.response?.data?.message || "상태 변경 실패");
        }
    };

    const handleSave = async () => {
        if (!editing) return;
        const { mode, draft } = editing;
        const username = String(draft.username || "").trim();
        const password = String(draft.password || "");
        if (!username) {
            setSaveError("username이 필요합니다.");
            return;
        }
        if (mode === "create" && !password) {
            setSaveError("새 사용자는 비밀번호가 필요합니다.");
            return;
        }
        setSaving(true);
        setSaveError(null);
        try {
            if (mode === "create") {
                await adminUserService.create({
                    username,
                    password,
                    role: draft.role,
                    displayName: draft.display_name,
                    enabled: !!draft.enabled,
                });
            } else {
                const patch = {
                    role: draft.role,
                    displayName: draft.display_name,
                    enabled: !!draft.enabled,
                };
                if (password) patch.password = password;
                await adminUserService.update(username, patch);
            }
            setEditing(null);
            await loadUsers();
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
        <div className="user-mgmt-page">
            <header className="um-header">
                <button
                    type="button"
                    className="um-back-btn"
                    onClick={() => navigate("/dashboard")}
                    aria-label="뒤로가기"
                    title="대시보드로 돌아가기"
                >
                    <IconArrowLeft size={16} />
                </button>
                <div className="um-title-wrap">
                    <h1>👥 사용자 계정 관리</h1>
                    <p>시스템에 로그인할 수 있는 계정을 관리합니다. 비밀번호는 bcrypt로 저장됩니다.</p>
                </div>
                <div className="um-actions">
                    <span className="um-user">@{user?.username || "admin"}</span>
                    <button
                        type="button"
                        className="um-icon-btn-action um-icon-btn-primary"
                        onClick={handleNew}
                        title="새 사용자"
                        aria-label="새 사용자"
                    >
                        <IconPlus size={16} />
                    </button>
                    <button
                        type="button"
                        className="um-icon-btn-action"
                        onClick={loadUsers}
                        title="새로고침"
                        aria-label="새로고침"
                    >
                        <IconRefresh size={16} />
                    </button>
                    <button
                        type="button"
                        className="um-icon-btn-action"
                        onClick={handleLogout}
                        title="로그아웃"
                        aria-label="로그아웃"
                    >
                        <IconLogout size={16} />
                    </button>
                </div>
            </header>

            <main className="um-main">
                {error && <div className="um-error">{error}</div>}
                {loading ? (
                    <div className="um-loading">불러오는 중...</div>
                ) : users.length === 0 ? (
                    <div className="um-empty">
                        <p>등록된 사용자가 없습니다.</p>
                        <button type="button" className="um-btn um-btn-primary" onClick={handleNew}>
                            첫 사용자 추가
                        </button>
                    </div>
                ) : (
                    <table className="um-table">
                        <thead>
                            <tr>
                                <th>Username</th>
                                <th>Role</th>
                                <th>Display Name</th>
                                <th>Created</th>
                                <th>Updated</th>
                                <th>상태</th>
                                <th>작업</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((u) => {
                                const isSelf =
                                    String(u.username).toLowerCase() ===
                                    String(user?.username || "").toLowerCase();
                                return (
                                    <tr key={u.username}>
                                        <td className="um-mono">
                                            {u.username}
                                            {isSelf && <span className="um-badge">나</span>}
                                        </td>
                                        <td>
                                            <span className={`um-role-pill${u.role === "admin" ? " admin" : ""}`}>
                                                {u.role || "user"}
                                            </span>
                                        </td>
                                        <td>{u.display_name || "-"}</td>
                                        <td>{formatDate(u.created_at)}</td>
                                        <td>{formatDate(u.updated_at)}</td>
                                        <td>
                                            <button
                                                type="button"
                                                className={`um-toggle${u.enabled ? " on" : ""}`}
                                                onClick={() => handleToggleEnabled(u)}
                                                disabled={isSelf && u.enabled}
                                                title={
                                                    isSelf && u.enabled
                                                        ? "본인 계정은 비활성화할 수 없습니다"
                                                        : u.enabled
                                                        ? "끄기"
                                                        : "켜기"
                                                }
                                            >
                                                {u.enabled ? "ON" : "OFF"}
                                            </button>
                                        </td>
                                        <td className="um-row-actions">
                                            <button type="button" className="um-btn" onClick={() => handleEdit(u)}>수정</button>
                                            <button
                                                type="button"
                                                className="um-btn um-btn-danger"
                                                onClick={() => handleDelete(u)}
                                                disabled={isSelf}
                                                title={isSelf ? "본인 계정은 삭제할 수 없습니다" : "삭제"}
                                            >
                                                삭제
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </main>

            {editing && (
                <UserEditorModal
                    mode={editing.mode}
                    draft={editing.draft}
                    saving={saving}
                    errorMessage={saveError}
                    onChange={(draft) => setEditing({ ...editing, draft })}
                    onCancel={() => setEditing(null)}
                    onSave={handleSave}
                />
            )}
        </div>
    );
}

/* ── editor modal ─────────────────────────────────────────────────────── */

function UserEditorModal({ mode, draft, saving, errorMessage, onChange, onCancel, onSave }) {
    const isCreate = mode === "create";
    const update = (field, value) => onChange({ ...draft, [field]: value });

    return (
        <div className="um-modal-overlay" onMouseDown={(e) => e.stopPropagation()}>
            <div className="um-modal">
                <div className="um-modal-header">
                    <h3>{isCreate ? "새 사용자 추가" : `사용자 수정: ${draft.username}`}</h3>
                    <button type="button" className="um-icon-btn" onClick={onCancel} aria-label="닫기"><IconClose size={14} /></button>
                </div>
                <div className="um-modal-body">
                    <div className="um-grid-2">
                        <label>
                            <span>Username</span>
                            <input
                                type="text"
                                value={draft.username}
                                onChange={(e) => update("username", e.target.value)}
                                placeholder="예: alice"
                                disabled={!isCreate}
                                autoComplete="off"
                            />
                        </label>
                        <label>
                            <span>Role</span>
                            <select value={draft.role} onChange={(e) => update("role", e.target.value)}>
                                {ROLE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <label>
                        <span>Display Name (선택)</span>
                        <input
                            type="text"
                            value={draft.display_name || ""}
                            onChange={(e) => update("display_name", e.target.value)}
                            placeholder="예: Alice Kim"
                            autoComplete="off"
                        />
                    </label>

                    <label>
                        <span>
                            {isCreate ? "Password" : "Password (변경 시에만 입력)"}
                        </span>
                        <PasswordInput
                            value={draft.password}
                            onChange={(e) => update("password", e.target.value)}
                            placeholder={isCreate ? "최초 비밀번호" : "비워 두면 기존 비밀번호 유지"}
                            autoComplete="new-password"
                        />
                    </label>

                    <label className="um-checkbox">
                        <input
                            type="checkbox"
                            checked={!!draft.enabled}
                            onChange={(e) => update("enabled", e.target.checked)}
                        />
                        <span>활성화</span>
                    </label>

                    {errorMessage && <div className="um-error">{errorMessage}</div>}
                </div>
                <div className="um-modal-footer">
                    <button type="button" className="um-btn" onClick={onCancel} disabled={saving}>취소</button>
                    <button type="button" className="um-btn um-btn-primary" onClick={onSave} disabled={saving}>
                        {saving ? "저장 중..." : "저장"}
                    </button>
                </div>
            </div>
        </div>
    );
}

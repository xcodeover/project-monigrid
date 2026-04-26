import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authService } from "../services/api";
import { useAuthStore } from "../store/authStore";
import PasswordInput from "./PasswordInput";
import { IconClose } from "./icons";
import "./BackendConfigPasswordPrompt.css";

/**
 * 백엔드 설정 화면 진입 전 현재 사용자의 비밀번호를 한 번 더 확인하는 게이트.
 *
 * 백엔드에 별도 verify 엔드포인트가 없으므로 `/auth/login` 으로 검증한다.
 * 로그인이 성공하면 부수효과로 토큰이 갱신되며, 이를 authStore 에 반영해 세션도 함께 연장된다.
 */
const BackendConfigPasswordPrompt = ({ open, onClose, onSuccess }) => {
    const user = useAuthStore((s) => s.user);
    const login = useAuthStore((s) => s.login);
    const [password, setPassword] = useState("");
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (!open) {
            setPassword("");
            setError("");
            setVerifying(false);
        }
    }, [open]);

    if (!open) return null;

    const handleSubmit = async (e) => {
        e?.preventDefault?.();
        if (verifying || !password) return;
        if (!user?.username) {
            setError("로그인 정보가 없습니다. 다시 로그인해 주세요.");
            return;
        }
        setVerifying(true);
        setError("");
        try {
            const response = await authService.login(user.username, password);
            login(response.user, response.token);
            onSuccess();
        } catch (err) {
            const status = err?.response?.status;
            if (status === 401 || status === 403) {
                setError("비밀번호가 올바르지 않습니다.");
            } else {
                setError(
                    err?.response?.data?.message ||
                        "검증 실패. 잠시 후 다시 시도해주세요.",
                );
            }
        } finally {
            setVerifying(false);
        }
    };

    const stop = (e) => e.stopPropagation();

    const content = (
        <div
            className="bcp-overlay"
            onMouseDown={stop}
            onClick={stop}
        >
            <div className="bcp-popup" onMouseDown={stop} onClick={stop}>
                <div className="bcp-header">
                    <h5>비밀번호 확인</h5>
                    <button
                        type="button"
                        className="bcp-close"
                        onClick={onClose}
                        aria-label="닫기"
                    >
                        <IconClose size={16} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="bcp-body">
                    <p className="bcp-desc">
                        백엔드 설정 화면에 진입하려면 현재 사용자
                        {user?.username ? (
                            <>
                                {" "}
                                (<strong>{user.username}</strong>)
                            </>
                        ) : null}
                        의 비밀번호를 다시 입력해 주세요.
                    </p>
                    <label className="bcp-label">
                        <span>비밀번호</span>
                        <PasswordInput
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="현재 비밀번호"
                            autoFocus
                            disabled={verifying}
                            autoComplete="current-password"
                        />
                    </label>
                    {error && <div className="bcp-error">{error}</div>}
                    <div className="bcp-footer">
                        <button
                            type="button"
                            className="bcp-btn"
                            onClick={onClose}
                            disabled={verifying}
                        >
                            취소
                        </button>
                        <button
                            type="submit"
                            className="bcp-btn bcp-btn-primary"
                            disabled={verifying || !password}
                        >
                            {verifying ? "확인 중..." : "확인"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );

    return createPortal(content, document.body);
};

export default BackendConfigPasswordPrompt;

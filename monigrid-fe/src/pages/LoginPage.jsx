import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { authService } from "../services/api";
import AppLogo from "../components/AppLogo.jsx";
import "./LoginPage.css";

const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Monitoring Dashboard";
const COMPANY_NAME = import.meta.env.VITE_COMPANY_NAME || "Monitoring Dashboard";
const CURRENT_YEAR = new Date().getFullYear();

const LoginPage = () => {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const navigate = useNavigate();
    const login = useAuthStore((state) => state.login);

    const getLoginErrorMessage = (err) => {
        if (err.code === "ECONNABORTED") {
            return "타임아웃: 로그인 요청 시간이 초과되었습니다.";
        }

        if (!err.response) {
            return "서버 미기동: 백엔드 서버에 연결할 수 없습니다.";
        }

        if (err.response.status === 401 || err.response.status === 403) {
            return "인증실패: 사용자명 또는 비밀번호를 확인해주세요.";
        }

        return (
            err.response?.data?.message ||
            "로그인 실패: 잠시 후 다시 시도해주세요."
        );
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (loading) {
            return;
        }

        setError("");
        setLoading(true);

        try {
            const response = await authService.login(username, password);
            login(response.user, response.token);
            navigate("/dashboard");
        } catch (err) {
            setError(getLoginErrorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordKeyDown = (e) => {
        if (e.key === "Enter") {
            handleSubmit(e);
        }
    };

    return (
        <div className='login-page'>
            <div className='login-container'>
                <div className='login-box'>
                    <div className='login-header'>
                        <h1 className='app-title'>
                            <AppLogo size={38} className='app-title-logo' />
                            <span className='app-title-text'>{APP_TITLE}</span>
                        </h1>
                        <p>System Administrator</p>
                    </div>

                    {error && (
                        <div className='alert alert-error' role='alert'>
                            {error}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className='login-form'>
                        <div className='form-group'>
                            <label htmlFor='username'>사용자명</label>
                            <input
                                id='username'
                                type='text'
                                placeholder='username'
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                disabled={loading}
                                required
                            />
                        </div>

                        <div className='form-group'>
                            <label htmlFor='password'>비밀번호</label>
                            <input
                                id='password'
                                type='password'
                                placeholder='password'
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                onKeyDown={handlePasswordKeyDown}
                                disabled={loading}
                                required
                            />
                        </div>

                        <button
                            type='submit'
                            disabled={loading}
                            className='submit-btn'
                        >
                            {loading ? (
                                <>
                                    <span className='spinner'></span>
                                    로그인 중...
                                </>
                            ) : (
                                "로그인"
                            )}
                        </button>
                    </form>

                    <div className='login-footer'>
                        <p>
                            Copyright © {CURRENT_YEAR} {COMPANY_NAME}. All
                            rights reserved.
                        </p>
                    </div>
                </div>

                <div className='login-background'>
                    <div className='bg-animation'></div>
                </div>
            </div>
        </div>
    );
};

export default LoginPage;

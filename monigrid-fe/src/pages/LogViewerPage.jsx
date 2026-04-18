import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { dashboardService } from "../services/api";
import "./LogViewerPage.css";

const getToday = () => new Date().toISOString().split("T")[0];

export default function LogViewerPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const user = useAuthStore((state) => state.user);
    const logout = useAuthStore((state) => state.logout);
    const [logs, setLogs] = useState([]);
    const [startDate, setStartDate] = useState(getToday());
    const [endDate, setEndDate] = useState(getToday());
    const [maxLines, setMaxLines] = useState(1000);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [autoRefresh, setAutoRefresh] = useState(false);
    const [logCursor, setLogCursor] = useState(null);
    const logCursorRef = useRef(null);

    useEffect(() => {
        logCursorRef.current = logCursor;
    }, [logCursor]);

    useEffect(() => {
        if (!isAuthenticated) {
            navigate("/login");
        }
    }, [isAuthenticated, navigate]);

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const loadLogs = async (
        nextStartDate,
        nextEndDate,
        lines,
        {
            append = false,
            cursor = null,
            followLatest = false,
            silent = false,
            resetCursor = false,
        } = {},
    ) => {
        if (!silent) {
            setLoading(true);
        }
        setError(null);
        try {
            const data = await dashboardService.getLogs({
                startDate: nextStartDate,
                endDate: nextEndDate,
                maxLines: lines,
                cursor,
                followLatest,
            });

            const nextLogs = Array.isArray(data.logs) ? data.logs : [];
            setLogs((previousLogs) => {
                if (!append) {
                    return nextLogs;
                }

                const merged = [...previousLogs, ...nextLogs];
                return merged.slice(-lines);
            });
            setLogCursor(data.nextCursor || null);
            if (resetCursor) {
                logCursorRef.current = data.nextCursor || null;
            }
        } catch (err) {
            setError(
                err?.response?.data?.message || "로그를 불러올 수 없습니다.",
            );
        } finally {
            if (!silent) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        if (startDate > endDate) {
            setError(
                "기간 설정을 확인해주세요. 시작일은 종료일보다 늦을 수 없습니다.",
            );
            return;
        }

        setLogCursor(null);
        loadLogs(startDate, endDate, maxLines, { resetCursor: true });
    }, [startDate, endDate, maxLines]);

    useEffect(() => {
        if (!autoRefresh) return;

        const interval = setInterval(() => {
            const liveEndDate = endDate > getToday() ? endDate : getToday();
            loadLogs(startDate, liveEndDate, maxLines, {
                append: true,
                cursor: logCursorRef.current,
                followLatest: true,
                silent: true,
            });
        }, 5000);

        return () => clearInterval(interval);
    }, [autoRefresh, startDate, endDate, maxLines]);

    return (
        <div className='log-viewer'>
            <header className='log-page-header'>
                <div className='log-page-title-wrap'>
                    <h1>🔍 서버 로그</h1>
                    <p className='subtitle'>
                        기간별 서버 로그를 조회하고 실시간으로 모니터링할 수
                        있습니다.
                    </p>
                </div>

                <div className='log-page-actions'>
                    <div className='log-user-row'>
                        <span className='log-user-id'>
                            @{user?.username || "administrator"}
                        </span>
                        <button
                            className='logout-btn icon'
                            onClick={handleLogout}
                            title='로그아웃'
                        >
                            ⎋
                        </button>
                    </div>
                    <div className='log-action-row'>
                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={() => navigate("/")}
                            title='대시보드로 이동'
                        >
                            <span className='toolbar-btn-icon'>←</span>
                        </button>
                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={() => {
                                setLogCursor(null);
                                loadLogs(startDate, endDate, maxLines, {
                                    resetCursor: true,
                                });
                            }}
                            title='로그 새로고침'
                            disabled={loading}
                        >
                            <span className='toolbar-btn-icon'>⟳</span>
                        </button>
                    </div>
                </div>
            </header>

            <section className='log-controls-panel'>
                <div className='control-group'>
                    <label htmlFor='start-date'>시작일</label>
                    <input
                        id='start-date'
                        type='date'
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        disabled={loading}
                    />
                </div>

                <div className='control-group'>
                    <label htmlFor='end-date'>종료일</label>
                    <input
                        id='end-date'
                        type='date'
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        disabled={loading}
                    />
                </div>

                <div className='control-group'>
                    <label htmlFor='max-lines'>최대 라인 수</label>
                    <input
                        id='max-lines'
                        type='number'
                        value={maxLines}
                        onChange={(e) =>
                            setMaxLines(
                                Math.max(
                                    100,
                                    parseInt(e.target.value, 10) || 1000,
                                ),
                            )
                        }
                        min='100'
                        max='10000'
                        step='100'
                        disabled={loading}
                    />
                </div>

                <div className='control-group checkbox'>
                    <input
                        id='auto-refresh'
                        type='checkbox'
                        checked={autoRefresh}
                        onChange={(e) => setAutoRefresh(e.target.checked)}
                        disabled={loading}
                    />
                    <label htmlFor='auto-refresh'>
                        {autoRefresh ? "실시간 모니터링 중" : "실시간 모니터링"}
                    </label>
                </div>

                <button
                    className='primary-btn log-refresh-btn'
                    onClick={() => {
                        setLogCursor(null);
                        loadLogs(startDate, endDate, maxLines, {
                            resetCursor: true,
                        });
                    }}
                    disabled={loading || startDate > endDate}
                >
                    {loading ? "로딩 중..." : "조회"}
                </button>
            </section>

            {error && <div className='error-message'>{error}</div>}

            <section className='log-container'>
                <div className='log-count-bar'>
                    <span>
                        기간: {startDate} ~ {endDate}
                    </span>
                    <span>표시 라인: {logs.length}개</span>
                </div>

                {logs.length === 0 && !loading ? (
                    <div className='no-logs'>
                        선택한 기간에 로그가 없습니다.
                    </div>
                ) : (
                    <div className='log-content'>
                        {logs.map((log, index) => (
                            <div key={index} className='log-line'>
                                {log}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {autoRefresh && (
                <div className='refresh-indicator'>
                    <span className='live-badge'>● LIVE</span>
                    <span className='refresh-time'>
                        5초마다 자동 갱신 중...
                    </span>
                </div>
            )}
        </div>
    );
}

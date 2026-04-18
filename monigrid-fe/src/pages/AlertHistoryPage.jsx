import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { dashboardService } from "../services/api";
import IncidentTimelineCard from "../components/IncidentTimelineCard";

export default function AlertHistoryPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);

    const [incidents, setIncidents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!isAuthenticated) {
            navigate("/login");
        }
    }, [isAuthenticated, navigate]);

    const loadAlerts = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await dashboardService.getAlerts();
            setIncidents(Array.isArray(data) ? data : []);
        } catch (err) {
            setError(err?.response?.data?.message || "알림 이력을 불러올 수 없습니다.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isAuthenticated) {
            loadAlerts();
        }
    }, [isAuthenticated]);

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    return (
        <div className='log-viewer'>
            <header className='log-page-header'>
                <div className='log-page-title-wrap'>
                    <h1>🚨 알림 이력</h1>
                    <p>최근 알림/이벤트 이력을 확인합니다.</p>
                </div>
                <div className='log-page-actions'>
                    <span>{user?.username || "user"}</span>
                    <button type='button' className='logout-btn' onClick={() => navigate("/dashboard")}>
                        대시보드
                    </button>
                    <button type='button' className='logout-btn' onClick={handleLogout}>
                        로그아웃
                    </button>
                </div>
            </header>

            <main className='log-viewer-main'>
                <IncidentTimelineCard
                    incidents={incidents}
                    loading={loading}
                    error={error}
                    onRefresh={loadAlerts}
                />
            </main>
        </div>
    );
}
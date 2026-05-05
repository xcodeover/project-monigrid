import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";
import { dashboardService } from "../services/api";
import IncidentTimelineCard from "../components/IncidentTimelineCard";
import { useDocumentVisible } from "../hooks/useDocumentVisible";

export default function AlertHistoryPage() {
    const navigate = useNavigate();
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    const logout = useAuthStore((state) => state.logout);
    const user = useAuthStore((state) => state.user);
    const visible = useDocumentVisible();

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

    // visibility-aware 30s polling:
    // - 탭이 visible 이고 인증된 경우에만 폴링 실행
    // - hidden 진입 시 즉시 interval 정리 → 백그라운드 요청 0
    // - visible 복귀 시 즉시 1회 fetch + 30s 주기 재시작
    useEffect(() => {
        if (!isAuthenticated || !visible) return;
        loadAlerts();
        const id = setInterval(loadAlerts, 30_000);
        return () => clearInterval(id);
    // loadAlerts 는 deps 에서 의도적으로 제외. 이 함수는 imported singleton
    // (dashboardService.getAlerts) + React 가 보장하는 stable setter 들만 닫는다 →
    // 매 렌더의 새 reference 가 functionally identical, stale closure 문제 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, visible]);

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
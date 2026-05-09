import AppLogo from "../components/AppLogo.jsx";
import {
    IconCollapse,
    IconExpand,
    IconFileText,
    IconLayoutGrid,
    IconLogout,
    IconPlus,
    IconRefresh,
    IconSettings,
    IconSliders,
    IconUsers,
} from "../components/icons.jsx";

const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Monitoring Dashboard";

/**
 * Dashboard top header bar (SRP).
 *
 * Pure presentational — receives the widget count, the resolved user,
 * and a set of toolbar callbacks. Owns no state.
 *
 * `dashboardTitle` is the KV-persisted override set by admin via the settings
 * modal. Falls back to the build-time `APP_TITLE` (VITE_APP_TITLE env var →
 * "Monitoring Dashboard") when empty or not yet loaded.
 * Note: LoginPage intentionally keeps its own build-time title — unauthenticated
 * users cannot access the authenticated /dashboard/health endpoint.
 */
const DashboardHeader = ({
    widgetCount,
    user,
    isAdmin,
    isFullscreen,
    dashboardTitle,
    onToggleFullscreen,
    onOpenSettings,
    onOpenConfigEditor,
    onOpenAddApi,
    onOpenUserManagement,
    onRefreshAll,
    onOpenAlerts,
    onLogout,
}) => {
    const resolvedTitle = dashboardTitle || APP_TITLE;
    return (
        <header
            className={`dashboard-header${isFullscreen ? " dashboard-header-compact" : ""}`}
        >
            <div className='header-left'>
                <h1 className='app-title'>
                    <AppLogo size={34} className='app-title-logo' />
                    <span className='app-title-text'>{resolvedTitle}</span>
                </h1>
                <div className='header-subtitle-row'>
                    <p>Real-time Application Status &amp; Alerts</p>
                    <span
                        className='api-count'
                        title={`위젯 ${widgetCount}개`}
                    >
                        <span className='api-count-icon'>◫</span>
                        <span className='api-count-value'>{widgetCount}</span>
                    </span>
                </div>
            </div>

            <div className='header-right'>
                <div className='header-info-row'>
                    <span className='header-user-id'>
                        @{user?.username || "administrator"}
                    </span>
                    <button
                        className='logout-btn icon'
                        onClick={onLogout}
                        title='로그아웃'
                        aria-label='로그아웃'
                    >
                        <IconLogout size={16} />
                    </button>
                    <button
                        className={`fullscreen-btn icon${isFullscreen ? " active" : ""}`}
                        onClick={onToggleFullscreen}
                        title={isFullscreen ? "전체 화면 종료" : "전체 화면"}
                        aria-pressed={isFullscreen ? "true" : "false"}
                        aria-label={isFullscreen ? "전체 화면 종료" : "전체 화면"}
                    >
                        {isFullscreen ? (
                            <IconCollapse size={16} />
                        ) : (
                            <IconExpand size={16} />
                        )}
                    </button>
                </div>

                <div className='header-controls-row'>
                    <button
                        className='toolbar-btn toolbar-btn-primary'
                        onClick={onOpenAddApi}
                        title="위젯 추가"
                        aria-label='위젯 추가'
                    >
                        <IconPlus size={16} />
                    </button>
                    <button
                        className='toolbar-btn toolbar-btn-secondary'
                        onClick={onOpenSettings}
                        title="대시보드 설정"
                        aria-label='대시보드 설정'
                    >
                        <IconLayoutGrid size={16} />
                    </button>
                    {isAdmin && (
                        <button
                            className='toolbar-btn toolbar-btn-secondary toolbar-btn-backend'
                            onClick={onOpenConfigEditor}
                            title="백엔드 설정"
                            aria-label='백엔드 설정'
                        >
                            <IconSliders size={16} />
                        </button>
                    )}

                    {/* SQL 편집기 진입은 데이터 API row 의 ✏️ 버튼으로 이동
                        (백엔드 설정 → 위젯별 설정 → 데이터 API). */}

                    {isAdmin && (
                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={onOpenUserManagement}
                            title="사용자 계정 관리"
                            aria-label='사용자 계정 관리'
                        >
                            <IconUsers size={16} />
                        </button>
                    )}

                    <button
                        className='toolbar-btn toolbar-btn-secondary'
                        onClick={onRefreshAll}
                        disabled={!onRefreshAll}
                        title='전체 새로고침'
                        aria-label='전체 새로고침'
                    >
                        <IconRefresh size={16} />
                    </button>

                    <button
                        className='toolbar-btn toolbar-btn-secondary'
                        onClick={onOpenAlerts}
                        title='알림 이력'
                        aria-label='알림 이력'
                    >
                        <IconFileText size={16} />
                    </button>
                </div>
            </div>
        </header>
    );
};

export default DashboardHeader;

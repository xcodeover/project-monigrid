import AppLogo from "../components/AppLogo.jsx";

const APP_TITLE = import.meta.env.VITE_APP_TITLE || "Monitoring Dashboard";

/**
 * Dashboard top header bar (SRP).
 *
 * Pure presentational — receives the widget count, the resolved user,
 * and a set of toolbar callbacks. Owns no state.
 */
const DashboardHeader = ({
    widgetCount,
    user,
    isAdmin,
    onOpenSettings,
    onOpenConfigEditor,
    onOpenAddApi,
    onOpenSqlEditor,
    onRefreshAll,
    onOpenLogs,
    onLogout,
}) => {
    return (
        <header className='dashboard-header'>
            <div className='header-left'>
                <h1 className='app-title'>
                    <AppLogo size={34} className='app-title-logo' />
                    <span className='app-title-text'>{APP_TITLE}</span>
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
                    >
                        ⎋
                    </button>
                </div>

                <div className='header-controls-row'>
                    <button
                        className='toolbar-btn toolbar-btn-secondary'
                        onClick={onOpenSettings}
                        title='대시보드 설정'
                    >
                        <svg
                            className='toolbar-btn-icon'
                            width='14'
                            height='14'
                            viewBox='0 0 14 14'
                            fill='currentColor'
                        >
                            <rect x='0' y='0' width='6' height='6' rx='1.2' />
                            <rect x='8' y='0' width='6' height='6' rx='1.2' />
                            <rect x='0' y='8' width='6' height='6' rx='1.2' />
                            <rect x='8' y='8' width='6' height='6' rx='1.2' />
                        </svg>
                    </button>
                    {isAdmin && (
                        <button
                            className='toolbar-btn toolbar-btn-secondary toolbar-btn-backend'
                            onClick={onOpenConfigEditor}
                            title='백엔드 설정'
                        >
                            <span className='toolbar-btn-icon'>⚙</span>
                        </button>
                    )}
                    <button
                        className='toolbar-btn toolbar-btn-primary'
                        onClick={onOpenAddApi}
                        title='API 추가'
                    >
                        <span className='toolbar-btn-icon'>＋</span>
                    </button>

                    {isAdmin && (
                        <button
                            className='toolbar-btn toolbar-btn-secondary'
                            onClick={onOpenSqlEditor}
                            title='API SQL 편집'
                        >
                            <span className='toolbar-btn-icon'>⌘</span>
                        </button>
                    )}

                    <button
                        className='toolbar-btn toolbar-btn-secondary'
                        onClick={onRefreshAll}
                        title='전체 새로고침'
                    >
                        <span className='toolbar-btn-icon'>⟳</span>
                    </button>

                    <button
                        className='toolbar-btn toolbar-btn-secondary'
                        onClick={onOpenLogs}
                        title='서버 로그 조회'
                    >
                        <span className='toolbar-btn-icon'>📋</span>
                    </button>
                </div>
            </div>
        </header>
    );
};

export default DashboardHeader;

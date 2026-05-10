import React, { lazy, Suspense, useEffect } from "react";
import {
    BrowserRouter as Router,
    Routes,
    Route,
    Navigate,
    useNavigate,
} from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { useDashboardStore } from "./store/dashboardStore";
import { registerUnauthorizedHandler } from "./services/http";

const LoginPage = lazy(() => import("./pages/LoginPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const AlertHistoryPage = lazy(() => import("./pages/AlertHistoryPage"));
const UserManagementPage = lazy(() => import("./pages/UserManagementPage"));
// prismjs + react-simple-code-editor 등을 포함하는 무거운 페이지 — 진입 시점에만 로드
const ConfigEditorPage = lazy(() => import("./pages/ConfigEditorPage"));

/** Full-screen blank fallback — matches the dark background so there is no
 *  flash of white during the very first route chunk load. */
const PageFallback = () => (
    <div
        style={{
            minHeight: "100vh",
            background: "var(--bg-base)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
        }}
    />
);

const ProtectedRoute = ({ children }) => {
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    return isAuthenticated ? children : <Navigate to="/login" replace />;
};

const RootRedirect = () => {
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    return <Navigate to={isAuthenticated ? "/dashboard" : "/login"} replace />;
};

const LoginRoute = () => {
    const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
    return isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />;
};

/**
 * Inner component rendered inside <Router> so that useNavigate is available.
 *
 * Responsibilities:
 *  - One-shot session restore on boot
 *  - Register the 401 unauthorized handler that flushes pending dashboard
 *    pushes, disables server sync, logs out, and SPA-navigates to /login
 *    (no full-page reload → no chunk re-requests, no debounce data loss)
 */
function AppRoutes() {
    const navigate = useNavigate();

    // restoreSession only needs to run once on app boot. Calling it via
    // getState() avoids depending on the function's identity (which is
    // stable today but fragile if Zustand internals ever change) and makes
    // it visually obvious this is a one-shot, not a subscription.
    useEffect(() => {
        useAuthStore.getState().restoreSession();
    }, []);

    // Bridge http.js → Zustand: when the backend rejects with 401, http.js has
    // already cleared localStorage and set the latched flag.  We flush any
    // pending debounced push first so the user's last widget/layout edits
    // survive, then disable further pushes, clear in-memory auth state, and
    // SPA-navigate so React Router handles the transition (no full reload).
    useEffect(() => {
        registerUnauthorizedHandler(async () => {
            // 1. Flush any debounced push still pending — must come before
            //    disableServerSync so the flush actually sends the request.
            await useDashboardStore.getState().flushPendingPush().catch(() => {});
            // 2. Prevent any subsequent mutations from queuing new pushes.
            useDashboardStore.getState().disableServerSync();
            // 3. Clear in-memory auth state (localStorage already cleared by http.js).
            useAuthStore.getState().logout();
            // 4. SPA navigate — no full-page reload, no chunk re-requests.
            navigate("/login", { replace: true });
        });
        return () => registerUnauthorizedHandler(null);
    }, [navigate]);

    return (
        <Suspense fallback={<PageFallback />}>
            <Routes>
                <Route path="/login" element={<LoginRoute />} />
                <Route
                    path="/dashboard"
                    element={
                        <ProtectedRoute>
                            <DashboardPage />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/alerts"
                    element={
                        <ProtectedRoute>
                            <AlertHistoryPage />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/users"
                    element={
                        <ProtectedRoute>
                            <UserManagementPage />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/admin/config"
                    element={
                        <ProtectedRoute>
                            <ConfigEditorPage />
                        </ProtectedRoute>
                    }
                />
                <Route path="/" element={<RootRedirect />} />
                <Route path="*" element={<RootRedirect />} />
            </Routes>
        </Suspense>
    );
}

function App() {
    return (
        <Router>
            <AppRoutes />
        </Router>
    );
}

export default App;

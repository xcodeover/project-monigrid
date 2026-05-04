import React, { useEffect } from "react";
import {
    BrowserRouter as Router,
    Routes,
    Route,
    Navigate,
} from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import { useDashboardStore } from "./store/dashboardStore";
import { registerUnauthorizedHandler } from "./services/http";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import LogViewerPage from "./pages/LogViewerPage";
import AlertHistoryPage from "./pages/AlertHistoryPage";
import UserManagementPage from "./pages/UserManagementPage";

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

function App() {
    // restoreSession only needs to run once on app boot. Calling it via
    // getState() avoids depending on the function's identity (which is
    // stable today but fragile if Zustand internals ever change) and makes
    // it visually obvious this is a one-shot, not a subscription.
    useEffect(() => {
        useAuthStore.getState().restoreSession();
    }, []);

    // Bridge http.js → Zustand: when the backend rejects with 401, http.js has
    // already cleared localStorage; we also need to drop in-memory auth state
    // and stop the dashboard preference push debounce so the next render
    // doesn't briefly show the previous session's data on the login page.
    useEffect(() => {
        registerUnauthorizedHandler(() => {
            useAuthStore.getState().logout();
            useDashboardStore.getState().disableServerSync();
        });
        return () => registerUnauthorizedHandler(null);
    }, []);

    return (
        <Router>
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
                    path="/logs"
                    element={
                        <ProtectedRoute>
                            <LogViewerPage />
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
                <Route path="/" element={<RootRedirect />} />
                <Route path="*" element={<RootRedirect />} />
            </Routes>
        </Router>
    );
}

export default App;

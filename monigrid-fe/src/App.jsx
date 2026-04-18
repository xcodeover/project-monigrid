import React, { useEffect } from "react";
import {
    HashRouter,
    BrowserRouter as Router,
    Routes,
    Route,
    Navigate,
} from "react-router-dom";
import { useAuthStore } from "./store/authStore";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import LogViewerPage from "./pages/LogViewerPage";
import AlertHistoryPage from "./pages/AlertHistoryPage";

// Electron serves over file:// — HashRouter avoids 404s on deep links.
const isElectron = () => window.location.protocol === "file:";

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
    const restoreSession = useAuthStore((state) => state.restoreSession);
    const ActiveRouter = isElectron() ? HashRouter : Router;

    useEffect(() => {
        restoreSession();
    }, [restoreSession]);

    return (
        <ActiveRouter>
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
                <Route path="/" element={<RootRedirect />} />
                <Route path="*" element={<RootRedirect />} />
            </Routes>
        </ActiveRouter>
    );
}

export default App;

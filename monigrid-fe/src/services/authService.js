/**
 * Auth service (SRP): login and logout API calls only.
 */
import apiClient, { rememberApiBaseUrl } from "./http.js";

const authService = {
    login: async (username, password) => {
        const response = await apiClient.post("/auth/login", { username, password });
        rememberApiBaseUrl(response?.config?.baseURL || apiClient.defaults.baseURL);
        return response.data;
    },

    logout: async () => {
        try {
            await apiClient.post("/auth/logout");
        } catch (error) {
            console.error("Logout error:", error);
        }
    },
};

export default authService;

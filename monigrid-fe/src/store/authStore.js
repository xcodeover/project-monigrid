import { create } from "zustand";
import { STORAGE_KEYS } from "./storageKeys.js";

const getStoredSession = () => {
    const token = localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN);
    const rawUser = localStorage.getItem(STORAGE_KEYS.USER);

    if (!token || !rawUser) return { token: null, user: null };

    try {
        return { token, user: JSON.parse(rawUser) };
    } catch {
        localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER);
        return { token: null, user: null };
    }
};

const storedSession = getStoredSession();

export const useAuthStore = create((set) => ({
    user: storedSession.user,
    isAuthenticated: !!(storedSession.token && storedSession.user),

    login: (user, token) => {
        localStorage.setItem(STORAGE_KEYS.AUTH_TOKEN, token);
        localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
        set({ user, isAuthenticated: true });
    },

    logout: () => {
        localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER);
        set({ user: null, isAuthenticated: false });
    },

    restoreSession: () => {
        const session = getStoredSession();
        if (session.token && session.user) {
            set({ user: session.user, isAuthenticated: true });
            return;
        }
        localStorage.removeItem(STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(STORAGE_KEYS.USER);
        set({ user: null, isAuthenticated: false });
    },
}));

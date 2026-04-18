/**
 * useApiData (SRP): polls a single endpoint with automatic retry and online detection.
 */
import { useState, useEffect, useCallback } from "react";
import dashboardService from "../services/dashboardService.js";
import { isRetryable, formatErrorMessage } from "../services/http.js";

const MAX_RETRIES = parseInt(import.meta.env.VITE_RETRY_ATTEMPTS || "3");
const RETRY_DELAY = parseInt(import.meta.env.VITE_RETRY_DELAY_MS || "1000");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const useApiData = (endpoint, interval = null) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const [isOnline, setIsOnline] = useState(navigator.onLine);

    const fetchData = useCallback(
        async (attempt = 1) => {
            if (!navigator.onLine) {
                setError("오프라인 상태입니다. 인터넷 연결을 확인하세요.");
                return;
            }

            setData((prev) => {
                if (prev === null) setLoading(true);
                else setRefreshing(true);
                return prev;
            });

            try {
                const response = await dashboardService.getApiData("", endpoint);
                setData(response);
                setError(null);
            } catch (err) {
                if (isRetryable(err) && attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY * Math.pow(2, attempt - 1));
                    return fetchData(attempt + 1);
                }
                setError(formatErrorMessage(err));
                setData(null);
            } finally {
                setLoading(false);
                setRefreshing(false);
            }
        },
        [endpoint],
    );

    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => {
            setIsOnline(false);
            setError("오프라인 상태입니다.");
        };
        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);
        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, []);

    useEffect(() => {
        fetchData();
        if (!interval) return;
        const timer = setInterval(fetchData, interval);
        return () => clearInterval(timer);
    }, [endpoint, interval, fetchData]);

    return { data, loading, refreshing, error, isOnline, refetch: fetchData };
};

export default useApiData;

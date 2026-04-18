/**
 * useMultipleApiData (SRP): polls multiple endpoints simultaneously.
 */
import { useState, useEffect, useCallback } from "react";
import dashboardService from "../services/dashboardService.js";
import { isRetryable } from "../services/http.js";

const MAX_RETRIES = parseInt(import.meta.env.VITE_RETRY_ATTEMPTS || "3");
const RETRY_DELAY = parseInt(import.meta.env.VITE_RETRY_DELAY_MS || "1000");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const useMultipleApiData = (endpoints, interval = null) => {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const [isOnline, setIsOnline] = useState(navigator.onLine);

    const fetchData = useCallback(
        async (attempt = 1) => {
            if (!navigator.onLine) {
                setError("오프라인 상태입니다.");
                return;
            }

            setData((prev) => {
                if (prev.length === 0) setLoading(true);
                else setRefreshing(true);
                return prev;
            });

            try {
                const results = await dashboardService.getMultipleApiData(endpoints);
                setData(results);
                setError(null);
            } catch (err) {
                if (isRetryable(err) && attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY * Math.pow(2, attempt - 1));
                    return fetchData(attempt + 1);
                }
                setError(err.message || "데이터 로드 실패");
            } finally {
                setLoading(false);
                setRefreshing(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [endpoints.length],
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
        if (endpoints.length === 0) return;
        fetchData();
        if (!interval) return;
        const timer = setInterval(fetchData, interval);
        return () => clearInterval(timer);
    }, [endpoints.length, interval, fetchData]);

    return { data, loading, refreshing, error, isOnline, refetch: fetchData };
};

export default useMultipleApiData;

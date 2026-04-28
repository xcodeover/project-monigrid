/**
 * useApiData (SRP): polls a single endpoint with automatic retry and online detection.
 *
 * Stale-response guard: an epoch ref is bumped every time `endpoint` changes.
 * In-flight requests carry the epoch they were started at and are silently
 * dropped on resolve if a newer epoch has since been issued. Without this a
 * slow response to an old endpoint could overwrite a faster response to the
 * new one, leaving the user staring at the previous endpoint's data.
 */
import { useState, useEffect, useCallback, useRef } from "react";
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

    // Bumped on every (endpoint) change so stale responses can be ignored.
    const epochRef = useRef(0);

    const fetchData = useCallback(
        async (attempt = 1) => {
            if (!navigator.onLine) {
                setError("오프라인 상태입니다. 인터넷 연결을 확인하세요.");
                return;
            }

            const myEpoch = epochRef.current;

            setData((prev) => {
                if (prev === null) setLoading(true);
                else setRefreshing(true);
                return prev;
            });

            try {
                const response = await dashboardService.getApiData("", endpoint);
                if (myEpoch !== epochRef.current) return; // stale, drop
                setData(response);
                setError(null);
            } catch (err) {
                if (myEpoch !== epochRef.current) return; // stale, drop
                if (isRetryable(err) && attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY * Math.pow(2, attempt - 1));
                    if (myEpoch !== epochRef.current) return;
                    return fetchData(attempt + 1);
                }
                setError(formatErrorMessage(err));
                setData(null);
            } finally {
                if (myEpoch === epochRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
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
        // New endpoint → invalidate any in-flight responses still on the wire.
        epochRef.current += 1;
        fetchData();
        if (!interval) return;
        const timer = setInterval(fetchData, interval);
        return () => {
            clearInterval(timer);
            // Cleanup also bumps the epoch so the unmount window doesn't
            // setState on a dead component.
            epochRef.current += 1;
        };
    }, [endpoint, interval, fetchData]);

    return { data, loading, refreshing, error, isOnline, refetch: fetchData };
};

export default useApiData;

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { timemachineService } from "../services/api";
import { buildSnapshotMap } from "../utils/snapshotKey";

const Ctx = createContext(null);

const FETCH_DEBOUNCE_MS = 250;

export function TimemachineProvider({ children }) {
    const [enabled, setEnabled] = useState(false);
    const [atMs, setAtMs] = useState(null);
    const [snapshotByKey, setSnapshotByKey] = useState(() => new Map());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [stats, setStats] = useState(null);
    const debounceRef = useRef(null);
    const abortRef = useRef(null);

    // stats (earliest/latest) 는 모드 켜질 때 한 번 + 30초 주기
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const load = async () => {
            try {
                const s = await timemachineService.stats();
                if (!cancelled) setStats(s);
            } catch (e) {
                if (!cancelled) setError("stats 조회 실패: " + (e?.message || ""));
            }
        };
        load();
        const id = setInterval(load, 30_000);
        return () => { cancelled = true; clearInterval(id); };
    }, [enabled]);

    const fetchAt = useCallback(async (ms) => {
        if (abortRef.current) abortRef.current.abort();
        abortRef.current = new AbortController();
        setLoading(true);
        setError(null);
        try {
            const data = await timemachineService.queryAt(
                { at: ms, signal: abortRef.current.signal },
            );
            const items = Array.isArray(data?.items) ? data.items : [];
            setSnapshotByKey(buildSnapshotMap(items));
        } catch (e) {
            if (e?.name === "CanceledError" || e?.name === "AbortError") return;
            setError(e?.response?.data?.message || e?.message || "스냅샷 조회 실패");
            setSnapshotByKey(new Map());
        } finally {
            setLoading(false);
        }
    }, []);

    // atMs 변경 시 250ms 디바운스 후 fetch
    useEffect(() => {
        if (!enabled || atMs == null) return;
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => fetchAt(atMs), FETCH_DEBOUNCE_MS);
        return () => clearTimeout(debounceRef.current);
    }, [enabled, atMs, fetchAt]);

    const enable = useCallback((initialMs) => {
        const ms = initialMs ?? Date.now() - 5 * 60 * 1000; // 5분 전 기본
        setAtMs(ms);
        setEnabled(true);
    }, []);

    const disable = useCallback(() => {
        setEnabled(false);
        setSnapshotByKey(new Map());
        setError(null);
        setAtMs(null);
        if (abortRef.current) abortRef.current.abort();
    }, []);

    const value = useMemo(() => ({
        enabled, atMs, snapshotByKey, loading, error,
        earliestMs: stats?.minTsMs ?? null,
        latestMs: stats?.maxTsMs ?? null,
        retentionEnabled: stats?.enabled !== false,
        setAtMs, enable, disable,
    }), [enabled, atMs, snapshotByKey, loading, error, stats, enable, disable]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimemachine() {
    const v = useContext(Ctx);
    if (!v) throw new Error("useTimemachine must be inside TimemachineProvider");
    return v;
}

/** 컴포넌트가 timemachine 의 enabled 만 필요한 경우 (가벼운 selector) */
export function useTimemachineEnabled() {
    return useContext(Ctx)?.enabled ?? false;
}

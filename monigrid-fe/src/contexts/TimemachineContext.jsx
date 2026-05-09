import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { timemachineService } from "../services/api";
import { buildSnapshotMap } from "../utils/snapshotKey";
import { createPrefetchBuffer } from "../utils/timemachinePrefetchBuffer";

const Ctx = createContext(null);

const FETCH_DEBOUNCE_MS = 250;

export function TimemachineProvider({ children }) {
    const [enabled, setEnabled] = useState(false);
    const [atMs, setAtMs] = useState(null);
    const [snapshotByKey, setSnapshotByKey] = useState(() => new Map());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [stats, setStats] = useState(null);

    // Phase 2: playback state
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);          // 1 / 2 / 5 / 10
    const [frameSizeMs, setFrameSizeMs] = useState(30_000); // 30s default

    const debounceRef = useRef(null);
    const abortRef = useRef(null);
    const bufferRef = useRef(createPrefetchBuffer(200));
    const playTickRef = useRef(null);

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
            const snapshotMap = buildSnapshotMap(items);
            setSnapshotByKey(snapshotMap);
            // also store in buffer for future hits
            const aligned = Math.floor(ms / frameSizeMs) * frameSizeMs;
            bufferRef.current.add(aligned, snapshotMap);
        } catch (e) {
            if (e?.name === "CanceledError" || e?.name === "AbortError") return;
            setError(e?.response?.data?.message || e?.message || "스냅샷 조회 실패");
            setSnapshotByKey(new Map());
        } finally {
            setLoading(false);
        }
    }, [frameSizeMs]);

    // Phase 2: prefetch logic
    const ensurePrefetched = useCallback(async (centerMs) => {
        const buf = bufferRef.current;
        const stepMs = frameSizeMs;
        const ahead = 30 * stepMs;     // 30 frame 앞 prefetch
        const behind = 5 * stepMs;
        const earliestMs = stats?.minTsMs ?? centerMs - 3600_000;
        const fromMs = Math.max(centerMs - behind, earliestMs);
        const toMs = Math.min(centerMs + ahead, Date.now());

        // align to frame
        const alignedFrom = Math.floor(fromMs / stepMs) * stepMs;
        const alignedTo = Math.floor(toMs / stepMs) * stepMs;

        // missing frame 이 5개 이상이면 일괄 fetch
        let missing = 0;
        for (let t = alignedFrom; t <= alignedTo; t += stepMs) {
            if (!buf.has(t)) missing++;
        }
        if (missing < 5) return;

        try {
            const data = await timemachineService.queryWindow({
                from: alignedFrom, to: alignedTo, stepMs,
            });
            buf.addAll(data?.items || []);
        } catch (e) {
            // prefetch 실패는 silent — 단일 프레임 fetch 가 fallback
        }
    }, [frameSizeMs, stats]);

    // atMs 변경 시 buffer hit 우선, 없으면 디바운스 fetch
    useEffect(() => {
        if (!enabled || atMs == null) return;
        const aligned = Math.floor(atMs / frameSizeMs) * frameSizeMs;
        const cached = bufferRef.current.get(aligned);
        if (cached) {
            // 즉시 현재 snapshot 으로 사용 — fetch 우회
            setSnapshotByKey(cached);
            setError(null);
        } else {
            clearTimeout(debounceRef.current);
            debounceRef.current = setTimeout(() => fetchAt(atMs), FETCH_DEBOUNCE_MS);
        }
        // background prefetch 트리거
        ensurePrefetched(atMs);
        return () => clearTimeout(debounceRef.current);
    }, [enabled, atMs, frameSizeMs, fetchAt, ensurePrefetched]);

    // Phase 2: playback tick — 1초 tick, atMs 를 frameSizeMs * speed 만큼 전진
    useEffect(() => {
        if (!enabled || !playing) {
            clearInterval(playTickRef.current);
            return;
        }
        playTickRef.current = setInterval(() => {
            setAtMs((cur) => {
                const next = (cur ?? Date.now()) + frameSizeMs * speed;
                const latest = stats?.maxTsMs ?? Date.now();
                if (next >= latest) {
                    setPlaying(false);
                    return latest;
                }
                return next;
            });
        }, 1000);
        return () => clearInterval(playTickRef.current);
    }, [enabled, playing, frameSizeMs, speed, stats]);

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
        setPlaying(false);
        bufferRef.current.clear();
        if (abortRef.current) abortRef.current.abort();
    }, []);

    const value = useMemo(() => ({
        enabled, atMs, snapshotByKey, loading, error,
        earliestMs: stats?.minTsMs ?? null,
        latestMs: stats?.maxTsMs ?? null,
        retentionEnabled: stats?.enabled !== false,
        playing, speed, frameSizeMs,
        setAtMs, setPlaying, setSpeed, setFrameSizeMs,
        enable, disable,
    }), [enabled, atMs, snapshotByKey, loading, error, stats,
        playing, speed, frameSizeMs, enable, disable]);

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

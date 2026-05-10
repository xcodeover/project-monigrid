import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { dashboardService, timemachineService } from "../services/api";
import { buildSnapshotMap, snapshotKeyForWidget as snapshotKeyForWidgetStatic } from "../utils/snapshotKey";
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

    // endpoint catalog (api_id ↔ endpoint URL 매핑) — widget.endpoint 만 알고 있는
    // 데이터 API 위젯의 snapshot key 를 정확히 풀기 위해 필요. 60s 주기로 갱신.
    const [endpointCatalog, setEndpointCatalog] = useState([]);

    // playback state — 1초 real-time tick 마다 frameSizeMs 만큼 전진.
    // frameSizeMs 는 사용자가 dropdown 으로 선택 (1s 기본 = 실시간, 그 이상은 빨리감기).
    const [playing, setPlaying] = useState(false);
    const [frameSizeMs, setFrameSizeMs] = useState(1_000);

    const debounceRef = useRef(null);
    const abortRef = useRef(null);
    const bufferRef = useRef(createPrefetchBuffer(200));
    const playTickRef = useRef(null);

    // endpoint catalog 는 mount 후 한 번 + 60초 주기
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const list = await dashboardService.getApiEndpoints();
                if (!cancelled) setEndpointCatalog(Array.isArray(list) ? list : []);
            } catch {
                /* swallow — fallback 으로 widget.id / endpoint URL 휴리스틱 사용 */
            }
        };
        load();
        const id = setInterval(load, 60_000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    // widget → (sourceType, sourceId) 키 풀이. 데이터 API 위젯은 widget.endpoint
    // (URL) 를 endpoint catalog 와 매칭해 api_id 를 얻는다.
    const resolveSnapshotKey = useCallback((widget) => {
        if (!widget) return null;
        // 명시적 apiId/endpointId 가 widget 에 있으면 우선 사용 (정적 helper 와 동일)
        const staticKey = snapshotKeyForWidgetStatic(widget);
        if (staticKey) return staticKey;
        const t = widget.type;
        if (t === "table" || t === "line-chart" || t === "bar-chart" || t === "health-check") {
            const wEndpoint = (widget.endpoint || "").trim();
            if (!wEndpoint) return null;
            // catalog 에서 endpoint 가 일치하는 entry → id (api_id) 추출
            const hit = endpointCatalog.find(
                (ep) => (ep?.endpoint || "").trim() === wEndpoint,
            );
            if (hit?.id) return `data_api|${hit.id}`;
            // fallback: "/api/{id}" 패턴이면 마지막 세그먼트를 api_id 로 추정
            const m = /\/api\/([^/?#]+)/i.exec(wEndpoint);
            if (m && m[1]) return `data_api|${m[1]}`;
        }
        return null;
    }, [endpointCatalog]);

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

    // playback tick — 1초 real-time 마다 atMs 를 frameSizeMs 만큼 전진.
    // latest 도달하면 자동 stop.
    useEffect(() => {
        if (!enabled || !playing) {
            clearInterval(playTickRef.current);
            return;
        }
        playTickRef.current = setInterval(() => {
            setAtMs((cur) => {
                const next = (cur ?? Date.now()) + frameSizeMs;
                const latest = stats?.maxTsMs ?? Date.now();
                if (next >= latest) {
                    setPlaying(false);
                    return latest;
                }
                return next;
            });
        }, 1000);
        return () => clearInterval(playTickRef.current);
    }, [enabled, playing, frameSizeMs, stats]);

    const enable = useCallback(async (initialMs) => {
        // 사용자가 명시한 시점이 있으면 그대로 사용. 아니면 BE 의 timemachine
        // archive 가 가지고 있는 가장 오래된 데이터 시점을 시작점으로 잡는다.
        // stats 조회 실패 시 fallback 으로 "5분 전" 사용 (이전 default).
        const fallback = Date.now() - 5 * 60 * 1000;
        setAtMs(initialMs ?? fallback);
        setEnabled(true);
        if (initialMs != null) return;
        try {
            const s = await timemachineService.stats();
            setStats(s);
            const earliest = s?.minTsMs;
            if (earliest != null) setAtMs(earliest);
        } catch {
            /* fallback 유지 — 에러는 enabled 후 useEffect 가 잡아서 표시 */
        }
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
        playing, frameSizeMs,
        setAtMs, setPlaying, setFrameSizeMs,
        enable, disable,
        resolveSnapshotKey,
    }), [enabled, atMs, snapshotByKey, loading, error, stats,
        playing, frameSizeMs, enable, disable, resolveSnapshotKey]);

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

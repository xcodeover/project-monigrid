# Timemachine Dashboard Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 메인 대시보드를 timemachine 모드로 전환할 수 있게 하고(라이브 ↔ 과거 시점 스냅샷), 비디오 재생 식 컨트롤로 시간을 스크럽/재생/속도조절하며, 위젯 더블클릭 시 위젯 종류별 상세 모달을 띄운다. 기존 별도 `/timemachine` 페이지는 제거.

**Architecture:** React Context (`TimemachineContext`) 가 모드 enable/disable + 현재 atMs + snapshot cache + 재생 상태(Phase 2) 를 보관. 모든 위젯의 데이터 hook 들이 context 를 consult 해 mode ON 일 때 라이브 fetch 대신 snapshot.payload 를 반환. BE 의 기존 `GET /dashboard/timemachine?at=ISO` 를 Phase 1 에서 활용하고 Phase 2/3 에서 신규 endpoint(`window`, `series`) 추가.

**Tech Stack:** React 18 (hooks + Context), Vite, Recharts (Phase 3 detail charts 재사용), Python 3.13 / Flask / SQLite (BE timemachine_store)

**Spec:** [2026-05-09-timemachine-dashboard-design.md](../specs/2026-05-09-timemachine-dashboard-design.md)

---

## File Structure

### FE — 신규
- `monigrid-fe/src/contexts/TimemachineContext.jsx` — Context + Provider (mode state, snapshot, playback)
- `monigrid-fe/src/components/TimemachineBanner.jsx` (+ `.css`) — 상단 모드 표시 banner
- `monigrid-fe/src/components/TimemachineControlBar.jsx` (+ `.css`) — 하단 컨트롤 바
- `monigrid-fe/src/hooks/useTimemachineOrLive.js` — 위젯 데이터 hook 의 timemachine 분기 helper
- `monigrid-fe/src/utils/snapshotKey.js` — sourceType/sourceId 매핑
- `monigrid-fe/src/utils/timemachinePrefetchBuffer.js` — Phase 2: LRU 버퍼
- `monigrid-fe/src/components/TimemachineDetailModal.jsx` (+ `.css`) — Phase 3: 모달 shell
- `monigrid-fe/src/components/timemachine-detail/ServerResourceDetail.jsx` — Phase 3
- `monigrid-fe/src/components/timemachine-detail/NetworkDetail.jsx` — Phase 3
- `monigrid-fe/src/components/timemachine-detail/HttpStatusDetail.jsx` — Phase 3
- `monigrid-fe/src/components/timemachine-detail/DataApiTableDetail.jsx` — Phase 3
- `monigrid-fe/src/components/timemachine-detail/DataApiChartDetail.jsx` — Phase 3 (line/bar 공용)
- `monigrid-fe/src/components/timemachine-detail/StatusListDetail.jsx` — Phase 3 (health-check 도 사용)

### FE — 수정
- `monigrid-fe/src/services/dashboardService.js` — `timemachineService.queryWindow` (Phase 2), `queryRange` (Phase 3)
- `monigrid-fe/src/pages/DashboardPage.jsx` — `<TimemachineProvider>` wrap + banner/control-bar 렌더 + read-only 강제
- `monigrid-fe/src/pages/DashboardHeader.jsx` — 타임머신 toolbar 버튼을 토글로 재정의
- `monigrid-fe/src/hooks/useWidgetApiData.js` — timemachine 분기 추가
- `monigrid-fe/src/components/ServerResourceCard.jsx` — timemachine 분기
- `monigrid-fe/src/components/NetworkTestCard.jsx` — timemachine 분기
- `monigrid-fe/src/components/ApiCard.jsx` / `LineChartCard.jsx` / `BarChartCard.jsx` / `StatusListCard.jsx` / `HealthCheckCard.jsx` — Phase 3: onDoubleClick → openDetail
- `monigrid-fe/src/App.jsx` (또는 router) — Phase 4: `/timemachine` 라우트 제거

### FE — 제거 (Phase 4)
- `monigrid-fe/src/pages/TimemachinePage.jsx`
- `monigrid-fe/src/pages/TimemachinePage.css`

### BE — 수정
- `monigrid-be/app/routes/timemachine_routes.py` — Phase 2: `GET /dashboard/timemachine/window`, Phase 3: `GET /dashboard/timemachine/series`
- `monigrid-be/app/timemachine_store.py` — Phase 3: `list_samples_range(source_type, source_id, from_ms, to_ms, limit)`

### BE — 신규 테스트
- `monigrid-be/scripts/test_timemachine_endpoints.py` — Phase 2/3 의 endpoint 통합 테스트

---

# Phase 1 — Foundation

## Task 1.1: snapshotKey 매핑 helper

**Files:** Create `monigrid-fe/src/utils/snapshotKey.js`

- [ ] **Step 1: Write helper**

```js
/**
 * widget object → BE timemachine 의 (sourceType, sourceId) key.
 * BE collector 가 INSERT 하는 source_type/source_id 와 정확히 일치해야 함.
 *
 * sourceType 매핑 (확인된 값):
 *   - "data_api"             : 데이터 API endpoint (table/line-chart/bar-chart 위젯)
 *   - "monitor:server_resource"
 *   - "monitor:network"
 *   - "monitor:http_status"  : status-list 위젯이 다중 target 합성 시에도 사용
 */
export function snapshotKeyForWidget(widget) {
    if (!widget) return null;
    const t = widget.type;
    if (t === "server-resource") {
        // 단일 타깃 widget 은 spec 없이 widget.targetId 사용
        const id = widget.serverResourceSettings?.targetId || widget.targetId;
        return id ? `monitor:server_resource|${id}` : null;
    }
    if (t === "network-test") {
        const id = widget.networkTestSettings?.targetId || widget.targetId;
        return id ? `monitor:network|${id}` : null;
    }
    if (t === "status-list") {
        // status-list 는 다중 target 을 합성 — Phase 1 에서 단일 source 제공 불가.
        // 대신 mode 에 따라 widget 단계에서 합성을 위젯 컴포넌트가 직접 수행.
        return null;
    }
    if (t === "table" || t === "line-chart" || t === "bar-chart" || t === "health-check") {
        const apiId = widget.apiId || widget.endpointId;
        return apiId ? `data_api|${apiId}` : null;
    }
    return null;
}

/** snapshot array → Map<key, snapshotItem> */
export function buildSnapshotMap(items) {
    const map = new Map();
    if (!Array.isArray(items)) return map;
    for (const it of items) {
        const k = `${it.sourceType}|${it.sourceId}`;
        map.set(k, it);
    }
    return map;
}
```

- [ ] **Step 2: Smoke test in browser console**

```js
import { snapshotKeyForWidget, buildSnapshotMap } from "/src/utils/snapshotKey.js";
// snapshotKeyForWidget({type:"table", apiId:"status"}) === "data_api|status"
// snapshotKeyForWidget({type:"server-resource", serverResourceSettings:{targetId:"db-01"}}) === "monitor:server_resource|db-01"
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/utils/snapshotKey.js
git commit -m "feat(fe): snapshotKey helper for timemachine widget mapping"
```

## Task 1.2: TimemachineContext + Provider

**Files:** Create `monigrid-fe/src/contexts/TimemachineContext.jsx`

- [ ] **Step 1: Implement context skeleton**

```jsx
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

    // stats (earliest/latest) 는 모드 켜질 때 한 번 + 30초 주기 (재생 중일 땐 60초)
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
                { at: ms },
                { signal: abortRef.current.signal },
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
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/contexts/TimemachineContext.jsx
git commit -m "feat(fe): TimemachineContext + Provider (Phase 1)"
```

## Task 1.3: useTimemachineOrLive helper

**Files:** Create `monigrid-fe/src/hooks/useTimemachineOrLive.js`

- [ ] **Step 1: Implement helper**

```js
import { useTimemachine } from "../contexts/TimemachineContext";

/**
 * 위젯의 데이터 hook 에서 timemachine 모드 분기를 단일 라인으로 처리.
 *
 * 사용 패턴:
 *     const tmResult = useTimemachineOrLive(snapshotKey);
 *     if (tmResult.timemachineActive) return tmResult;  // live polling 스킵
 *     // 기존 라이브 polling 로직
 *
 * 반환값:
 *   - timemachineActive: false → live mode, 호출자가 자기 fetch 수행
 *   - timemachineActive: true  → snapshot data 그대로 반환,
 *                                호출자는 즉시 그것을 자기 결과로 사용
 */
export function useTimemachineOrLive(snapshotKey) {
    const tm = useTimemachine();
    if (!tm.enabled) return { timemachineActive: false };
    const snap = snapshotKey ? tm.snapshotByKey.get(snapshotKey) : null;
    return {
        timemachineActive: true,
        data: snap?.payload ?? null,
        loading: tm.loading && !snap,
        error: tm.error || (snap ? null : "이 시점에 데이터 없음"),
        tsMs: snap?.tsMs ?? null,
        atMs: tm.atMs,
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/hooks/useTimemachineOrLive.js
git commit -m "feat(fe): useTimemachineOrLive helper hook"
```

## Task 1.4: useWidgetApiData 의 timemachine 분기

**Files:** Modify `monigrid-fe/src/hooks/useWidgetApiData.js`

- [ ] **Step 1: Add import + early-return branch**

위 hook 의 가장 위 import 들 아래:
```js
import { snapshotKeyForWidget } from "../utils/snapshotKey";
import { useTimemachineOrLive } from "./useTimemachineOrLive";
```

`useWidgetApiData(widget, ...)` 함수의 아주 위쪽 (다른 useState 들 위) 에:
```js
const tmKey = snapshotKeyForWidget(widget);
const tm = useTimemachineOrLive(tmKey);
```

이 hook 이 반환하는 객체 구성 부분(보통 함수 끝의 return 또는 `loadData` 갱신 후) 을 찾아 timemachine 활성 시 그 결과로 대체:
```js
if (tm.timemachineActive) {
    return {
        data: tm.data,
        loading: tm.loading,
        error: tm.error,
        lastUpdated: tm.tsMs ? new Date(tm.tsMs).toISOString() : null,
        // 호출자(StatusListCard 등) 가 사용하는 다른 필드는 timemachine 모드에선
        // 의미 없으므로 기본값 또는 null 유지.
        refresh: () => {},
    };
}
```

- [ ] **Step 2: Verify hook still compiles + live mode unaffected**

브라우저 콘솔 / Vite 출력에서 errors 없는지 확인. 라이브 모드(토글 OFF) 에서 모든 위젯이 정상 동작하는지 수동 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/hooks/useWidgetApiData.js
git commit -m "feat(fe): useWidgetApiData 의 timemachine 분기 — snapshot 데이터 반환"
```

## Task 1.5: ServerResourceCard / NetworkTestCard 의 timemachine 분기

**Files:** Modify `monigrid-fe/src/components/ServerResourceCard.jsx`, `NetworkTestCard.jsx`

- [ ] **Step 1: ServerResourceCard 에 분기 추가**

[ServerResourceCard.jsx:234](../../../monigrid-fe/src/components/ServerResourceCard.jsx#L234) 부근의 fetchSnapshot 로직 앞에:

```jsx
import { useTimemachineOrLive } from "../hooks/useTimemachineOrLive";
import { snapshotKeyForWidget } from "../utils/snapshotKey";
```

컴포넌트 함수 안:
```jsx
const tm = useTimemachineOrLive(snapshotKeyForWidget(widget));
```

기존 useEffect 로 polling 하는 부분의 가장 위에:
```jsx
useEffect(() => {
    if (tm.timemachineActive) {
        // payload 가 monitor:server_resource 의 BE collector 결과
        // (e.g., {ok, cpuPercent, memPercent, diskPercent, ...}) 와 동일한 shape 라고 가정.
        setSnapshot(tm.data);
        setLastError(tm.error);
        setLoading(false);
        return;  // live polling 스킵
    }
    // 기존 polling 로직 ...
}, [tm.timemachineActive, tm.data, tm.error, tm.loading, /* 기존 deps */]);
```

- [ ] **Step 2: NetworkTestCard 동일 패턴**

[NetworkTestCard.jsx:280](../../../monigrid-fe/src/components/NetworkTestCard.jsx#L280) 부근에 동일 패턴 적용.

- [ ] **Step 3: 수동 동작 검증 (라이브 모드)**

토글 OFF 상태에서 두 위젯이 평소대로 polling 하는지 확인.

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/components/ServerResourceCard.jsx monigrid-fe/src/components/NetworkTestCard.jsx
git commit -m "feat(fe): server/network card timemachine 분기 — snapshot 사용"
```

## Task 1.6: TimemachineBanner 컴포넌트

**Files:** Create `monigrid-fe/src/components/TimemachineBanner.jsx` + `.css`

- [ ] **Step 1: JSX**

```jsx
import { useTimemachine } from "../contexts/TimemachineContext";
import "./TimemachineBanner.css";

const formatLocal = (ms) => {
    if (ms == null) return "—";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export default function TimemachineBanner() {
    const tm = useTimemachine();
    if (!tm.enabled) return null;
    return (
        <div className="tm-banner" role="status" aria-live="polite">
            <span className="tm-banner-icon" aria-hidden>⏪</span>
            <span className="tm-banner-label">TIMEMACHINE MODE</span>
            <span className="tm-banner-sep">·</span>
            <span className="tm-banner-ts">{formatLocal(tm.atMs)}</span>
            {tm.loading && <span className="tm-banner-loading">조회 중…</span>}
            {tm.error && <span className="tm-banner-error">{tm.error}</span>}
            <button
                type="button"
                className="tm-banner-live-btn"
                onClick={tm.disable}
                title="LIVE 모드로 복귀"
            >
                LIVE 로 복귀
            </button>
        </div>
    );
}
```

- [ ] **Step 2: CSS**

```css
.tm-banner {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    background: rgba(168, 85, 247, 0.12);
    border-bottom: 1px solid rgba(168, 85, 247, 0.4);
    color: #c4b5fd;
    font-size: 12px;
}
.tm-banner-icon { font-size: 14px; }
.tm-banner-label { font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.tm-banner-sep { color: rgba(196, 181, 253, 0.5); }
.tm-banner-ts { font-variant-numeric: tabular-nums; color: #e9d5ff; }
.tm-banner-loading { color: rgba(196, 181, 253, 0.7); font-style: italic; }
.tm-banner-error { color: #fca5a5; margin-left: auto; }
.tm-banner-live-btn {
    margin-left: auto;
    padding: 3px 10px;
    background: rgba(168, 85, 247, 0.18);
    border: 1px solid rgba(168, 85, 247, 0.5);
    color: #ddd6fe;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
}
.tm-banner-live-btn:hover {
    background: rgba(168, 85, 247, 0.28);
    color: #fff;
}
.tm-banner-error + .tm-banner-live-btn {
    margin-left: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/TimemachineBanner.jsx monigrid-fe/src/components/TimemachineBanner.css
git commit -m "feat(fe): TimemachineBanner — 상단 모드 표시 banner"
```

## Task 1.7: TimemachineControlBar 컴포넌트 (Phase 1 버전)

**Files:** Create `monigrid-fe/src/components/TimemachineControlBar.jsx` + `.css`

- [ ] **Step 1: JSX (Phase 1 — playback 컨트롤 제외)**

```jsx
import { useEffect, useState } from "react";
import { useTimemachine } from "../contexts/TimemachineContext";
import "./TimemachineControlBar.css";

const dateToInput = (ms) => {
    if (ms == null) return "";
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const inputToMs = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
};

export default function TimemachineControlBar() {
    const tm = useTimemachine();
    const [localInput, setLocalInput] = useState(() => dateToInput(tm.atMs));

    useEffect(() => {
        setLocalInput(dateToInput(tm.atMs));
    }, [tm.atMs]);

    if (!tm.enabled) return null;

    const earliest = tm.earliestMs ?? Date.now() - 24 * 3600_000;
    const latest = tm.latestMs ?? Date.now();
    const safeAt = tm.atMs ?? latest;

    const step = (deltaMs) => {
        let next = (tm.atMs ?? latest) + deltaMs;
        if (next < earliest) next = earliest;
        if (next > latest) next = latest;
        tm.setAtMs(next);
    };

    const onScrubber = (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) tm.setAtMs(v);
    };

    const onInputCommit = () => {
        const ms = inputToMs(localInput);
        if (ms != null) tm.setAtMs(ms);
    };

    return (
        <div className="tm-controlbar">
            <div className="tm-cb-left">
                <label className="tm-cb-label">시점</label>
                <input
                    type="datetime-local"
                    value={localInput}
                    onChange={(e) => setLocalInput(e.target.value)}
                    onBlur={onInputCommit}
                    onKeyDown={(e) => e.key === "Enter" && onInputCommit()}
                    className="tm-cb-datetime"
                />
            </div>
            <div className="tm-cb-center">
                <input
                    type="range"
                    className="tm-cb-scrubber"
                    min={earliest}
                    max={latest}
                    step={1000}
                    value={safeAt}
                    onChange={onScrubber}
                />
            </div>
            <div className="tm-cb-right">
                <button type="button" className="tm-cb-step" onClick={() => step(-3600_000)} title="-1h">-1h</button>
                <button type="button" className="tm-cb-step" onClick={() => step(-900_000)} title="-15m">-15m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(-300_000)} title="-5m">-5m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(300_000)} title="+5m">+5m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(900_000)} title="+15m">+15m</button>
                <button type="button" className="tm-cb-step" onClick={() => step(3600_000)} title="+1h">+1h</button>
                <button
                    type="button"
                    className="tm-cb-live"
                    onClick={tm.disable}
                    title="LIVE 모드로 복귀"
                >LIVE</button>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: CSS**

```css
.tm-controlbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    background: var(--bg-elevated, #1a2332);
    border-top: 1px solid rgba(168, 85, 247, 0.35);
    box-shadow: 0 -8px 20px rgba(0, 0, 0, 0.35);
    color: var(--text-primary, #e2e8f0);
}
.tm-cb-left, .tm-cb-center, .tm-cb-right {
    display: flex;
    align-items: center;
    gap: 8px;
}
.tm-cb-label {
    font-size: 11px;
    color: var(--text-tertiary, #64748b);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
}
.tm-cb-datetime {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: var(--text-primary, #e2e8f0);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
}
.tm-cb-scrubber {
    width: 100%;
    accent-color: #a855f7;
}
.tm-cb-step {
    padding: 4px 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: var(--text-secondary, #94a3b8);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
}
.tm-cb-step:hover {
    background: rgba(168, 85, 247, 0.12);
    border-color: rgba(168, 85, 247, 0.35);
    color: #ddd6fe;
}
.tm-cb-live {
    margin-left: 8px;
    padding: 4px 12px;
    background: rgba(168, 85, 247, 0.18);
    border: 1px solid rgba(168, 85, 247, 0.5);
    color: #ddd6fe;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
}
.tm-cb-live:hover {
    background: rgba(168, 85, 247, 0.28);
    color: #fff;
}
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/TimemachineControlBar.jsx monigrid-fe/src/components/TimemachineControlBar.css
git commit -m "feat(fe): TimemachineControlBar (Phase 1 — 스크러버+점프+LIVE)"
```

## Task 1.8: DashboardPage 에 Provider + Banner + Bar 결합

**Files:** Modify `monigrid-fe/src/pages/DashboardPage.jsx`

- [ ] **Step 1: Imports + wrap**

DashboardPage 의 default export 를 `<TimemachineProvider>` 로 wrap. 가장 단순한 방법: 컴포넌트 내부 최상위에 `<TimemachineProvider>` JSX 삽입. 또는 별도 wrapper 컴포넌트.

```jsx
import { TimemachineProvider, useTimemachine } from "../contexts/TimemachineContext";
import TimemachineBanner from "../components/TimemachineBanner";
import TimemachineControlBar from "../components/TimemachineControlBar";
```

기존 DashboardPage 함수 export 가 `function DashboardPage() { ... }` 형태라면, 본문을 `function DashboardPageInner()` 로 rename 하고 새로 default export 를:

```jsx
export default function DashboardPage() {
    return (
        <TimemachineProvider>
            <DashboardPageInner />
        </TimemachineProvider>
    );
}
```

- [ ] **Step 2: Inner 컴포넌트에서 banner / control bar 렌더**

`DashboardPageInner()` 의 최상위 JSX 안 (header 바로 아래, main 위) 에:
```jsx
<TimemachineBanner />
{/* ... 기존 main 컨텐츠 ... */}
<TimemachineControlBar />
```

- [ ] **Step 3: 본문 padding 보정**

control bar 가 viewport 하단에 sticky 로 떠 있으므로, dashboard main 의 하단 여백을 60px 정도 늘려서 마지막 위젯이 가려지지 않게.
대시보드 main 컨테이너에 conditional class:
```jsx
const tm = useTimemachine();
<main className={`dashboard-main${tm.enabled ? " dashboard-main-tm" : ""}`}>
```
DashboardPage.css 에:
```css
.dashboard-main-tm { padding-bottom: 80px; }
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/pages/DashboardPage.jsx monigrid-fe/src/pages/DashboardPage.css
git commit -m "feat(fe): DashboardPage 에 TimemachineProvider + Banner + ControlBar 결합"
```

## Task 1.9: DashboardHeader 의 타임머신 토글 버튼

**Files:** Modify `monigrid-fe/src/pages/DashboardHeader.jsx`

- [ ] **Step 1: prop 변경**

DashboardHeader 의 props 에서 `onOpenTimemachine` (또는 동일 역할) 을 `onToggleTimemachine` + `timemachineActive: boolean` 으로 변경. DashboardPage 에서 `useTimemachine()` 결과를 prop 으로 내려줌.

기존 button 의 onClick 을 `onToggleTimemachine` 으로, className 에 active 분기 추가:
```jsx
<button
    className={`toolbar-btn toolbar-btn-secondary toolbar-btn-tm${timemachineActive ? " active" : ""}`}
    onClick={onToggleTimemachine}
    title={timemachineActive ? "타임머신 모드 종료" : "타임머신 모드"}
    aria-label={timemachineActive ? "타임머신 모드 종료" : "타임머신 모드"}
    aria-pressed={timemachineActive ? "true" : "false"}
>
    <IconArrowLeft size={16} />
</button>
```

- [ ] **Step 2: CSS — active 톤**

DashboardPage.css (또는 toolbar 관련 css) 에:
```css
.toolbar-btn-tm.active {
    background: rgba(168, 85, 247, 0.18);
    border-color: rgba(168, 85, 247, 0.5);
    color: #c4b5fd;
}
.toolbar-btn-tm.active:hover {
    background: rgba(168, 85, 247, 0.28);
}
```

- [ ] **Step 3: DashboardPageInner 에서 prop 연결**

```jsx
const tm = useTimemachine();
const handleToggleTm = () => {
    if (tm.enabled) tm.disable();
    else tm.enable();
};
// ...
<DashboardHeader
    timemachineActive={tm.enabled}
    onToggleTimemachine={handleToggleTm}
    /* ... 기존 props */
/>
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/pages/DashboardHeader.jsx monigrid-fe/src/pages/DashboardPage.jsx monigrid-fe/src/pages/DashboardPage.css
git commit -m "feat(fe): DashboardHeader 의 타임머신 버튼을 토글로 재정의"
```

## Task 1.10: read-only 강제 (위젯 추가 / 설정 / drag 비활성)

**Files:** Modify `monigrid-fe/src/pages/DashboardPage.jsx`, header / 위젯 cards 의 가드

- [ ] **Step 1: 헤더 controls-row 의 위젯 추가/설정/관리 버튼 disabled**

DashboardPageInner 에서:
```jsx
<DashboardHeader
    timemachineActive={tm.enabled}
    addWidgetDisabled={tm.enabled}
    settingsDisabled={tm.enabled}
    backendConfigDisabled={tm.enabled}
    userMgmtDisabled={tm.enabled}
    /* ... */
/>
```

DashboardHeader 의 해당 버튼들에 `disabled={...Disabled}` + `title` 에 "타임머신 모드에서는 사용 불가" 추가.

- [ ] **Step 2: 위젯 drag 핸들 비활성**

DashboardPage 가 react-grid-layout 을 사용 중이라면 (확인 필요), `<GridLayout isDraggable={!tm.enabled} isResizable={!tm.enabled}>`.

- [ ] **Step 3: 위젯 ⚙ 설정 / 🗑 삭제 버튼**

각 widget 카드의 toolbar 에서 timemachine 활성 시 disable. 핵심 카드 4종(ApiCard, ServerResourceCard, NetworkTestCard, StatusListCard, LineChartCard, BarChartCard, HealthCheckCard) 의 카드 헤더 액션 버튼에 `useTimemachineEnabled()` hook 으로 disabled 분기.

```jsx
import { useTimemachineEnabled } from "../contexts/TimemachineContext";
const tmActive = useTimemachineEnabled();
// ...
<button disabled={tmActive} title={tmActive ? "타임머신 모드에서는 편집 불가" : "..."}>
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/pages/DashboardPage.jsx monigrid-fe/src/pages/DashboardHeader.jsx monigrid-fe/src/components/ApiCard.jsx monigrid-fe/src/components/ServerResourceCard.jsx monigrid-fe/src/components/NetworkTestCard.jsx monigrid-fe/src/components/StatusListCard.jsx monigrid-fe/src/components/LineChartCard.jsx monigrid-fe/src/components/BarChartCard.jsx monigrid-fe/src/components/HealthCheckCard.jsx
git commit -m "feat(fe): timemachine 모드에서 편집 액션 read-only 강제"
```

## Task 1.11: Phase 1 E2E 검증

- [ ] **Step 1: BE/FE 가동 상태 확인**

```bash
curl -sS -o /dev/null -w "BE: %{http_code}\nFE: " http://127.0.0.1:5000/health
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

둘 다 200.

- [ ] **Step 2: 브라우저 시나리오**

http://localhost:3000 → 로그인 (admin/admin) → 헤더의 타임머신 토글 → 라벤더 banner + 하단 control bar 등장 → datetime 입력 또는 스크러버 끌기 → 위젯들이 그 시점 데이터로 다시 그려짐 → "LIVE" 버튼 → 라이브로 복귀.

확인 항목:
- 라이브 모드 → 토글 켜기 → 5분 전 시점 데이터 자동 fetch
- 위젯 카드 ⚙/🗑 버튼 disabled
- 헤더의 위젯 추가 / 설정 등 disabled
- 스크러버 빠르게 끌어도 디바운스로 호출 1회만 발생 (Network 탭 확인)
- 토글 끄면 banner 사라지고 위젯들이 다시 라이브 polling

---

# Phase 2 — Playback

## Task 2.1: BE `GET /dashboard/timemachine/window` endpoint

**Files:** Modify `monigrid-be/app/routes/timemachine_routes.py`

- [ ] **Step 1: 핸들러 추가**

기존 `register(app, backend, limiter)` 함수 안의 마지막 route 뒤에:

```python
@app.route("/dashboard/timemachine/window", methods=["GET"])
@require_auth
def timemachine_window():
    store = backend.get_timemachine_store()
    if store is None:
        return jsonify({"message": "timemachine disabled"}), 503

    from_ms = _parse_at_ms(request.args.get("from"))
    to_ms = _parse_at_ms(request.args.get("to"))
    if from_ms is None or to_ms is None:
        return jsonify({"message": "from/to (ISO-8601 or epoch ms) required"}), 400
    if from_ms > to_ms:
        return jsonify({"message": "from must be <= to"}), 400

    try:
        step_ms = int(request.args.get("stepMs", "30000"))
    except (TypeError, ValueError):
        return jsonify({"message": "stepMs must be int (ms)"}), 400
    if step_ms < 1000:
        return jsonify({"message": "stepMs must be >= 1000"}), 400

    frame_count = (to_ms - from_ms) // step_ms + 1
    if frame_count > 200:
        return jsonify({
            "message": f"too many frames ({frame_count}); reduce window or increase stepMs (max 200 per call)",
        }), 400

    items = []
    cursor = from_ms
    try:
        while cursor <= to_ms:
            snapshot = store.list_samples_at(at_ms=cursor)
            items.append({"atMs": cursor, "snapshot": snapshot})
            cursor += step_ms
    except Exception:
        backend.logger.exception("timemachine window failed from=%s to=%s step=%s",
                                 from_ms, to_ms, step_ms)
        return jsonify({"message": "window query failed"}), 500

    return jsonify({"items": items, "count": len(items)}), 200
```

- [ ] **Step 2: BE 재기동 후 smoke test**

```bash
pkill -f "python3 monigrid_be.py" 2>/dev/null; sleep 2
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py > /tmp/be.log 2>&1 &
sleep 5
TOKEN=$(curl -sS -X POST -H "Content-Type: application/json" -d '{"username":"admin","password":"admin"}' http://127.0.0.1:5000/auth/login | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
NOW=$(date +%s)000
FROM=$(($NOW - 600000))
curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:5000/dashboard/timemachine/window?from=$FROM&to=$NOW&stepMs=30000" | python3 -m json.tool | head -10
```

기대: `{"items": [...], "count": 21}` 같은 응답.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/routes/timemachine_routes.py
git commit -m "feat(be): GET /dashboard/timemachine/window — 시간 윈도 N프레임 일괄 조회"
```

## Task 2.2: FE timemachineService.queryWindow

**Files:** Modify `monigrid-fe/src/services/dashboardService.js` (또는 services/api.js — timemachineService 가 정의된 파일 확인)

- [ ] **Step 1: queryWindow 추가**

```js
// timemachineService 객체에 추가:
async queryWindow({ from, to, stepMs = 30000 }, options = {}) {
    const response = await apiClient.get("/dashboard/timemachine/window", {
        params: { from, to, stepMs },
        signal: options.signal,
    });
    return response.data;
},
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/services/dashboardService.js
git commit -m "feat(fe): timemachineService.queryWindow"
```

## Task 2.3: timemachinePrefetchBuffer 유틸

**Files:** Create `monigrid-fe/src/utils/timemachinePrefetchBuffer.js`

- [ ] **Step 1: LRU buffer 구현**

```js
import { buildSnapshotMap } from "./snapshotKey";

/**
 * key=atMs (number, frame-aligned), value=snapshotByKey (Map<sourceKey, item>)
 * LRU: 추가 시 max 초과 시 가장 오래된 entry 제거.
 *
 * 사용 패턴:
 *   const buf = createPrefetchBuffer(200);
 *   buf.add(atMs, snapshotMap);
 *   const m = buf.get(atMs);  // Map | undefined
 */
export function createPrefetchBuffer(max = 200) {
    const map = new Map();   // 삽입 순서 == LRU 순서
    return {
        size: () => map.size,
        has: (atMs) => map.has(atMs),
        get: (atMs) => map.get(atMs),
        add: (atMs, snapshotMap) => {
            map.delete(atMs);
            map.set(atMs, snapshotMap);
            while (map.size > max) {
                const first = map.keys().next().value;
                map.delete(first);
            }
        },
        addAll: (windowItems) => {
            // [{atMs, snapshot:[items]}, ...] from BE
            for (const it of windowItems || []) {
                const m = buildSnapshotMap(it.snapshot);
                map.delete(it.atMs);
                map.set(it.atMs, m);
            }
            while (map.size > max) {
                const first = map.keys().next().value;
                map.delete(first);
            }
        },
        clear: () => map.clear(),
        keys: () => Array.from(map.keys()),
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/utils/timemachinePrefetchBuffer.js
git commit -m "feat(fe): timemachinePrefetchBuffer — Phase 2 LRU 버퍼"
```

## Task 2.4: TimemachineContext 에 playback + prefetch 통합

**Files:** Modify `monigrid-fe/src/contexts/TimemachineContext.jsx`

- [ ] **Step 1: playback state + buffer 추가**

기존 state 들 옆에 추가:
```jsx
const [playing, setPlaying] = useState(false);
const [speed, setSpeed] = useState(1);          // 1 / 2 / 5 / 10
const [frameSizeMs, setFrameSizeMs] = useState(30_000); // 30s default
const bufferRef = useRef(createPrefetchBuffer(200));
const playTickRef = useRef(null);
```

import 추가:
```jsx
import { createPrefetchBuffer } from "../utils/timemachinePrefetchBuffer";
```

- [ ] **Step 2: prefetch 로직**

```jsx
const ensurePrefetched = useCallback(async (centerMs) => {
    const buf = bufferRef.current;
    const stepMs = frameSizeMs;
    const ahead = 30 * stepMs;     // 30 frame 앞 prefetch
    const behind = 5 * stepMs;
    const fromMs = Math.max(centerMs - behind, tm?.earliestMs ?? centerMs - 3600_000);
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
}, [frameSizeMs]);
```

(`tm?.earliestMs` 는 stats 에서 가져온 값을 캡처해야 — 위 useState 의 stats 객체 참조)

- [ ] **Step 3: setAtMs 시 buffer hit 우선**

기존 `useEffect(() => fetchAt(atMs), [atMs])` 부분을 변경:
```jsx
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
```

- [ ] **Step 4: playback tick**

```jsx
useEffect(() => {
    if (!enabled || !playing) {
        clearInterval(playTickRef.current);
        return;
    }
    // 1초 tick — atMs 를 frameSizeMs * speed 만큼 전진
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
```

- [ ] **Step 5: disable() 정리**

기존 `disable` 에 `setPlaying(false); bufferRef.current.clear();` 추가.

- [ ] **Step 6: Provider value 확장**

```jsx
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
```

- [ ] **Step 7: Commit**

```bash
git add monigrid-fe/src/contexts/TimemachineContext.jsx
git commit -m "feat(fe): TimemachineContext 에 playback + prefetch 통합 (Phase 2)"
```

## Task 2.5: ControlBar 에 playback 컨트롤 추가

**Files:** Modify `monigrid-fe/src/components/TimemachineControlBar.jsx` + `.css`

- [ ] **Step 1: JSX 확장**

기존 `tm-cb-center` 위 (또는 안) 에 playback 그룹 추가:
```jsx
<div className="tm-cb-playback">
    <button
        type="button"
        className="tm-cb-play"
        onClick={() => tm.setPlaying(!tm.playing)}
        title={tm.playing ? "일시정지 (Space)" : "재생 (Space)"}
        aria-label={tm.playing ? "일시정지" : "재생"}
    >{tm.playing ? "⏸" : "▶"}</button>
    <select
        className="tm-cb-select"
        value={tm.speed}
        onChange={(e) => tm.setSpeed(Number(e.target.value))}
        title="재생 속도"
    >
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={5}>5x</option>
        <option value={10}>10x</option>
    </select>
    <select
        className="tm-cb-select"
        value={tm.frameSizeMs}
        onChange={(e) => tm.setFrameSizeMs(Number(e.target.value))}
        title="프레임 간격 (한 tick 당 진행)"
    >
        <option value={30_000}>30s</option>
        <option value={60_000}>1m</option>
        <option value={300_000}>5m</option>
    </select>
</div>
```

레이아웃: grid-template-columns 를 `auto auto 1fr auto` 로 확장 (datetime / playback / scrubber / steps).

- [ ] **Step 2: CSS 보강**

```css
.tm-cb-playback {
    display: flex;
    align-items: center;
    gap: 6px;
}
.tm-cb-play {
    width: 30px;
    height: 30px;
    background: rgba(168, 85, 247, 0.18);
    border: 1px solid rgba(168, 85, 247, 0.5);
    color: #ddd6fe;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.tm-cb-play:hover {
    background: rgba(168, 85, 247, 0.28);
    color: #fff;
}
.tm-cb-select {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: var(--text-secondary, #94a3b8);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 3: 키보드 단축키**

ControlBar 에 useEffect 추가:
```jsx
useEffect(() => {
    if (!tm.enabled) return;
    const onKey = (e) => {
        if (e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA") return;
        if (e.key === " ") { e.preventDefault(); tm.setPlaying(!tm.playing); }
        else if (e.key === "ArrowLeft") {
            const delta = e.shiftKey ? -5 * tm.frameSizeMs : -tm.frameSizeMs;
            tm.setAtMs((tm.atMs ?? Date.now()) + delta);
        } else if (e.key === "ArrowRight") {
            const delta = e.shiftKey ? 5 * tm.frameSizeMs : tm.frameSizeMs;
            tm.setAtMs((tm.atMs ?? Date.now()) + delta);
        } else if (e.key === "Escape") {
            tm.disable();
        }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
}, [tm.enabled, tm.playing, tm.atMs, tm.frameSizeMs, tm.setPlaying, tm.setAtMs, tm.disable]);
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/components/TimemachineControlBar.jsx monigrid-fe/src/components/TimemachineControlBar.css
git commit -m "feat(fe): ControlBar 에 ▶/⏸ + 속도 + frame size + 키보드 단축키 (Phase 2)"
```

## Task 2.6: Phase 2 E2E 검증

- [ ] **Step 1: 브라우저 시나리오**

타임머신 모드 켜고 ▶ 클릭 → 1초마다 30초씩 전진 (1x). 5x 로 변경 → 1초마다 2.5분 전진. Network 탭에서 `window` endpoint 호출이 prefetch 단위로 (60 프레임 단위) 발생하고 개별 frame 은 buffer hit 으로 호출 없음.

- [ ] **Step 2: 키보드 검증**

Space → 재생/일시정지. ←/→ → 한 frame 이동. Shift+← → 5 frame 이동. Esc → 모드 종료.

- [ ] **Step 3: 자동 LIVE 전환**

스크러버를 latest 근처로 끌고 ▶ → 곧 latest 도달, 자동 일시정지.

---

# Phase 3 — Detail (위젯 종류별)

## Task 3.1: BE `list_samples_range` + `/series` endpoint

**Files:** Modify `monigrid-be/app/timemachine_store.py`, `monigrid-be/app/routes/timemachine_routes.py`

- [ ] **Step 1: store 메서드**

`timemachine_store.py` 의 `list_samples_at` 다음에:
```python
def list_samples_range(
    self, *, source_type: str, source_id: str,
    from_ms: int, to_ms: int, limit: int = 500,
) -> list[dict[str, Any]]:
    if self._conn is None:
        return []
    try:
        with self._lock:
            if self._conn is None:
                return []
            rows = self._conn.execute(
                "SELECT ts_ms, payload FROM timemachine_samples "
                "WHERE source_type = ? AND source_id = ? "
                "AND ts_ms BETWEEN ? AND ? "
                "ORDER BY ts_ms ASC LIMIT ?",
                (source_type, source_id, int(from_ms), int(to_ms), int(limit)),
            ).fetchall()
    except Exception:
        self._logger.exception("timemachine list_samples_range failed")
        return []
    return [{"tsMs": int(r[0]), "payload": _decode_payload(r[1])} for r in rows]
```

- [ ] **Step 2: route handler**

```python
@app.route("/dashboard/timemachine/series", methods=["GET"])
@require_auth
def timemachine_series():
    store = backend.get_timemachine_store()
    if store is None:
        return jsonify({"message": "timemachine disabled"}), 503

    source_type = (request.args.get("sourceType") or "").strip()
    source_id = (request.args.get("sourceId") or "").strip()
    if not source_type or not source_id:
        return jsonify({"message": "sourceType, sourceId required"}), 400

    from_ms = _parse_at_ms(request.args.get("from"))
    to_ms = _parse_at_ms(request.args.get("to"))
    if from_ms is None or to_ms is None:
        return jsonify({"message": "from/to required"}), 400

    try:
        limit = int(request.args.get("limit", "500"))
    except (TypeError, ValueError):
        return jsonify({"message": "limit must be int"}), 400
    limit = max(1, min(limit, 2000))

    try:
        items = store.list_samples_range(
            source_type=source_type, source_id=source_id,
            from_ms=from_ms, to_ms=to_ms, limit=limit,
        )
    except Exception:
        backend.logger.exception("timemachine series failed")
        return jsonify({"message": "series query failed"}), 500

    return jsonify({
        "items": items, "count": len(items),
        "sourceType": source_type, "sourceId": source_id,
    }), 200
```

- [ ] **Step 3: BE 재기동 + smoke test**

```bash
pkill -f "python3 monigrid_be.py" 2>/dev/null; sleep 2
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py > /tmp/be.log 2>&1 &
sleep 5
TOKEN=$(curl -sS -X POST -H "Content-Type: application/json" -d '{"username":"admin","password":"admin"}' http://127.0.0.1:5000/auth/login | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
NOW=$(date +%s)000
FROM=$(($NOW - 3600000))
curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:5000/dashboard/timemachine/series?sourceType=data_api&sourceId=status&from=$FROM&to=$NOW" | python3 -m json.tool | head -10
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/timemachine_store.py monigrid-be/app/routes/timemachine_routes.py
git commit -m "feat(be): list_samples_range + GET /dashboard/timemachine/series (Phase 3)"
```

## Task 3.2: FE timemachineService.queryRange

**Files:** Modify `monigrid-fe/src/services/dashboardService.js`

- [ ] **Step 1: 메서드 추가**

```js
async queryRange({ sourceType, sourceId, from, to, limit = 500 }, options = {}) {
    const response = await apiClient.get("/dashboard/timemachine/series", {
        params: { sourceType, sourceId, from, to, limit },
        signal: options.signal,
    });
    return response.data;
},
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/services/dashboardService.js
git commit -m "feat(fe): timemachineService.queryRange"
```

## Task 3.3: TimemachineDetailModal shell

**Files:** Create `monigrid-fe/src/components/TimemachineDetailModal.jsx` + `.css`

- [ ] **Step 1: shell + lazy body 라우팅**

```jsx
import { useEffect, useState } from "react";
import { IconClose } from "./icons";
import { timemachineService } from "../services/api";
import ServerResourceDetail from "./timemachine-detail/ServerResourceDetail";
import NetworkDetail from "./timemachine-detail/NetworkDetail";
import HttpStatusDetail from "./timemachine-detail/HttpStatusDetail";
import DataApiTableDetail from "./timemachine-detail/DataApiTableDetail";
import DataApiChartDetail from "./timemachine-detail/DataApiChartDetail";
import StatusListDetail from "./timemachine-detail/StatusListDetail";
import "./TimemachineDetailModal.css";

const WINDOW_HOURS = 1;

const renderDetailBody = (widgetType, props) => {
    switch (widgetType) {
        case "server-resource": return <ServerResourceDetail {...props} />;
        case "network-test":    return <NetworkDetail {...props} />;
        case "http-status":     return <HttpStatusDetail {...props} />;
        case "table":           return <DataApiTableDetail {...props} />;
        case "line-chart":
        case "bar-chart":       return <DataApiChartDetail {...props} widgetType={widgetType} />;
        case "status-list":
        case "health-check":    return <StatusListDetail {...props} />;
        default:                return <pre>{JSON.stringify(props.currentPayload, null, 2)}</pre>;
    }
};

export default function TimemachineDetailModal({
    widget, atMs, sourceType, sourceId, currentPayload, onClose,
}) {
    const [series, setSeries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!atMs || !sourceType || !sourceId) return;
        let cancelled = false;
        const ac = new AbortController();
        const halfWin = WINDOW_HOURS * 3600_000 / 2;
        (async () => {
            setLoading(true);
            try {
                const data = await timemachineService.queryRange({
                    sourceType, sourceId,
                    from: atMs - halfWin, to: atMs + halfWin, limit: 500,
                }, { signal: ac.signal });
                if (!cancelled) setSeries(data?.items ?? []);
            } catch (e) {
                if (!cancelled && e?.name !== "CanceledError" && e?.name !== "AbortError") {
                    setError(e?.message || "series 조회 실패");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; ac.abort(); };
    }, [atMs, sourceType, sourceId]);

    const widgetType = widget?.type || "table";
    const title = widget?.title || widget?.name || sourceId;

    return (
        <div className="tdm-overlay" onClick={onClose}>
            <div className="tdm-modal" onClick={(e) => e.stopPropagation()}>
                <header className="tdm-header">
                    <h3>{title}</h3>
                    <button type="button" className="tdm-close" onClick={onClose} aria-label="닫기">
                        <IconClose size={14} />
                    </button>
                </header>
                <div className="tdm-body">
                    {loading && <div className="tdm-loading">조회 중…</div>}
                    {error && <div className="tdm-error">{error}</div>}
                    {!loading && !error && renderDetailBody(widgetType, {
                        widget, atMs, series, currentPayload,
                    })}
                </div>
            </div>
        </div>
    );
}
```

- [ ] **Step 2: CSS**

```css
.tdm-overlay {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
}
.tdm-modal {
    width: min(900px, 92vw); max-height: 88vh;
    background: var(--bg-elevated, #1a2332);
    border: 1px solid rgba(168, 85, 247, 0.3);
    border-radius: 10px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    display: flex; flex-direction: column;
    overflow: hidden;
}
.tdm-header {
    padding: 12px 18px;
    background: rgba(168, 85, 247, 0.06);
    border-bottom: 1px solid rgba(168, 85, 247, 0.25);
    display: flex; justify-content: space-between; align-items: center;
}
.tdm-header h3 {
    margin: 0; font-size: 14px; font-weight: 700;
    color: var(--text-primary, #e2e8f0);
}
.tdm-close {
    width: 28px; height: 28px;
    background: transparent; border: 1px solid transparent;
    color: var(--text-secondary, #94a3b8);
    border-radius: 6px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
}
.tdm-close:hover { background: rgba(255, 255, 255, 0.06); color: var(--text-primary, #e2e8f0); }
.tdm-body { flex: 1; overflow: auto; padding: 14px 18px; }
.tdm-loading, .tdm-error {
    padding: 24px; text-align: center; font-size: 13px;
    color: var(--text-tertiary, #64748b);
}
.tdm-error { color: #fca5a5; }
.tdm-section { margin-bottom: 16px; }
.tdm-section h4 {
    margin: 0 0 6px;
    font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--text-tertiary, #64748b);
}
.tdm-payload-toggle {
    display: block; padding: 6px 10px; cursor: pointer;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 6px;
    font-size: 11px; color: var(--text-secondary, #94a3b8);
}
.tdm-payload pre {
    margin: 6px 0 0; padding: 10px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(148, 163, 184, 0.12);
    border-radius: 6px;
    font-size: 11px; max-height: 280px; overflow: auto;
    color: var(--text-secondary, #94a3b8);
}
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/TimemachineDetailModal.jsx monigrid-fe/src/components/TimemachineDetailModal.css
git commit -m "feat(fe): TimemachineDetailModal shell + per-type body 라우팅"
```

## Task 3.4: ServerResourceDetail

**Files:** Create `monigrid-fe/src/components/timemachine-detail/ServerResourceDetail.jsx`

- [ ] **Step 1: 차트 + recent 테이블**

```jsx
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ServerResourceDetail({ widget, series, currentPayload }) {
    const points = (series || []).map((it) => ({
        ts: it.tsMs,
        cpu: it.payload?.cpuPercent ?? null,
        mem: it.payload?.memPercent ?? null,
        disk: it.payload?.diskPercent ?? null,
    }));
    const criteria = widget?.serverResourceSettings?.criteria || {};
    const recent = (series || []).slice(-5).reverse();

    return (
        <>
            <div className="tdm-section">
                <h4>CPU / Memory / Disk · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis domain={[0, 100]} stroke="#64748b" fontSize={10} unit="%" />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="cpu" stroke="#60a5fa" name="CPU" dot={false} />
                        <Line dataKey="mem" stroke="#a78bfa" name="MEM" dot={false} />
                        <Line dataKey="disk" stroke="#fbbf24" name="DISK" dot={false} />
                        {criteria?.cpu != null && (
                            <ReferenceLine y={criteria.cpu} stroke="#60a5fa" strokeDasharray="4 4" label="CPU 임계" />
                        )}
                        {criteria?.memory != null && (
                            <ReferenceLine y={criteria.memory} stroke="#a78bfa" strokeDasharray="4 4" label="MEM 임계" />
                        )}
                        {criteria?.disk != null && (
                            <ReferenceLine y={criteria.disk} stroke="#fbbf24" strokeDasharray="4 4" label="DISK 임계" />
                        )}
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>최근 5개 sample</h4>
                <table className="tdm-table">
                    <thead>
                        <tr><th>시각</th><th>CPU</th><th>MEM</th><th>DISK</th><th>OK</th></tr>
                    </thead>
                    <tbody>
                        {recent.map((it) => (
                            <tr key={it.tsMs}>
                                <td>{new Date(it.tsMs).toLocaleString()}</td>
                                <td>{it.payload?.cpuPercent?.toFixed(1) ?? "-"}%</td>
                                <td>{it.payload?.memPercent?.toFixed(1) ?? "-"}%</td>
                                <td>{it.payload?.diskPercent?.toFixed(1) ?? "-"}%</td>
                                <td>{it.payload?.ok ? "✓" : "✗"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload (현재 시점)</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}
```

- [ ] **Step 2: tdm-table CSS 추가**

[TimemachineDetailModal.css](../../../monigrid-fe/src/components/TimemachineDetailModal.css) 에:
```css
.tdm-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.tdm-table th, .tdm-table td {
    padding: 5px 8px; text-align: left;
    border-bottom: 1px solid rgba(148, 163, 184, 0.08);
}
.tdm-table th {
    color: var(--text-tertiary, #64748b);
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px;
}
.tdm-table td { color: var(--text-secondary, #94a3b8); font-variant-numeric: tabular-nums; }
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/timemachine-detail/ServerResourceDetail.jsx monigrid-fe/src/components/TimemachineDetailModal.css
git commit -m "feat(fe): ServerResourceDetail — 1h CPU/MEM/DISK timeseries + criteria 임계선"
```

## Task 3.5: NetworkDetail

**Files:** Create `monigrid-fe/src/components/timemachine-detail/NetworkDetail.jsx`

- [ ] **Step 1: ping RTT 시계열**

```jsx
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function NetworkDetail({ series, currentPayload }) {
    const points = (series || []).map((it) => ({
        ts: it.tsMs,
        rtt: it.payload?.rttMs ?? null,
        ok: it.payload?.ok === true,
    }));
    const recent = (series || []).slice(-10).reverse();

    return (
        <>
            <div className="tdm-section">
                <h4>응답 시간 (ms) · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} unit="ms" />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="rtt" stroke="#22d3ee" name="RTT" dot={(p) => (
                            <circle cx={p.cx} cy={p.cy} r={3}
                                fill={p.payload.ok ? "#22d3ee" : "#ef4444"}
                                stroke="none" />
                        )} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>최근 10개 sample</h4>
                <table className="tdm-table">
                    <thead>
                        <tr><th>시각</th><th>OK</th><th>RTT (ms)</th><th>오류</th></tr>
                    </thead>
                    <tbody>
                        {recent.map((it) => (
                            <tr key={it.tsMs}>
                                <td>{new Date(it.tsMs).toLocaleString()}</td>
                                <td style={{ color: it.payload?.ok ? "#86efac" : "#fca5a5" }}>
                                    {it.payload?.ok ? "✓" : "✗"}
                                </td>
                                <td>{it.payload?.rttMs ?? "-"}</td>
                                <td>{it.payload?.error || "-"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload (현재 시점)</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/components/timemachine-detail/NetworkDetail.jsx
git commit -m "feat(fe): NetworkDetail — RTT 시계열 + 실패 dot + recent 테이블"
```

## Task 3.6: HttpStatusDetail

**Files:** Create `monigrid-fe/src/components/timemachine-detail/HttpStatusDetail.jsx`

- [ ] **Step 1: 응답 코드 + 응답 시간 차트**

```jsx
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const codeColor = (code) => {
    if (code == null) return "#64748b";
    if (code < 300) return "#22c55e";
    if (code < 400) return "#60a5fa";
    if (code < 500) return "#fbbf24";
    return "#ef4444";
};

const formatTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function HttpStatusDetail({ series, currentPayload }) {
    const points = (series || []).map((it) => ({
        ts: it.tsMs,
        code: it.payload?.httpStatus ?? null,
        rt: it.payload?.responseTimeMs ?? null,
    }));
    const recent = (series || []).slice(-10).reverse();

    return (
        <>
            <div className="tdm-section">
                <h4>HTTP 상태 코드 · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} domain={[0, 600]} ticks={[200, 300, 400, 500]} />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="code" name="HTTP" stroke="#94a3b8" dot={(p) => (
                            <circle cx={p.cx} cy={p.cy} r={4}
                                fill={codeColor(p.payload.code)} stroke="none" />
                        )} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>응답 시간 (ms)</h4>
                <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} unit="ms" />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="rt" stroke="#22d3ee" name="응답시간" dot={false} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>최근 10개 sample</h4>
                <table className="tdm-table">
                    <thead>
                        <tr><th>시각</th><th>코드</th><th>응답 시간</th><th>본문 일부</th></tr>
                    </thead>
                    <tbody>
                        {recent.map((it) => (
                            <tr key={it.tsMs}>
                                <td>{new Date(it.tsMs).toLocaleString()}</td>
                                <td style={{ color: codeColor(it.payload?.httpStatus) }}>
                                    {it.payload?.httpStatus ?? "-"}
                                </td>
                                <td>{it.payload?.responseTimeMs ?? "-"} ms</td>
                                <td title={it.payload?.body || ""}>
                                    {String(it.payload?.body || "").slice(0, 60)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/components/timemachine-detail/HttpStatusDetail.jsx
git commit -m "feat(fe): HttpStatusDetail — 응답 코드 + 응답 시간 시계열"
```

## Task 3.7: DataApiTableDetail

**Files:** Create `monigrid-fe/src/components/timemachine-detail/DataApiTableDetail.jsx`

- [ ] **Step 1: 그 시점의 row 들 풀 테이블**

```jsx
import { useMemo, useState } from "react";

export default function DataApiTableDetail({ currentPayload }) {
    const [filter, setFilter] = useState("");
    const rows = Array.isArray(currentPayload?.data) ? currentPayload.data
        : Array.isArray(currentPayload) ? currentPayload : [];
    const columns = useMemo(() => {
        const set = new Set();
        for (const r of rows.slice(0, 50)) Object.keys(r || {}).forEach((k) => set.add(k));
        return Array.from(set);
    }, [rows]);
    const filtered = useMemo(() => {
        if (!filter.trim()) return rows;
        const q = filter.toLowerCase();
        return rows.filter((r) =>
            columns.some((c) => String(r?.[c] ?? "").toLowerCase().includes(q)),
        );
    }, [rows, columns, filter]);

    return (
        <>
            <div className="tdm-section">
                <h4>현재 시점의 데이터 ({filtered.length}/{rows.length} row)</h4>
                <input
                    className="tdm-filter"
                    placeholder="검색..."
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <div className="tdm-table-wrap">
                    <table className="tdm-table">
                        <thead>
                            <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
                        </thead>
                        <tbody>
                            {filtered.slice(0, 200).map((r, i) => (
                                <tr key={i}>
                                    {columns.map((c) => (
                                        <td key={c} title={String(r?.[c] ?? "")}>
                                            {String(r?.[c] ?? "")}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {filtered.length > 200 && (
                    <p style={{fontSize: 11, color: "#64748b", marginTop: 6}}>
                        상위 200개만 표시 (필터로 좁혀 보세요)
                    </p>
                )}
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}
```

- [ ] **Step 2: CSS 추가**

```css
.tdm-filter {
    width: 100%; padding: 6px 10px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(148, 163, 184, 0.16);
    color: var(--text-primary, #e2e8f0);
    border-radius: 6px; font-size: 12px;
    margin-bottom: 8px;
}
.tdm-table-wrap { max-height: 380px; overflow: auto; }
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/timemachine-detail/DataApiTableDetail.jsx monigrid-fe/src/components/TimemachineDetailModal.css
git commit -m "feat(fe): DataApiTableDetail — 시점 row 풀 테이블 + 검색"
```

## Task 3.8: DataApiChartDetail (line + bar 공용)

**Files:** Create `monigrid-fe/src/components/timemachine-detail/DataApiChartDetail.jsx`

- [ ] **Step 1: 시계열 풀 윈도 차트**

데이터 API 차트 위젯의 payload 는 보통 `{data: [{x, y, ...}, ...]}` 형식이라고 가정 (실제 shape 는 LineChartCard / BarChartCard 의 props 처리 코드 참조해 정확히 맞춰야 함).

```jsx
import { useMemo } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function DataApiChartDetail({ widgetType, widget, currentPayload, series }) {
    // 우선 currentPayload 의 chart 데이터를 그대로 보여줌. 보다 풍부한 윈도가
    // 필요하면 series 를 풀어서 보여줄 수도 있으나, 데이터 API payload 의
    // 실제 shape 가 위젯마다 달라 통일된 처리는 어렵다.
    const data = Array.isArray(currentPayload?.data) ? currentPayload.data
        : Array.isArray(currentPayload) ? currentPayload : [];
    const xKey = widget?.lineChartSettings?.xColumn || widget?.barChartSettings?.xColumn || "x";
    const yKey = widget?.lineChartSettings?.yColumn || widget?.barChartSettings?.yColumn || "y";
    const ChartCmp = widgetType === "bar-chart" ? BarChart : LineChart;
    const SeriesCmp = widgetType === "bar-chart" ? Bar : Line;

    return (
        <>
            <div className="tdm-section">
                <h4>현재 시점의 차트 데이터</h4>
                <ResponsiveContainer width="100%" height={260}>
                    <ChartCmp data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey={xKey} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} />
                        <Tooltip contentStyle={{ background: "#1a2332", border: "1px solid #334155" }} />
                        <SeriesCmp dataKey={yKey} fill="#60a5fa" stroke="#60a5fa" />
                    </ChartCmp>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>1시간 내 sample 카운트: {(series || []).length}건</h4>
                <p style={{fontSize: 11, color: "#64748b"}}>
                    각 sample 시각에서의 row count: {(series || []).map((s) => Array.isArray(s.payload?.data) ? s.payload.data.length : 0).join(" / ")}
                </p>
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/components/timemachine-detail/DataApiChartDetail.jsx
git commit -m "feat(fe): DataApiChartDetail — 차트 + 1시간 sample 카운트 (line/bar 공용)"
```

## Task 3.9: StatusListDetail (status-list + health-check 공용)

**Files:** Create `monigrid-fe/src/components/timemachine-detail/StatusListDetail.jsx`

- [ ] **Step 1: OK/FAIL count 시계열 + 실패 항목 리스트**

```jsx
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

const formatTs = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function StatusListDetail({ series, currentPayload }) {
    const points = (series || []).map((it) => ({
        ts: it.tsMs,
        ok: it.payload?.okCount ?? 0,
        fail: it.payload?.failCount ?? 0,
    }));
    const failedNow = Array.isArray(currentPayload?.items)
        ? currentPayload.items.filter((i) => !i.ok)
        : [];

    return (
        <>
            <div className="tdm-section">
                <h4>OK / FAIL 카운트 · 최근 1시간</h4>
                <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={points}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.12)" />
                        <XAxis dataKey="ts" tickFormatter={formatTs} stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} />
                        <Tooltip
                            labelFormatter={(ms) => new Date(ms).toLocaleString()}
                            contentStyle={{ background: "#1a2332", border: "1px solid #334155" }}
                        />
                        <Line dataKey="ok" stroke="#22c55e" name="OK" dot={false} />
                        <Line dataKey="fail" stroke="#ef4444" name="FAIL" dot={false} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <div className="tdm-section">
                <h4>현재 실패 항목 ({failedNow.length}개)</h4>
                {failedNow.length === 0 ? (
                    <p style={{fontSize: 11, color: "#86efac"}}>현재 시점에 실패 항목 없음</p>
                ) : (
                    <table className="tdm-table">
                        <thead>
                            <tr><th>라벨</th><th>URL</th><th>오류</th></tr>
                        </thead>
                        <tbody>
                            {failedNow.slice(0, 20).map((it, i) => (
                                <tr key={i}>
                                    <td>{it.label || it.id}</td>
                                    <td title={it.url}>{String(it.url || "").slice(0, 40)}</td>
                                    <td>{it.error || "-"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            <div className="tdm-section tdm-payload">
                <details>
                    <summary className="tdm-payload-toggle">Raw payload</summary>
                    <pre>{JSON.stringify(currentPayload, null, 2)}</pre>
                </details>
            </div>
        </>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add monigrid-fe/src/components/timemachine-detail/StatusListDetail.jsx
git commit -m "feat(fe): StatusListDetail — OK/FAIL 카운트 + 실패 항목"
```

## Task 3.10: 위젯 카드들에 onDoubleClick 연결

**Files:** Modify `ApiCard.jsx`, `LineChartCard.jsx`, `BarChartCard.jsx`, `ServerResourceCard.jsx`, `NetworkTestCard.jsx`, `StatusListCard.jsx`, `HealthCheckCard.jsx`

- [ ] **Step 1: DashboardPage 가 detail modal state 보관**

DashboardPageInner 에:
```jsx
const [detailWidget, setDetailWidget] = useState(null);
const tm = useTimemachine();

const openDetail = (widget) => {
    if (!tm.enabled) return;
    setDetailWidget(widget);
};
const closeDetail = () => setDetailWidget(null);

// ...JSX 끝부분에
{detailWidget && (
    <TimemachineDetailModal
        widget={detailWidget}
        atMs={tm.atMs}
        sourceType={resolveSnapshotKey(detailWidget)?.split("|")[0]}
        sourceId={resolveSnapshotKey(detailWidget)?.split("|")[1]}
        currentPayload={tm.snapshotByKey.get(resolveSnapshotKey(detailWidget))?.payload}
        onClose={closeDetail}
    />
)}
```

`resolveSnapshotKey` 는 `snapshotKeyForWidget` 의 alias.

- [ ] **Step 2: 각 위젯 카드에 onDoubleClick prop 추가**

각 card 의 가장 바깥 `<article>` 또는 `<div>` 컨테이너에:
```jsx
onDoubleClick={tmActive ? () => onOpenDetail?.(widget) : undefined}
```

`onOpenDetail` 는 DashboardPageInner 에서 internal `(w) => openDetail(w)` 로 내려보냄. 모든 위젯 렌더 호출자에 prop 추가.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/pages/DashboardPage.jsx monigrid-fe/src/components/ApiCard.jsx monigrid-fe/src/components/LineChartCard.jsx monigrid-fe/src/components/BarChartCard.jsx monigrid-fe/src/components/ServerResourceCard.jsx monigrid-fe/src/components/NetworkTestCard.jsx monigrid-fe/src/components/StatusListCard.jsx monigrid-fe/src/components/HealthCheckCard.jsx
git commit -m "feat(fe): 위젯 카드 더블클릭 → TimemachineDetailModal (Phase 3)"
```

## Task 3.11: Phase 3 E2E 검증

- [ ] **Step 1: 시나리오**

타임머신 모드 ON → 임의 시점 → ServerResourceCard 더블클릭 → CPU/MEM/DISK 1시간 시계열 + criteria 임계선 + 최근 5 sample 표 → 닫기

각 위젯 type (server/network/http_status/data_api 차트/data_api 테이블/status-list/health-check) 마다 더블클릭 → 적절한 detail body 가 뜨는지 확인.

- [ ] **Step 2: 라이브 모드에서는 더블클릭 무시 검증**

타임머신 OFF 상태에서 위젯 더블클릭 → 모달 안 열림.

---

# Phase 4 — Cleanup

## Task 4.1: `/timemachine` 페이지 + 라우트 제거

**Files:** Delete `monigrid-fe/src/pages/TimemachinePage.jsx`, `monigrid-fe/src/pages/TimemachinePage.css`. Modify router.

- [ ] **Step 1: import 호출자 grep**

```bash
grep -rEn "TimemachinePage|/timemachine" monigrid-fe/src --include="*.jsx" --include="*.js" 2>/dev/null
```

`/timemachine` 라우트가 등록된 파일(보통 App.jsx 또는 routes.jsx) 찾기.

- [ ] **Step 2: 파일 제거 + 라우트 제거 + import 정리**

```bash
git rm monigrid-fe/src/pages/TimemachinePage.jsx monigrid-fe/src/pages/TimemachinePage.css
```

App.jsx 의 `<Route path="/timemachine" element={<TimemachinePage />} />` 와 그 import 라인 삭제.

다른 곳에서 `/timemachine` 으로 navigate 하던 코드가 있다면 (예: 기존 DashboardHeader 의 onOpenTimemachine prop 호출자) 모두 제거. Phase 1.9 에서 이미 토글로 바꿨지만 잔여 references 확인.

- [ ] **Step 3: 동작 검증**

```bash
curl -sS -o /dev/null -w "FE: %{http_code}\n" http://localhost:3000/
curl -sS -o /dev/null -w "/timemachine: %{http_code}\n" http://localhost:3000/timemachine
```

`/timemachine` 은 404 또는 dashboard 리다이렉트가 되어야 함 (라우터 fallback 동작에 따라).

- [ ] **Step 4: Commit**

```bash
git add -u monigrid-fe/src
git commit -m "feat(fe): /timemachine 페이지 + 라우트 제거 (Phase 4)"
```

---

# Self-Review

## Spec coverage
- ✅ Phase 1 모드 토글 / 컨트롤 바 / 위젯 스냅샷 주입 (Task 1.1–1.11)
- ✅ Phase 2 ▶/⏸ + 속도 + frame size + prefetch + BE window endpoint (Task 2.1–2.6)
- ✅ Phase 3 위젯 종류별 detail modal (6종) + BE series endpoint (Task 3.1–3.11)
- ✅ Phase 4 기존 페이지 제거 (Task 4.1)
- ✅ 라벤더 톤 (banner/active/border)
- ✅ read-only 강제 (Task 1.10)
- ✅ 키보드 단축키 (Task 2.5 Step 3)
- ✅ 자동 LIVE 전환 (Task 2.4 Step 4)

## Placeholder scan
- "정확한 shape 는 …" 같은 잠정 표현은 widget data API payload 의 다양성 때문 — 구현 시 실제 shape 확인하라고 명시했고, 차트 데이터 fallback 패턴 제공
- snapshotKey 매핑의 sourceType 정확값은 BE collector 코드 확인 필요 — Task 1.1 의 helper 가 추측 기반, 첫 통합 시 수정될 수 있음 (E2E Task 1.11 에서 실측 확인)

## Type consistency
- `tm.atMs` (number, epoch ms) — 모든 task 에서 동일
- `snapshotByKey: Map<string, {tsMs, payload}>` — 동일
- `series: Array<{tsMs, payload}>` — Phase 3 모든 detail body 가 같은 shape 사용

## Risks
- 데이터 API 차트의 payload shape 가 위젯마다 달라 DataApiChartDetail 이 일반화되지 않을 수 있음 — 필요 시 widget type 별로 더 분기
- read-only 강제가 모든 곳에 빠짐없이 적용되었는지는 manual audit 필요 — Phase 1 E2E 의 체크리스트에 명시

---

# Execution Plan

각 phase 는 독립 mergeable. 큰 단위 흐름:

1. **Phase 1** subagent dispatch — 11 tasks, 약 25 commit, BE 변경 없음
2. **Phase 1 E2E** 검증 후 Phase 2 시작
3. **Phase 2** — BE endpoint 1 + FE 통합, 6 tasks
4. **Phase 2 E2E**
5. **Phase 3** — BE endpoint 1 + 6 detail components + integration, 11 tasks
6. **Phase 3 E2E**
7. **Phase 4** cleanup — 1 task

총 ~30 tasks. subagent-driven-development 로 자동 진행.

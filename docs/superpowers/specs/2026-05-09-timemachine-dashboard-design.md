# 타임머신 대시보드 모드 — 설계서

- **작성일**: 2026-05-09
- **상태**: Draft → 자동 진행 승인됨 (사용자 명시적 위임)
- **범위**: 메인 대시보드(`/dashboard`)에 타임머신 모드 토글 + 비디오 재생 식 시간 컨트롤 + 위젯 종류별 상세 모달
- **기존 `/timemachine` 페이지**: Phase 4에서 제거

## 배경 / 동기

BE는 이미 collector 가 수집/평가한 모든 source 의 payload 를 `timemachine_samples` SQLite 테이블에 저장 중이며 `/dashboard/timemachine?at=...` 으로 임의 시점의 스냅샷을 반환한다 ([timemachine_routes.py](../../../monigrid-be/app/routes/timemachine_routes.py), [timemachine_store.py](../../../monigrid-be/app/timemachine_store.py)). 별도 페이지 `/timemachine` 이 raw JSON 카드 형태로 노출하고 있지만, 운영자가 "그 시점에 실제 위젯 화면이 어땠나" 를 보려면 시각화가 필요하다.

이번 변경은 메인 대시보드 자체를 시간 축으로 스크럽 가능한 비디오 플레이어 형태로 만들고, 더블클릭으로 위젯별 상세 분석을 제공한다.

## 비목표 (Out of scope)

- BE 측 timemachine 보존 정책 변경 (현 retention KV 그대로)
- 알람 이력 페이지 통합 (별도 페이지로 둠)
- 위젯의 편집/추가 기능을 timemachine 모드에서도 허용 (read-only 강제)
- 다중 사용자 동시 timemachine 세션 동기화

## 사용자 시나리오

1. 운영자가 메인 대시보드에서 알림을 확인하고, "오늘 새벽 03:00 에 무슨 일이 있었나" 보고 싶음
2. 헤더의 타임머신 토글을 켬 → 화면이 "TIMEMACHINE 모드" 로 진입, 하단에 비디오 플레이어 식 컨트롤 바가 등장
3. 스크러버를 새벽 03:00 으로 끌거나 datetime 입력 → 모든 위젯이 그 시점의 데이터로 다시 그려짐
4. ▶ 클릭 → 30초/프레임씩 자동 전진. 5x 속도로 5분/초 전진하며 차트들이 변하는 것을 본다
5. 이상 위젯을 더블클릭 → 그 위젯의 1시간 timeseries + 명령 출력 / 에러 / raw payload 가 모달로 펼쳐짐
6. 끝나면 토글 OFF → 라이브 대시보드로 복귀

## 단계별 분할

| Phase | 범위 | 종료 조건 |
|---|---|---|
| 1 — Foundation | 토글 + 시간 컨트롤(스크러버, 점프 버튼, datetime 입력, "Live" 복귀) + 모드 ON 시 위젯들이 BE 스냅샷의 데이터로 그려짐 | 사용자가 임의 시점으로 끌어 dashboard 상태 확인 가능 |
| 2 — Playback | ▶/⏸ + 속도(1x/2x/5x/10x) + frame size(30s/1m/5m) + prefetch + BE `/dashboard/timemachine/window` 신규 endpoint | 비디오 되감기 동작 |
| 3 — Detail | 더블클릭 → 위젯 종류별 상세 모달 (6 종류) + BE `/dashboard/timemachine/series` 신규 endpoint | 각 위젯에서 시점별 deep-dive 가능 |
| 4 — Cleanup | 기존 `/timemachine` 페이지/라우트/관련 코드 제거 + 네비게이션 정리 | 코드베이스 단일 진입점 |

각 phase 는 독립적 mergeable. Phase 1만으로도 의미 있는 가치 제공.

---

# Phase 1 — Foundation

## 사용자 인터페이스

### 토글 위치

대시보드 헤더 controls-row의 기존 "타임머신" toolbar 버튼([DashboardHeader.jsx](../../../monigrid-fe/src/pages/DashboardHeader.jsx)) 을 **토글 버튼으로 재정의**. 별도 페이지 진입(`navigate("/timemachine")`) 대신 `onToggleTimemachine()` 호출. 버튼 active 상태일 때 강조색(라벤더/보라 톤 — 라이브 ↔ 타임머신 구분).

### 모드 진입 시 화면 변화

1. **상단 banner** — 페이지 헤더 바로 아래에 sticky banner:
   ```
   ⏪ TIMEMACHINE MODE  ·  현재 시점: 2026-05-09 02:55:00  ·  [LIVE 로 복귀]
   ```
   라벤더 톤 배경 (`rgba(168, 85, 247, 0.12)`).
2. **하단 컨트롤 바** — viewport 하단에 sticky. 비디오 플레이어 닮은 레이아웃:
   - 좌측: 시점 datetime 입력 + frame size 셀렉트 (30s/1m/5m)
   - 중앙: 시간 스크러버 (HTML range slider, min=earliest sample ts, max=now). 마우스 드래그 또는 클릭으로 시점 이동
   - 우측: 점프 버튼 ([-1h] [-15m] [-5m] [+5m] [+15m] [+1h]) + "LIVE" 버튼
   - Phase 2에서 ▶/⏸ + 속도 컨트롤이 중앙 좌측에 추가됨
3. **위젯 read-only**:
   - 위젯 추가 / 대시보드 설정 / 백엔드 설정 / 사용자 관리 toolbar 버튼 disabled (옅게)
   - 위젯의 ⚙ 설정 / 🗑 삭제 / drag handle disabled
   - 알림 banner 는 역사적 알람 노출 금지 (live alarm 만 의미 있으므로 hide)
4. **위젯 데이터**:
   - 모든 위젯이 BE 라이브 fetch 대신 timemachine 스냅샷 데이터 사용
   - 데이터가 없는 시점의 위젯은 "데이터 없음" placeholder

## 데이터 흐름

### TimemachineContext

신규 React Context.
```ts
{
    enabled: boolean,             // mode ON/OFF
    atMs: number | null,          // 현재 시점 (epoch ms)
    snapshotByKey: Map<string, {tsMs, payload}>,
                                  // key = `${sourceType}|${sourceId}`
    loading: boolean,
    error: string | null,
    setAtMs: (ms: number) => void,
    enable: (initialMs?: number) => void,
    disable: () => void,           // → live mode
    earliestMs: number | null,     // store 의 minTsMs
}
```

### 위젯 데이터 hook 변경

[useWidgetApiData.js](../../../monigrid-fe/src/hooks/useWidgetApiData.js) 에 timemachine 분기 추가:
```js
const tm = useContext(TimemachineContext);
if (tm.enabled) {
    // 라이브 polling 중단
    const key = resolveSnapshotKey(widget);  // e.g., `data_api|status`
    const snapshot = tm.snapshotByKey.get(key);
    return {
        data: snapshot?.payload ?? null,
        loading: tm.loading,
        error: snapshot ? null : (tm.error || "이 시점에 데이터 없음"),
        // ... (기존 shape 유지)
    };
}
// 기존 라이브 폴링 로직
```

같은 패턴을 다른 데이터 hook 에도 적용:
- `ServerResourceCard` 의 monitor snapshot fetch
- `NetworkTestCard` 동일
- `StatusListCard` 동일
- `HealthCheckCard` 동일

각 카드가 독립적으로 fetch 를 갖고 있으므로 각각에 timemachine 분기 추가. **공통 helper** `useTimemachineOrLive(widget, liveFetcher)` 로 추출.

### snapshotKey 매핑 규칙

BE timemachine 의 (sourceType, sourceId) ↔ FE 위젯의 식별자 매핑:

| 위젯 type | sourceType | sourceId |
|---|---|---|
| 데이터 API (table/line-chart/bar-chart) | `data_api` | api 의 `id` (e.g., `status`, `monigrid_sql_queries`) |
| status-list | `data_api` | (호스트하는 데이터 API id 들의 합성) — N/A 일 수도, 검증 필요 |
| health-check | `data_api` | host endpoint id |
| Server Resource Card | `monitor:server_resource` | target id |
| Network Test Card | `monitor:network` | target id |
| (HTTP 상태 위젯은 status-list 를 통해 표현됨) | `monitor:http_status` | target id |

구현 시 [timemachine_store.py](../../../monigrid-be/app/timemachine_store.py) 의 INSERT 호출자들을 grep 해 정확한 sourceType 값 확인.

## 백엔드 변경 (Phase 1)

이미 존재하는 `/dashboard/timemachine?at=ISO` 엔드포인트만 사용. 신규 BE 작업 없음.

성능 점검: 단일 호출이 모든 source (수십~수백 row) 를 SELECT — 현 store 의 window 쿼리로 충분. 사용자가 스크러버를 빠르게 끌면 호출이 burst — FE에서 디바운스 (250ms) 적용.

## 에러 / 엣지 케이스

| 케이스 | 처리 |
|---|---|
| `atMs` 가 store 의 earliest 이전 | 스크러버 min 으로 clamp |
| 특정 source 가 그 시점에 데이터 없음 | 위젯에 "데이터 없음" 표시, 다른 위젯은 정상 렌더 |
| BE timemachine 비활성화 (503) | 토글 버튼 disabled + 툴팁 "타임머신 저장이 비활성화되어 있습니다" |
| 페이지 unmount 중 fetch 진행 중 | AbortController 로 cancel |
| 라이브 → 타임머신 전환 시 진행중 라이브 polling | 토글 ON 시 모든 widget 의 polling 정리 (기존 unmount 패턴 그대로) |

---

# Phase 2 — Playback

## 사용자 인터페이스

하단 컨트롤 바의 가운데 좌측에 추가:
- ⏮ (earliest 로 점프)
- ▶ / ⏸
- ⏭ (latest = "Live") — 클릭 시 LIVE 모드로 전환
- 속도 셀렉트: 1x / 2x / 5x / 10x
- frame size 셀렉트: 30s / 1m / 5m

재생 중에는 스크러버가 자동 전진. 사용자가 스크러버 / datetime input 을 만지면 일시정지.

## 재생 로직

```
재생 시작
→ playbackTimer = setInterval(() => advance(), 1000) // 1초 tick
advance():
    next = atMs + frameSize × speed
    if next >= now: pause() + LIVE 모드 자동 전환
    setAtMs(next)
```

각 tick 마다 `setAtMs` 가 호출되면 TimemachineContext provider 가 prefetch buffer 에서 해당 시점의 snapshot 을 즉시 꺼내 재렌더 (네트워크 호출 없음).

## Prefetch Buffer

```
buffer: Map<atMs, Snapshot>  // key=atMs, value=snapshotByKey
playWindow: { fromMs, toMs }   // 현재 prefetch 된 범위
```

규칙:
- buffer 가 30 frame 미만 남으면 다음 60 frame chunk 를 fetch
- frame 간격 = `frameSize × speed × 1초당 N frame` (1x = 1 frame/sec, 10x = 10 frame/sec — 단 BE 부담 고려해 fetch 단위는 60 frames at a time 으로 동일)
- 사용자가 스크러버를 점프하면 buffer 무효화 후 새 위치 기준으로 재 prefetch
- buffer 크기 상한 200 frame (메모리 보호)

## 백엔드 신규 엔드포인트

```
GET /dashboard/timemachine/window?from=ISO&to=ISO&stepMs=30000
→ 200 {
    items: [
      { atMs: 1746780000000, snapshot: [{sourceType, sourceId, tsMs, payload}, ...] },
      { atMs: 1746780030000, snapshot: [...] },
      ...
    ],
    count: N
}
```

구현은 `[from..to]` 범위를 `stepMs` 간격으로 순회하며 `list_samples_at(at_ms)` 를 N번 호출. 호출당 cost 가 작아 N=60 까지는 안전.

서버 메모리 보호: `count = ceil((to-from)/stepMs)` 가 200 초과면 400 + 메시지 반환.

## 자동 LIVE 전환

재생이 `now` 에 도달하면:
1. playback 일시정지
2. TimemachineContext.disable() 호출 → live 모드
3. 하단 banner 짧게 토스트 ("Live 시점 도달 — 라이브 모드로 전환")

---

# Phase 3 — Detail (위젯 종류별 상세 모달)

## 위젯 종류별 상세 화면

각 위젯의 `<article>` 컨테이너에 `onDoubleClick={openDetail}` 추가. 모달 컨테이너 `<TimemachineDetailModal>` 가 widget type 에 따라 다른 body 를 렌더.

### 1. server_resource

- 상단: 1시간 윈도(현재 시점 ± 30분) 의 CPU / Memory / Disk percent timeseries 라인 차트 (3 series)
- 임계치(criteria) 가로 점선
- 하단: 가장 최근 5 sample 의 raw stdout/stderr (확장 가능)
- raw payload JSON viewer (collapsible)

### 2. network

- 상단: 1시간 윈도의 ping RTT 또는 telnet 응답 시간 timeseries
- 실패 sample 은 빨간 dot
- 하단: 마지막 N (N=10) sample 의 raw status + error message 테이블
- raw payload JSON

### 3. http_status

- 상단: 응답 코드 timeseries (color-coded: 2xx green, 3xx blue, 4xx orange, 5xx red)
- 응답 시간 timeseries (별도 line)
- 하단: 최근 N sample 의 status + responseTimeMs + body excerpt 테이블
- raw payload JSON

### 4. data_api line-chart / bar-chart

- 상단: 같은 차트지만 1시간 윈도로 확장
- 만약 차트 자체가 이미 시계열이면, 해당 시점에서 차트 윈도(예: 60min) 가 보임
- 하단: 그 시점의 row 들 raw 테이블
- raw payload JSON

### 5. data_api table

- 상단: 그 시점의 모든 row 를 보여주는 큰 테이블 (현재 dashboard 의 작은 테이블에서 잘림 없이)
- 컬럼별 정렬 / 검색
- raw payload JSON

### 6. status-list / health-check

- 상단: 1시간 윈도의 OK/FAIL count timeseries
- 중앙: 그 시점에 실패한 항목들의 url + error 리스트
- raw payload JSON

## 백엔드 신규 엔드포인트

```
GET /dashboard/timemachine/series?sourceType=...&sourceId=...&from=ISO&to=ISO[&limit=500]
→ 200 {
    items: [
      { tsMs, payload },  // 각 sample
      ...
    ],
    sourceType, sourceId, count
}
```

구현은 `timemachine_store` 에 `list_samples_range(source_type, source_id, from_ms, to_ms, limit)` 추가. SELECT * WHERE source_type=? AND source_id=? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC LIMIT ?

## 모달 공통 구조

```
<TimemachineDetailModal>
  <header>
    {widget label} - {widget type 라벨}  ✕
  </header>
  <body>
    <section className="tdm-chart">  {/* per-type 시계열 chart */}
    </section>
    <section className="tdm-recent">  {/* per-type recent 테이블 */}
    </section>
    <section className="tdm-payload">
      <details>
        <summary>Raw payload</summary>
        <pre>{JSON}</pre>
      </details>
    </section>
  </body>
</TimemachineDetailModal>
```

위젯 type 에 따라 body 의 두 section 이 다르게 렌더 (switch/dispatch).

---

# Phase 4 — Cleanup

## 제거 대상

- `monigrid-fe/src/pages/TimemachinePage.jsx`
- `monigrid-fe/src/pages/TimemachinePage.css`
- 라우터 등록 (`<Route path="/timemachine" .../>`) — `App.jsx` 또는 router config
- DashboardHeader 의 기존 "타임머신" toolbar 버튼은 Phase 1에서 토글로 재정의되므로 별도 정리 없음
- TimemachinePage 만 사용하던 helper / asset (있다면)

`TimemachineSettingsTab.jsx` 는 백엔드 설정의 retention 설정 탭이므로 **유지** (별개 기능).

## 네비게이션 / 문서 업데이트

- README / docs 가 `/timemachine` 을 언급한다면 갱신
- 백엔드 설정 탭의 "타임머신" 라벨 그대로 유지 (retention 만 다루므로)

---

# 시각 / 인터랙션 디자인 디테일

## 모드 색상 팔레트

라벤더/보라 톤으로 라이브와 시각 구분:
- banner: `rgba(168, 85, 247, 0.12)` 배경 + `rgba(168, 85, 247, 0.4)` border
- 토글 버튼 active: `rgba(168, 85, 247, 0.18)` + `rgba(168, 85, 247, 0.5)` border + `#c4b5fd` color
- 위젯 컨테이너 옅은 hue: `rgba(168, 85, 247, 0.03)` 배경 (subtle)

## 키보드 단축키 (Phase 2)

- `Space` — ▶ / ⏸ 토글
- `←` / `→` — 한 frame 뒤로 / 앞으로
- `Shift+←` / `Shift+→` — 5 frame 단위 이동
- `Esc` — 타임머신 모드 종료 (live 복귀)

## datetime 입력 형식

`<input type="datetime-local">` 사용 (사용자 로컬 타임존). FE 가 epoch ms 로 변환해 BE 에 전달.

---

# 테스트 전략

## Phase 1
- 단위: TimemachineContext의 enable/disable/setAtMs 시 snapshotByKey 갱신 로직
- 통합: 라이브 BE + FE 띄운 상태에서 토글 ON → datetime 변경 → 위젯이 historical payload 로 다시 그려지는지 (manual)

## Phase 2
- 단위: prefetch buffer 의 LRU eviction, hit/miss 카운트, 점프 시 invalidate
- 통합: BE `/dashboard/timemachine/window` smoke test (count, stepMs 검증)

## Phase 3
- 단위: 각 위젯 type 의 detail modal body 가 series payload 로 정확히 렌더되는지
- 통합: BE `/dashboard/timemachine/series` smoke test

## Phase 4
- 통합: `/timemachine` 라우트 진입 → 404 또는 dashboard 리다이렉트
- 다른 페이지에서 timemachine 관련 import 잔존 grep

---

# 마이그레이션 / 배포 순서

1. Phase 1 PR 머지 → BE 변경 없음, FE 만 — 즉시 배포 가능
2. Phase 2 PR — BE `window` endpoint 추가 후 FE — BE 먼저 배포되어야 prefetch 가능
3. Phase 3 PR — BE `series` endpoint 후 FE — 동일
4. Phase 4 PR — FE 만, 페이지 제거. 운영자 사전 공지 권장

---

# 결정된 것 / 미결정

## 결정

- ✅ A 방식: 메인 대시보드 토글 + 기존 페이지 제거
- ✅ C: 재생/일시정지 + 1x/2x/5x/10x 속도 + prefetch
- ✅ A: 30s/1m/5m 고정 frame 간격
- ✅ C: 위젯 종류별 상세 모달 (6종)
- ✅ 타임머신 모드 색상 = 라벤더/보라
- ✅ 컨트롤 바 위치 = viewport 하단 sticky
- ✅ 모드 색상 + banner + read-only 강제

## 미결정 (구현 단계 결정)

- snapshotKey 매핑의 정확한 sourceType 값 (BE collector 의 INSERT 호출자 확인 후 결정)
- prefetch buffer 의 정확한 디바운스/throttle 시간 (UX 테스트 후 조정)
- 위젯 detail modal 의 차트 라이브러리 — 기존 LineChartCard 의 recharts 재사용

## 위험 / 우려

- BE timemachine_store 의 list_samples_at 쿼리가 source 수가 많을 때 N+1 비슷하게 동작할 수 있음 — 현재 JOIN 으로 한 쿼리이긴 하나 source 수 ~500+ 환경에서 성능 검증 필요. Phase 2의 window endpoint 가 N 회 호출하므로 더 부담 — 측정 후 캐싱 또는 단일 쿼리 최적화 가능성.
- 위젯이 자체 polling timer 를 갖고 있으므로 timemachine 모드에서 모두 멈춰야 함 — useWidgetApiData / 각 카드의 useEffect 정리 누락 시 background fetch 발생 가능. context.enabled 변경 시 cleanup 보장 필요.
- 데이터 API 위젯의 sourceId 가 widget id 가 아닌 api endpoint id 라는 점 주의. mapping 검증 필수.

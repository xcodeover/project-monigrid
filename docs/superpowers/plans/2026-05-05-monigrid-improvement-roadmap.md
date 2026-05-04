# MoniGrid 개선 실행 계획 (2026-05-05)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코드 점검에서 식별된 38건 중 ROI 가 명확한 25건을 5단계에 걸쳐 안전하게 적용한다.

**Architecture:** 보안/활성 버그 → BE 안정화 → FE 부하 감소 → IO/UX 개선 → 선택적 구조 개선. 각 단계 내 작업은 독립적이라 병렬 처리 가능. 단계 간에는 prod 검증 사이클 권장.

**Tech Stack:** Python 3.13 / Flask / JayDeBeApi / paramiko (BE), React 18 / Vite / Zustand / recharts (FE).

**검증 전제:** 정식 테스트 인프라가 없으므로 각 작업은 (1) 변경 (2) 수동 재현/검증 절차 (3) commit 의 3단계로 진행. 가능한 항목은 작은 unit test 를 함께 추가.

**제외된 항목 (총 13건):**
- B7 (풀 borrowed 추적), F12 (zustand normalize) — 큰 리팩토링, 별도 brainstorming 필요
- B12 (dynamic_routes prefix), F19 (DynamicTable key), F20 (auto-open settings) — 현재 영향 미미
- B19 (의존성 버전), B20 (logging cleanup throttle), F5 (historyRef gating), F15 (AudioContext disconnect) — 운영 부담 대비 효과 작음
- 그 외 추정 기반 항목, 실제 사용처 확인 필요한 항목 (cache.py dead-code 의심 등)

---

## 단계 요약

| 단계 | 주제 | 작업 수 | 예상 소요 | 출시 위험 |
|------|------|---------|-----------|-----------|
| 1 | 보안 + 활성 버그 hotfix | 5 | 0.5일 | 낮음 |
| 2 | BE 풀/타임아웃 안정화 | 6 | 2일 | 중 |
| 3 | FE 부하 감소 (폴링·번들) | 7 | 2~3일 | 중 |
| 4 | 무거운 IO / UX 개선 | 4 | 2일 | 중 |
| 5 | (선택) 구조 개선 | 3 | 별도 plan | 높음 |

---

## Phase 1 — 보안 + 활성 버그 hotfix (즉시)

5건 모두 1줄~10줄 변경. 위험 낮고 효과 즉시. 한 PR 로 묶어도 OK.

### Task 1.1: SQL forbidden 정규식 제거

**Files:**
- Modify: `monigrid-be/app/sql_validator.py:9-12, 145-149`

**근거:** `SELECT_LIKE_PATTERN.match()` 가 이미 첫 verb 가 SELECT/WITH 임을 보장. forbidden 정규식은 중복이며 정상 컬럼명(`update_dt`, `created_at`, `call_status`)을 차단하는 부작용.

- [ ] **Step 1: `FORBIDDEN_SQL_PATTERN` 상수 및 사용처 제거**

[monigrid-be/app/sql_validator.py:9-12](monigrid-be/app/sql_validator.py#L9-L12) 의 정규식 정의 삭제. [monigrid-be/app/sql_validator.py:145-149](monigrid-be/app/sql_validator.py#L145-L149) 의 검사 블록 삭제. `SELECT_LIKE_PATTERN` 검사만 남김.

- [ ] **Step 2: 수동 검증**

Before: `SELECT update_dt, created_at FROM monigrid_users` → 400.
After: 동일 쿼리가 200 + 결과 반환.
다음도 모두 통과해야 함:
```sql
SELECT 'INSERT' AS action FROM dual
SELECT a.update_dt FROM users a LEFT JOIN logs b ON a.id = b.user_id WHERE b.delete_yn='N'
```
악성 쿼리는 여전히 거부:
```sql
DROP TABLE monigrid_users  -- SELECT_LIKE_PATTERN 에서 거부
SELECT * FROM x; DROP TABLE y  -- 세미콜론 분리 검사로 거부
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/sql_validator.py
git commit -m "fix(be): sql validator 의 forbidden 키워드 검사 제거 — 정상 컬럼명 차단 부작용"
```

### Task 1.2: JWT default secret 으로 prod 부팅 차단

**Files:**
- Modify: `monigrid-be/app/auth.py:21-48`

**근거:** 현재 `_DEFAULT_JWT_SECRET` 가 56바이트라 길이 검사를 통과 → fallback 그대로 사용. GitHub 레포에 노출된 default 키로 prod 가동 가능.

- [ ] **Step 1: production 모드에서 default 동일성 검사 추가**

[monigrid-be/app/auth.py:21-48](monigrid-be/app/auth.py#L21-L48) `_resolve_jwt_secret()` 안에 추가:

```python
def _resolve_jwt_secret() -> str:
    secret = get_env("JWT_SECRET_KEY", _DEFAULT_JWT_SECRET) or _DEFAULT_JWT_SECRET
    is_production = get_env("FLASK_ENV", "production") == "production"
    if is_production and secret == _DEFAULT_JWT_SECRET:
        raise RuntimeError(
            "JWT_SECRET_KEY 가 default 값입니다. production 환경에서는 반드시 별도 시크릿을 .env 에 설정하세요."
        )
    if len(secret.encode("utf-8")) < _MIN_JWT_KEY_BYTES:
        raise RuntimeError(...)
    return secret
```

- [ ] **Step 2: 수동 검증**

`.env` 에서 `JWT_SECRET_KEY` 제거 후 `python monigrid_be.py` → RuntimeError 로 부팅 실패 확인. 임의 32바이트+ 키 설정 후 정상 부팅 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/auth.py
git commit -m "fix(be): JWT default secret 으로 production 부팅 차단"
```

### Task 1.3: ServerResourceCard `fetchAllServers` 가짜 deps 제거

**Files:**
- Modify: `monigrid-fe/src/components/ServerResourceCard.jsx:349`

**근거:** `useCallback` 본문이 `widgetConfig` 를 참조하지 않는데 deps 에 포함 → 다른 위젯 설정 변경마다 ref 가 바뀌어 setInterval clear&recreate 반복. `NetworkTestCard` 에도 동일 패턴 점검.

- [ ] **Step 1: deps 배열에서 widgetConfig 제거**

[monigrid-fe/src/components/ServerResourceCard.jsx:349](monigrid-fe/src/components/ServerResourceCard.jsx#L349):
```js
// before
const fetchAllServers = useCallback(async () => { ... }, [useSnapshot, targetIds, widgetConfig]);
// after
const fetchAllServers = useCallback(async () => { ... }, [useSnapshot, targetIds]);
```

- [ ] **Step 2: NetworkTestCard 동일 패턴 확인**

[monigrid-fe/src/components/NetworkTestCard.jsx](monigrid-fe/src/components/NetworkTestCard.jsx) grep `useCallback.*widgetConfig`. 본문 미참조면 동일 수정.

- [ ] **Step 3: 수동 검증**

대시보드에 server-resource 위젯 1 + 다른 위젯 1 배치. 다른 위젯 settings modal 열고 텍스트 입력. ServerResource 의 폴링이 reset 되지 않고 정상 주기 유지되는지 Network 탭에서 확인.

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/components/ServerResourceCard.jsx monigrid-fe/src/components/NetworkTestCard.jsx
git commit -m "fix(fe): server-resource / network-test 의 fetchAll deps 에서 widgetConfig 제거 — interval reset 폭주 방지"
```

### Task 1.4: AlarmBanner 멤버 교체 감지

**Files:**
- Modify: `monigrid-fe/src/components/AlarmBanner.jsx:84-91`

**근거:** `useEffect` deps 가 `alarmedWidgets.size` 만이라, 위젯 A→B 로 dead 가 바뀌어도 size 가 같으면 알람 갱신 안 됨. 운영자가 새 incident 를 놓침.

- [ ] **Step 1: stable key 로 dep 교체**

```js
// before
useEffect(() => { ... }, [alarmedWidgets.size]);
// after
const alarmKey = useMemo(
  () => Array.from(alarmedWidgets).sort().join(","),
  [alarmedWidgets]
);
useEffect(() => { ... }, [alarmKey]);
```

본문에서 `alarmedWidgets.size` 비교 로직이 있다면 `lastAlarmKeyRef.current = alarmKey` 로 갱신.

- [ ] **Step 2: 수동 검증**

위젯 2개를 실패 시뮬레이션 (BE 끄거나 임의 endpoint 비활성). A 만 dead 상태에서 알람 → ack → A 복구 + B dead 시 size 동일하지만 새 알람 beep 울리는지 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/AlarmBanner.jsx
git commit -m "fix(fe): alarm banner 가 멤버 교체 감지 — size 동일 케이스에서 알람 누락 방지"
```

### Task 1.5: 401 풀 reload → flush + navigate

**Files:**
- Modify: `monigrid-fe/src/services/http.js:282-301`
- Modify: `monigrid-fe/src/App.jsx` (registerUnauthorizedHandler 콜백)

**근거:** `window.location.href = "/login"` 은 debounce 400ms 내 in-flight push 손실 + 모든 chunk 재요청.

- [ ] **Step 1: http.js 인터셉터에서 reload 제거**

[monigrid-fe/src/services/http.js:282-301](monigrid-fe/src/services/http.js#L282-L301) — `registerUnauthorizedHandler` 콜백만 호출하고 fallback 의 `window.location.href` 제거 (또는 콜백 미등록 시에만 동작).

- [ ] **Step 2: App.jsx 의 콜백에서 flush + navigate**

```jsx
import { useNavigate } from "react-router-dom";
import { flushPendingPush, disableServerSync } from "../store/dashboardStore";
// ...
useEffect(() => {
  registerUnauthorizedHandler(async () => {
    await flushPendingPush().catch(() => {});
    disableServerSync();
    logout();
    navigate("/login", { replace: true });
  });
}, [navigate]);
```

- [ ] **Step 3: 수동 검증**

대시보드에서 위젯 드래그 → 즉시 BE 에서 토큰 invalidate (또는 만료 시뮬레이션) → 다음 요청 401 발생 시 layout 변경이 BE 에 반영 후 로그인 페이지로 이동하는지 확인.

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/services/http.js monigrid-fe/src/App.jsx
git commit -m "fix(fe): 401 시 풀 reload 제거 — pending push flush 후 SPA navigate"
```

---

## Phase 2 — BE 풀/타임아웃 안정화

작업 순서: 2.1 → 2.2 (의존), 나머지 병렬 가능.

### Task 2.1: JDBC `Statement.setQueryTimeout` 적용

**Files:**
- Modify: `monigrid-be/app/jdbc_executor.py:53-59` 및 `_execute_jdbc` 본문

**근거:** Python `Future.cancel()` 은 RUNNING 상태 작업을 못 멈춤 → DB 세션과 풀 connection 이 분 단위로 점거됨.

- [ ] **Step 1: cursor 에 native timeout 적용**

`_execute_jdbc` 안에서 `cursor.execute(sql)` 직전:

```python
cursor = jdbc_conn.cursor()
try:
    # JayDeBeApi 의 cursor._meta 또는 _stmt 접근 — 버전별 확인
    stmt = getattr(cursor, "_stmt", None) or getattr(cursor, "_meta", None)
    if stmt is not None and hasattr(stmt, "setQueryTimeout"):
        try:
            stmt.setQueryTimeout(int(endpoint.query_timeout_sec))
        except Exception as exc:
            logger.warning("setQueryTimeout 실패: %s", exc)
    cursor.execute(sql, params)
    ...
```

- [ ] **Step 2: timeout 발생 시 connection discard**

`run_query` 의 `except FutureTimeoutError` 분기에서 `_jdbc_pool.discard_connection(conn)` 호출. 워커가 영원히 안 풀어주는 connection 이 풀에 재유입되지 않게 한다.

- [ ] **Step 3: 수동 검증**

DB 에 `SELECT pg_sleep(60)` (Postgres) 또는 `WAITFOR DELAY '00:01:00'` (MSSQL) 같은 의도적 long query 등록, `query_timeout_sec=5` 로 설정. 5초 후 timeout 응답 + DB 측에서 해당 세션이 KILL 되는지 확인 (`SHOW PROCESSLIST` / `v$session` / `sys.dm_exec_sessions`).

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/jdbc_executor.py
git commit -m "fix(be): jdbc setQueryTimeout 적용 + timeout 시 connection discard"
```

### Task 2.2: coalesce future result 에 timeout cap

**Files:**
- Modify: `monigrid-be/app/endpoint_cache_manager.py:339-380`

**근거:** owner 가 set_result 전에 죽으면 waiter 가 영구 block → Flask 워커 영구 점거.

- [ ] **Step 1: waiter 의 fut.result() 에 timeout 추가**

```python
# waiter 측
try:
    return fut.result(timeout=endpoint.query_timeout_sec + 5)
except FutureTimeoutError:
    self._in_flight.pop(key, None)
    raise QueryExecutionTimeoutError(...)
```

- [ ] **Step 2: 수동 검증**

owner 워커를 디버거로 set_result 직전에 stop, waiter 가 timeout 후 풀려나는지 확인. 어렵다면 코드 인스펙션으로 충분.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/endpoint_cache_manager.py
git commit -m "fix(be): coalesce waiter timeout cap — owner 사망 시 무한 block 방지"
```

### Task 2.3: bootup warm-up 을 `as_completed` 로

**Files:**
- Modify: `monigrid-be/app/endpoint_cache_manager.py:78-101`
- Modify: `monigrid-be/app/monitor_collector_manager.py:111` (동일 패턴)

**근거:** `for future in futures:` 가 dict 삽입 순서로 60s 대기 — 첫 endpoint 가 느리면 다음 N×60s 대기. 부팅 수 분 hang.

- [ ] **Step 1: as_completed 로 변경**

```python
from concurrent.futures import as_completed

futures = {executor.submit(...): ep.api_id for ep in enabled_endpoints}
for future in as_completed(futures, timeout=120):
    api_id = futures[future]
    try:
        future.result()
    except Exception as exc:
        logger.warning("warm-up 실패 api_id=%s: %s", api_id, exc)
```

monitor_collector_manager 의 동일 루프도 함께.

- [ ] **Step 2: 수동 검증**

의도적으로 한 endpoint 의 SQL 을 `WAITFOR DELAY '00:00:30'` 으로 설정 + 다른 endpoint 들은 즉시 응답. 부팅 시 wall time 이 30초 정도 (60×N 가 아닌) 인지 로그로 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/endpoint_cache_manager.py monigrid-be/app/monitor_collector_manager.py
git commit -m "fix(be): warm-up 을 as_completed 로 — 부팅 시 직렬 대기 폭증 제거"
```

### Task 2.4: paramiko SSH session lock

**Files:**
- Modify: `monigrid-be/app/server_resource_collector.py:60-141`

**근거:** `SSHClient.exec_command` 동시 호출 안전 X. 같은 host 를 여러 target 으로 등록하면 응답 섞임 (CPU 결과에 disk 출력).

- [ ] **Step 1: `_PooledSshSession` 에 Lock 추가**

```python
class _PooledSshSession:
    def __init__(self, ...):
        ...
        self._exec_lock = threading.Lock()

    def run(self, cmd: str, timeout: float) -> tuple[int, str, str]:
        with self._exec_lock:
            stdin, stdout, stderr = self._client.exec_command(cmd, timeout=timeout)
            ...
```

- [ ] **Step 2: 수동 검증 (가능 시)**

같은 host 를 두 target_id 로 등록 후 동시 polling. 1시간 동안 metrics["error"] 발생 빈도 비교 — Lock 없이는 간헐적 `Channel closed` 가 보였다면 Lock 후엔 0 이어야 함.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/server_resource_collector.py
git commit -m "fix(be): SSH session 풀에 exec_lock 추가 — 동시 호출 시 응답 섞임 방지"
```

### Task 2.5: ping batch timeout 상한

**Files:**
- Modify: `monigrid-be/app/network_tester.py:75-114`

**근거:** `timeout * count + 5` 가 worker 5분간 점거 가능.

- [ ] **Step 1: count + wall ceiling 강제**

```python
MAX_PING_COUNT = 3
MAX_PING_WALL_SEC = 30

def run_ping_test(target, count: int = 4, timeout: float = 5.0):
    safe_count = min(int(count), MAX_PING_COUNT)
    safe_wall = min(timeout * safe_count + 5, MAX_PING_WALL_SEC)
    ...
    subprocess.run(ping_cmd, ..., timeout=safe_wall)
```

- [ ] **Step 2: 수동 검증**

ICMP 차단 host 로 count=10, timeout=30 요청 → wall time 30초 내 응답 (305s 가 아님) 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/network_tester.py
git commit -m "fix(be): ping batch wall ceiling 30s + count 3 상한"
```

### Task 2.6: monitor refresh on-demand rate-limit

**Files:**
- Modify: `monigrid-be/app/routes/monitor_routes.py:110-121`

**근거:** admin 연타로 monitor_executor 풀 (size 8) 즉시 fill.

- [ ] **Step 1: limiter decorator 추가**

```python
@bp.post("/<target_id>/refresh")
@require_admin
@limiter.limit("10/minute")
def refresh_target(target_id):
    ...
```

- [ ] **Step 2: 수동 검증**

curl 로 11회 연타 → 11번째 429 응답 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/routes/monitor_routes.py
git commit -m "fix(be): monitor refresh 에 rate-limit 적용 — admin 연타로 pool 점거 방지"
```

---

## Phase 3 — FE 부하 감소

가장 큰 사용자 체감 개선. 작업 모두 독립.

### Task 3.1: 라우트별 `React.lazy` + 무거운 모달 lazy

**Files:**
- Modify: `monigrid-fe/src/App.jsx`
- Modify: `monigrid-fe/src/pages/DashboardPage.jsx` (모달 import)
- Modify: `monigrid-fe/vite.config.js` (manualChunks 추가)

**근거:** 로그인 화면에 recharts/prismjs/react-grid-layout 1MB+ 다운로드.

- [ ] **Step 1: 페이지 lazy import**

```jsx
import { lazy, Suspense } from "react";
const LoginPage = lazy(() => import("./pages/LoginPage"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const LogViewerPage = lazy(() => import("./pages/LogViewerPage"));
const AlertHistoryPage = lazy(() => import("./pages/AlertHistoryPage"));
const UserManagementPage = lazy(() => import("./pages/UserManagementPage"));

<Suspense fallback={<div>Loading…</div>}>
  <Routes>...</Routes>
</Suspense>
```

- [ ] **Step 2: 무거운 모달 lazy mount**

`SqlEditorModal`, `ConfigEditorModal` 등 prismjs 사용 모달은 `lazy()` + 모달 open 시점에만 import.

- [ ] **Step 3: vite manualChunks 분리**

```js
// vite.config.js
export default defineConfig({
  ...,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          recharts: ["recharts"],
          editor: ["prismjs", "react-simple-code-editor"],
          grid: ["react-grid-layout", "react-resizable"],
        },
      },
    },
  },
});
```

- [ ] **Step 4: 수동 검증**

`npm run build` 후 dist 의 chunk 크기 확인. 로그인 페이지 진입 시 Network 탭에서 recharts/prismjs chunk 가 다운로드 안 되는지 확인. 대시보드 진입 시점에 lazy chunk 가 fetch 되는지.

- [ ] **Step 5: Commit**

```bash
git add monigrid-fe/src/App.jsx monigrid-fe/src/pages/DashboardPage.jsx monigrid-fe/vite.config.js
git commit -m "perf(fe): route lazy + heavy 모달 lazy + manualChunks — 초기 번들 분할"
```

### Task 3.2: visibility-aware polling

**Files:**
- Modify: `monigrid-fe/src/hooks/useWidgetApiData.js:255-311`
- Modify: `monigrid-fe/src/components/NetworkTestCard.jsx:393-399`
- Modify: `monigrid-fe/src/components/ServerResourceCard.jsx:366-371`

**근거:** 30위젯 × 5초 폴링이 hidden 탭에서도 계속.

- [ ] **Step 1: 공용 hook 추가**

`monigrid-fe/src/hooks/useDocumentVisible.js` 신규:
```js
import { useEffect, useState } from "react";

export function useDocumentVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const handler = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);
  return visible;
}
```

- [ ] **Step 2: 폴링 hook 들에서 hidden 시 skip**

`useWidgetApiData` 의 tick 함수 진입에:
```js
if (document.hidden) return;
```
visible 로 전환된 시점에 즉시 1회 fetch + 정상 schedule 재진입 (visibility 이벤트 listener 에서).

- [ ] **Step 3: 수동 검증**

DevTools Network 탭 켜고 다른 탭으로 전환. 1분 후 돌아왔을 때 hidden 동안 request 가 거의 없고, visible 직후 1회 burst 후 정상 주기인지 확인.

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/hooks/useDocumentVisible.js monigrid-fe/src/hooks/useWidgetApiData.js monigrid-fe/src/components/NetworkTestCard.jsx monigrid-fe/src/components/ServerResourceCard.jsx
git commit -m "perf(fe): hidden 탭에서 위젯 폴링 일시 정지 — BE 부하 / 배터리 절감"
```

### Task 3.3: 폴링 backoff (network failure thundering herd 방지)

**Files:**
- Modify: `monigrid-fe/src/hooks/useApiData.js:66-71, 98-114`
- Modify: `monigrid-fe/src/hooks/useWidgetApiData.js`

**근거:** BE 장애 시 모든 위젯이 같은 주기로 재시도 → 복구를 더 어렵게 함.

- [ ] **Step 1: 위젯별 consecutive-failure count + exponential**

```js
// useWidgetApiData
const failureCountRef = useRef(new Map());
function nextDelay(widgetId, baseInterval) {
  const fails = failureCountRef.current.get(widgetId) || 0;
  if (fails === 0) return baseInterval * 1000;
  return Math.min(baseInterval * 1000 * (2 ** Math.min(fails, 5)), 5 * 60 * 1000);
}
// fetch 성공 시: failureCountRef.current.set(id, 0)
// 실패 시: failureCountRef.current.set(id, fails + 1)
```

`setTimeout` 기반으로 schedule 변경 (setInterval 은 backoff 표현 어려움).

- [ ] **Step 2: 수동 검증**

BE 종료 후 Network 탭에서 같은 위젯 재시도 간격이 5s → 10s → 20s → 40s → 80s 로 늘어나는지. BE 복구 후 첫 성공 시 5s 로 reset 되는지.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/hooks/useApiData.js monigrid-fe/src/hooks/useWidgetApiData.js
git commit -m "perf(fe): 폴링 실패 시 exponential backoff — BE 장애 시 thundering herd 방지"
```

### Task 3.4: WidgetRenderer inline callback 메모

**Files:**
- Modify: `monigrid-fe/src/pages/WidgetRenderer.jsx:232-234, 260-262`

**근거:** 매 렌더 새 함수가 자식 effect 를 매 렌더 재실행.

- [ ] **Step 1: useCallback + widgetId 클로저**

```jsx
const handleAlarmChange = useCallback(
  (status) => onReportWidgetStatus(widget.id, status),
  [onReportWidgetStatus, widget.id]
);
// 그리고 onAlarmChange={handleAlarmChange}
```

- [ ] **Step 2: 수동 검증**

React DevTools Profiler 로 부모 state 변경 1회 시 자식의 useEffect 재실행 횟수 측정. before/after 비교.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/pages/WidgetRenderer.jsx
git commit -m "perf(fe): widget renderer 의 alarm callback 메모이제이션"
```

### Task 3.5: ApiCard `columnWidths` 자동 시드 루프 차단

**Files:**
- Modify: `monigrid-fe/src/components/ApiCard.jsx:369-388`

**근거:** `availableColumns` 가 폴링마다 새 ref → effect 재실행 → store 업데이트 → 재렌더 → 또 effect.

- [ ] **Step 1: 진짜 변경된 경우만 setter 호출**

```js
useEffect(() => {
  const currentKeys = Object.keys(tableSettings.columnWidths || {}).sort().join(",");
  const nextKeys = availableColumns.map((c) => c.key).sort().join(",");
  if (currentKeys === nextKeys) return;  // 컬럼 set 동일하면 skip
  // ... 기존 로직
}, [availableColumns, tableSettings.columnWidths]);
```

또는 `availableColumns` 의 stable key 를 useMemo 로 만든 뒤 그 string 을 dep 으로.

- [ ] **Step 2: 수동 검증**

ApiCard 가 있는 대시보드를 5분 운영 후 React DevTools Profiler 로 ApiCard 의 commit 횟수 = 폴링 횟수와 일치 (×N 폭증 아님) 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/ApiCard.jsx
git commit -m "fix(fe): apicard columnWidths 자동 시드 effect 의 무한 루프 가능성 차단"
```

### Task 3.6: ApiCard 전역 keydown 리스너를 상위로

**Files:**
- Modify: `monigrid-fe/src/components/ApiCard.jsx:428-447`

**근거:** 30위젯 = 30 listeners.

- [ ] **Step 1: 카드 root 에 tabIndex + onKeyDown**

```jsx
<div
  className="api-card"
  tabIndex={0}
  onKeyDown={handleKeyDown}
  ref={cardRef}
>
```

`document.addEventListener` 제거. 사용자가 카드를 클릭/포커스한 상태에서만 Ctrl+C 동작.

- [ ] **Step 2: 수동 검증**

위젯 hover 만 한 상태에서 Ctrl+C → 동작 안 함 (의도). 위젯 클릭 후 Ctrl+C → 동작. 두 위젯 동시에 listener 가 발화하지 않는지 React DevTools 로 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/ApiCard.jsx
git commit -m "perf(fe): apicard keydown 을 카드 스코프로 — 위젯 N개 × 전역 listener 제거"
```

### Task 3.7: MonitorTargetPicker 호출 캐시

**Files:**
- Modify: `monigrid-fe/src/components/MonitorTargetPicker.jsx:50-58`
- Modify: `monigrid-fe/src/services/api.js` (또는 새 cache util)

**근거:** 모달 열 때마다 동일 GET 발사.

- [ ] **Step 1: 모듈 레벨 promise cache (TTL 30s)**

```js
let cachedPromise = null;
let cacheExpiry = 0;
export function listMonitorTargetsCached() {
  const now = Date.now();
  if (cachedPromise && now < cacheExpiry) return cachedPromise;
  cachedPromise = listMonitorTargets();
  cacheExpiry = now + 30_000;
  cachedPromise.catch(() => { cachedPromise = null; cacheExpiry = 0; });
  return cachedPromise;
}
```

설정 저장 시 invalidate 함수 export.

- [ ] **Step 2: 수동 검증**

여러 위젯 settings 모달을 30초 안에 차례로 열기 → Network 탭에서 `/monitor-targets` GET 이 1번만 발생. 30초 후엔 다시 1회.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/MonitorTargetPicker.jsx monigrid-fe/src/services/api.js
git commit -m "perf(fe): monitor target list 30s 캐시 — 모달 반복 오픈 시 중복 GET 제거"
```

---

## Phase 4 — 무거운 IO / UX 개선

### Task 4.1: log_reader byte-offset cursor

**Files:**
- Modify: `monigrid-be/app/log_reader.py:64-110`

**근거:** follow 모드에서 1GB 파일 매 polling 마다 처음부터 읽음 → 디스크 IO 100%.

- [ ] **Step 1: cursor 에 byte offset 저장**

cursor schema 확장:
```python
{ "file": "20260505.log", "offset": 12345678, "line": 9000 }
```
follow 호출 시 `f.seek(offset)` 후 `read(MAX_TAIL_BYTES)` 만 읽고 line split. 파일 rotate 감지 (파일 inode 변경 또는 size < offset) 시 offset=0 reset.

- [ ] **Step 2: 수동 검증**

100MB 로그 파일 가짜 생성 후 LogViewer LIVE 모드 5초 주기 폴링. `iotop` / Activity Monitor 로 디스크 read MB/s 가 기존 대비 1/100 이하인지 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/log_reader.py
git commit -m "perf(be): log_reader 에 byte-offset cursor — follow 모드 디스크 IO 폭증 제거"
```

### Task 4.2: dashboard refresh-all 병렬 fan-out

**Files:**
- Modify: `monigrid-be/app/endpoint_cache_manager.py:300-309`
- Modify: `monigrid-be/app/routes/dashboard_routes.py:262-273`

**근거:** 50 endpoint × 1초 = 50초 worker 점거.

- [ ] **Step 1: refresh_all 을 executor.submit + as_completed 로**

```python
def refresh_all_endpoint_caches(self) -> list:
    futures = {self._executor.submit(self.refresh_endpoint_cache, ep, ...): ep for ep in self._enabled_endpoints()}
    results = []
    for fut in as_completed(futures, timeout=120):
        try:
            results.append(fut.result())
        except Exception as exc:
            ep = futures[fut]
            logger.warning("refresh-all 실패 api_id=%s: %s", ep.api_id, exc)
    return results
```

- [ ] **Step 2: 수동 검증**

10개 endpoint (각 평균 1초) 등록 후 admin UI 의 refresh-all 클릭. wall time 이 ~1~2초 (10초 가 아닌) 인지 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/endpoint_cache_manager.py monigrid-be/app/routes/dashboard_routes.py
git commit -m "perf(be): refresh-all 을 병렬 fan-out — 직렬 실행으로 worker 점거 제거"
```

### Task 4.3: LogViewerPage virtualization

**Files:**
- Add dependency: `react-window` (또는 `react-virtuoso`)
- Modify: `monigrid-fe/src/pages/LogViewerPage.jsx:252-258`

**근거:** 1만 라인 + 5초 자동 갱신 시 매 갱신마다 전체 unmount/remount.

- [ ] **Step 1: react-window 추가**

```bash
cd monigrid-fe && npm install react-window
```

- [ ] **Step 2: List 컴포넌트로 교체**

```jsx
import { FixedSizeList } from "react-window";

<FixedSizeList
  height={containerHeight}
  itemCount={logs.length}
  itemSize={20}
  width="100%"
>
  {({ index, style }) => (
    <div style={style} className="log-line">{logs[index]}</div>
  )}
</FixedSizeList>
```

key 안정성 위해 cursor + index 조합 사용.

- [ ] **Step 3: 수동 검증**

10000 라인 로그 LIVE 모드. 스크롤 시 흔들림 없고 메모리 사용량 (Performance 탭) 이 라인 수에 비례하지 않는지 확인.

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/package.json monigrid-fe/package-lock.json monigrid-fe/src/pages/LogViewerPage.jsx
git commit -m "perf(fe): log viewer virtualization — 만 라인급 로그 스크롤/메모리 개선"
```

### Task 4.4: AlertHistoryPage visibility-aware polling

**Files:**
- Modify: `monigrid-fe/src/pages/AlertHistoryPage.jsx:36-40`

**근거:** mount 1회만 load → 새 incident 가 즉시 반영 안 됨.

- [ ] **Step 1: useDocumentVisible + 30s polling**

Phase 3 에서 만든 `useDocumentVisible` 활용:

```jsx
const visible = useDocumentVisible();
useEffect(() => {
  if (!isAuthenticated || !visible) return;
  loadAlerts();
  const id = setInterval(loadAlerts, 30_000);
  return () => clearInterval(id);
}, [isAuthenticated, visible]);
```

incident 수 1000 이상이면 IncidentTimelineCard 도 virtualization 적용 검토 (별도 task).

- [ ] **Step 2: 수동 검증**

새 alarm 발생 → 30초 내 페이지 자동 갱신 확인. 다른 탭으로 전환 후 30분 → 폴링 안 일어남 확인.

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/pages/AlertHistoryPage.jsx
git commit -m "feat(fe): alert history visibility-aware polling 30s — 새 incident 자동 반영"
```

---

## Phase 5 — (선택) 구조 개선

큰 변경이라 별도 brainstorming → 별도 plan 작성 권장. 여기서는 항목과 트리거 조건만.

### Task 5.1: SettingsStore 락 분해 + SQL 본문 짧은 TTL 캐시
- **트리거:** settings DB 가 원격(RTT 30ms+) 으로 이전되거나, 동시 사용자 50명+ 도달 시.
- **위치:** `monigrid-be/app/settings_store.py:359-368`
- **개요:** 단일 connection + RLock 을 풀로 분리. SQL 본문은 30초 TTL + 변경 시 invalidate. 기존 multi-node sync 보장 로직 (현재 매번 SELECT) 의 동작을 깨지 않도록 신중한 설계 필요.

### Task 5.2: JDBC 풀 borrowed 추적 + hard cap
- **트리거:** 신규 코드에서 `get_connection` 호출이 늘어나거나, DB 측 max_connections 경고가 들어올 때.
- **위치:** `monigrid-be/app/db.py:115-272`
- **개요:** `in_use_count` 추가, hard cap 도달 시 wait/거부, leak 시 stack trace 와 함께 warning 로그.

### Task 5.3: dashboardStore 구조 정규화 (Map 기반)
- **트리거:** 위젯 30개+ 환경에서 drag/setting 시 reflow 가 체감될 때.
- **위치:** `monigrid-fe/src/store/dashboardStore.js:198-220`
- **개요:** widgets 를 array → `Map<id, widget>` 으로 변경, `subscribeWithSelector` 로 per-widget selector. WidgetRenderer 는 id 만 받아 자체 selector 로 widget 구독.

---

## 실행 가이드

- 각 Phase 단위로 PR 분리 권장. Phase 1 은 한 PR 가능. Phase 2~4 는 task 단위 PR.
- 각 task 의 수동 검증을 통과하기 전에 다음 task 진행 금지 (regression 누적 방지).
- Phase 5 는 진입 전에 brainstorming 으로 새 plan 작성.
- Phase 1, 2 완료 후 prod 1주일 운영 모니터링 후 Phase 3 진입 권장 (BE 변화가 안정화된 뒤 FE 부하 감소 효과 측정).

# MoniGrid 메모리/리소스/장애내성 정밀 리뷰 (2026-05-03)

> 컴퓨터 재시작 후 새 Claude 세션에서 이 작업을 이어가기 위한 휴대용 보고서.
> 다음 세션 진입 시: 이 파일을 먼저 읽고, 같은 폴더의 [AUDIT_TODO.md](./AUDIT_TODO.md) 의 진행 상황을 확인할 것.

## 컨텍스트 한 줄 요약

- 프로젝트: `d:/workspace/dev/project/project-monigrid` (브랜치 `develop`)
- 스택: Flask + Waitress + JayDeBeApi/JPype(JDBC) BE / React + Vite + Zustand + react-grid-layout FE / Electron 패키징
- 백그라운드: ① endpoint SQL 캐시 갱신 스레드 ② monitor target(server_resource/network/http_status) 수집 스레드 ③ Flask 워커 풀
- 리뷰 시점 HEAD: `9e9b13d` (docs 갱신) — 코드는 `d240fa4` 시점과 동일

## 변경 금지 — 이 파일은 분석만 담는다

코드는 아직 손대지 않았다. 패치는 [AUDIT_TODO.md](./AUDIT_TODO.md) 의 항목 단위로 사용자 승인 후 진행.

---

## Critical — 즉시 패치 권장

### C1. SettingsStore 동시성 — 단일 JDBC 커넥션을 락 없이 N+M+W 스레드가 공유
**파일**: `monigrid-be/app/settings_store.py:357-466`

- 클래스 docstring 에 "Not thread-safe at the connection level" 이라 적혀 있으나, 실제로는 collector 스레드 N개 + endpoint cache 스레드 M개 + Flask 워커 16개가 동시에 `_cursor()` 를 호출
- **시나리오**: collector 의 `_target_loader()` (`monitor_collector_manager.py:170`) 와 FE 의 `GET /dashboard/monitor-targets` 가 동시 진입하면 같은 connection 에 두 cursor 가 떠서 `Connection is busy` / `ResultSet already closed` / 데이터 corruption
- **권장 조치**: SettingsStore 내부에 `threading.RLock` 추가하고 모든 public 메서드 진입 시 락. 또는 settings DB 도 풀 전환

### C2. 프론트엔드 ErrorBoundary 부재 — 위젯 1개 렌더 오류로 대시보드 전체 흰 화면
**파일**: `monigrid-fe/src/App.jsx:36-100`, `monigrid-fe/src/pages/WidgetRenderer.jsx`

- 라우트/그리드 어디에도 ErrorBoundary 없음
- **시나리오**: ApiCard 의 `JSON.stringify` 가 BigInt/순환참조에 throw, recharts 데이터에 Infinity 유입, DynamicTable 의 `value.toLocaleString()` 등 → 한 위젯 오류로 30개 위젯 + 헤더 전체가 unmount
- **권장 조치**: WidgetRenderer 한 칸을 둘러싸는 ErrorBoundary 1개만 추가해도 위젯 단위 격리 가능

---

## High — 단기 내 패치 필요

### H1. EndpointCacheManager 백그라운드 루프 사망 가능성
**파일**: `monigrid-be/app/endpoint_cache_manager.py:120-146`

- 루프 안 `_config_provider()` (= `_load_config_from_store`) 가 settings DB 일시 단절 시 RuntimeError 를 던지면 broad except 가 없어 해당 endpoint 스레드가 영구 사망. 다른 endpoint 는 살아있어 **부분 정전이 운영자에게 안 보임**
- **권장**: 루프 본문 전체를 `try/except Exception` 으로 한 번 더 감싸고 실패 시 sleep

### H2. HTTP health checker — 대용량 응답 메모리 폭주
**파일**: `monigrid-be/app/http_health_checker.py:37-44`

- `requests.get(stream=False, allow_redirects=True)` → 본문 전체를 메모리에 로드 후 `resp.text[:4096]` 로 슬라이스. Content-Length 검사 없음
- **시나리오**: `http_status` 타겟이 1GB 응답을 가리키면 collector 워커가 1GB 다운 후 4096 바이트만 슬라이스
- **권장**: `stream=True` + `iter_content(chunk_size=4096)` 로 첫 청크만 읽고 close

### H3. JWT secret fallback 강제 검증 없음
**파일**: `monigrid-be/app/auth.py:20-38`

- 32B 미만 secret 이면 하드코딩된 `_DEFAULT_JWT_SECRET` 으로 fallback + warn. 시작 시 abort 안 함
- **권장**: production (`FLASK_ENV != development`) 에서는 fallback 시 startup abort

### H4. SSH 세션 재사용 안 함 — 매 tick 마다 새 SSH handshake
**파일**: `monigrid-be/app/server_resource_collector.py:497`

- linux/windows-ssh 타겟마다 collect 시 `with _SshRunner(...)` 진입 → connect/close 반복
- **시나리오**: 100개 server_resource 타겟 × 10초 주기 = 분당 600회 SSH handshake. paramiko handshake 200~500ms 가 collector 풀을 점유 → JDBC 작업 굶음
- **권장**: target_id 별 `_SshRunner` keepalive 캐시 (LRU + idle 만료)

### H5. JVM classpath 정적 — 새 JDBC jar 추가 시 영구 실패
**파일**: `monigrid-be/app/db.py:46-92`, `monigrid-be/app/service.py:108-117`

- JPype 는 startJVM 후 classpath 변경 불가. service.py 는 시작 시 1회만 jar 를 모아 startJVM. reload 시 새 connection 이 가리키는 jar 가 classpath 에 없으면 `ClassNotFoundException` 영구 발생, 프로세스 재시작 필요
- **권장**: reload 시 신규 jar 감지되면 명시 에러를 운영자에게 반환 (현재는 ClassNotFound 만 로그에 묻힘)

### H6. LogReader 가 일자별 로그 전체를 메모리로 로드
**파일**: `monigrid-be/app/log_reader.py:71-72`

- `f.readlines()` 후 슬라이싱
- **시나리오**: daily 로그가 수백 MB 일 때 `/logs?follow_latest=true` 한 번에 메모리 폭증 → 동시 5명이 호출하면 워커 5개가 같은 파일을 풀로 메모리에 올림
- **권장**: `seek()` 기반 cursor 또는 마지막 N 라인 tail 스트림

### H7. FE — 폴링 hook 의 AbortController 누락
**파일**: `monigrid-fe/src/hooks/useWidgetApiData.js:131-211`

- 위젯 빠른 추가/삭제 사이클에서 in-flight 응답이 setState 호출. epoch guard 가 일부 막지만 본문 다운로드/JSON.parse 는 그대로 진행
- **권장**: axios `AbortController.signal` 을 hook 마다 생성, cleanup 에서 `abort()`

### H8. FE — 로그인 직후 thundering herd, jitter 없음
**파일**: `monigrid-fe/src/hooks/useWidgetApiData.js:228-254`

- 30 위젯 × 5초 주기 → 매 5초마다 30 req 동시 burst. 브라우저 호스트당 6 connection 한도에 걸려 큐잉 → 응답 지연 → in-flight guard 누락
- **권장**: 위젯 ID 해시 기반 phase shift 또는 `Math.random() * intervalSec * 0.3` 초기 지연

### H9. FE — 로컬↔서버 prefs sync race
**파일**: `monigrid-fe/src/store/dashboardStore.js:277-331`

- 로그인 직후 `syncPreferencesFromServer()` 가 통째 set. sync 가 끝나기 전 사용자가 위젯을 추가하면 `serverSyncEnabled=false` 라 `queueServerPush()` 가 노옵 → sync 응답이 도착해 새 위젯을 잃음
- **권장**: sync 진행 중 dirty flag → 완료 후 dirty 면 강제 push

---

## Medium

| # | 위치 | 요약 |
|---|------|------|
| M1 | `monigrid-be/app/service.py:59-103` | Collector(IO-bound) 와 cache refresh(JDBC) 가 같은 ThreadPool 공유 → SSH 가 풀 슬롯 길게 점유해 JDBC 작업 굶음. 풀 분리 |
| M2 | `monigrid-be/app/endpoint_cache_manager.py:317-322` | cache miss 시 동기 JDBC. coalesce 패턴으로 같은 api_id 동시 fresh 요청을 하나의 future 로 묶기 |
| M3 | `monigrid-be/monigrid_be.py:127,144` | CORS 와일드카드. supports_credentials=False 라 자격증명은 안 가지만 Authorization 헤더는 임의 origin 에서 호출 가능 |
| M4 | `monigrid-be/app/monitor_collector_manager.py:138-146` | 삭제된 target 의 `_snapshots` 잔여 — `delete_monitor_target` 직후 `_snapshots.pop(id, None)` 명시 |
| M5 | `monigrid-be/app/settings_store.py:600-685` | `replace_connections` / `replace_apis` 가 commit 을 호출자에 위임. 단독 호출 시 lock 점유 — 함수 내부에서 commit 보장 |
| M6 | `monigrid-fe/src/services/http.js:183,248-258` | `_rateLimitByPath` Map 무한 누적. 만료된 엔트리 lazy sweep 또는 1분 주기 정리 |
| M7 | `monigrid-fe/src/services/http.js:243-287` | 401 인터셉터 race — 토큰 만료 burst 시 `_onUnauthorized()` 가 30회 호출됨. 1회 latch |
| M8 | `monigrid-fe/src/pages/DashboardPage.jsx:737-743` | `<ResponsiveGridLayout layouts={{lg,md,sm,xs,xxs}}>` 객체 리터럴 매 렌더 새 생성. useMemo 로 묶기 |
| M9 | `monigrid-fe/src/components/DynamicTable.jsx:140-191` | sort/filter 매 렌더 재실행 (100행 × 분당 12회 × 30 테이블). useMemo 누락 |
| M10 | `monigrid-fe/src/components/HealthCheckCard.jsx`, `NetworkTestCard.jsx`, `ServerResourceCard.jsx`, `ApiCard.jsx` | `<WidgetSettingsModal open={false}>` 라도 부모는 모든 draft state + sync useEffect 보유. 모달 내부에서 lazy init |
| M11 | `monigrid-fe/electron/main.cjs:13-18` | `sandbox: true` 미설정 + CSP 메타 태그 부재 |

---

## Low / 참고

- **bcrypt cost=12** (`monigrid-be/app/auth.py:71`) — `rate_limits.auth_login` 으로 보호되면 OK
- **`_sql_signatures` dict 영구 보유** (`monigrid-be/app/jdbc_executor.py:48,131`) — sha256 만 보관해도 충분
- **`bare except: pass` 다수** (settings_store, db.py) — close 실패는 OK 패턴이나 `_safe_close` + `logger.debug` 권장
- **JWT 디코드 중복** — `caller_is_admin` + `current_username` 양쪽 사용 라우트는 한 요청에 3회 디코드. `flask.g` 캐시
- **AlarmBanner 모듈 단위 AudioContext** (`monigrid-fe/src/components/AlarmBanner.jsx:12-25`) — 의도된 설계, 누수 아님
- **다중 탭 storage 이벤트 미구독** — 로그아웃 동기화 누락. `window.addEventListener('storage', ...)`
- **위젯 폴링 hook 의 부모 stale ref** — recent commit (`af92ac4`) 의 `widgetsRef` 패턴은 적용됨, 정상

---

## 검증/추측 구분

이 보고는 두 명의 정밀 에이전트가 실제 파일을 읽고 문서화한 결과이며 file:line 모두 코드 인용 기반이다. 단, 일부 시나리오는 **트래픽/규모 가정**(예: 위젯 30개, 타겟 100개)에 의존하므로 운영 환경 실측치로 보정해야 한다.

검증 안 된 가정:
- BE thread_pool_size 기본값 16 → 실제 운영 config 의 값에 따라 thundering herd / 풀 굶음 영향이 달라짐
- FE 위젯 갯수가 분당 burst 부하의 주 변수 — 실 사용자 평균 위젯 수에 따라 H8 의 우선순위가 변동

---

## 부록 — 리뷰 방법

1. `Agent(general-purpose)` 두 개를 BE / FE 로 병렬 투입
2. 각각 메모리 누수 / 예외 처리 / 동시성 / 성능 카테고리로 점검 지시
3. 보고는 file:line + 시나리오 + 위험도 + 권장 조치 형식 강제
4. 결과 통합 후 사용자에게 위험도 정렬로 단일 보고

다음 세션에서 리뷰를 다시 돌리고 싶으면 이 .claude/AUDIT_REPORT.md 파일과 [AUDIT_TODO.md](./AUDIT_TODO.md) 의 진행 상황을 비교해 처리되지 않은 항목 위주로 재실행하면 된다.

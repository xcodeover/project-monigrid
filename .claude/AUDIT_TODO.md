# 패치 작업 진행 표 (2026-05-03 작성)

> 새 세션에서 작업을 이어가는 진입점. 이 파일을 먼저 읽고 [AUDIT_REPORT.md](./AUDIT_REPORT.md) 와 함께 참조.
> 작업 시작 시: TodoWrite 로 이 목록을 그대로 적재한 뒤 항목별로 `pending → in_progress → completed` 전환.

## 시작 절차 (새 세션 진입 시)

1. `git -C d:/workspace/dev/project/project-monigrid status` — 작업 디렉토리가 깨끗한지 확인
2. `git -C d:/workspace/dev/project/project-monigrid log --oneline -5` — 마지막 커밋이 `9e9b13d` (docs 갱신) 직후인지 확인
3. 이 파일의 "진행 상태" 섹션에서 `[x]` 로 체크된 항목은 건너뛰고, 가장 위의 미완료 항목부터 진행
4. **각 항목은 사용자에게 "다음 항목 진행할까요?" 라고 확인한 후 패치를 시작** — 일괄 처리 금지
5. 항목 완료 시 이 파일의 체크박스를 `[x]` 로 갱신하고, 한 항목 = 한 커밋 (단, 자연스러운 묶음은 묶어도 됨)

## 코딩 원칙 (이 파일에만 적용)

- 안전한 변경부터, 효과 큰 것부터 (Critical → High → Medium 순)
- 파일당 최소 변경 — 리팩토링/코멘트 추가 금지
- 테스트 가능한 곳은 변경 후 즉시 검증 절차도 본문에 적기
- 의도가 비자명한 변경에만 1줄 주석 (왜 RLock 이 필요한지 등)
- 작업 후 `npm run build` (FE) 또는 `python -c "import app.<module>"` (BE) 로 import 검증

---

## 진행 상태

### Critical (먼저 처리)

- [x] **C1. SettingsStore RLock 도입** — `monigrid-be/app/settings_store.py:357-466` (commit `fb02184`)
  - 클래스 내부에 `self._lock = threading.RLock()` 추가
  - 모든 public 메서드 (list_*, replace_*, save_*, delete_*, _cursor) 진입 시 `with self._lock:`
  - 변경 후 검증: collector + cache + Flask 워커 동시 가동 시 `Connection is busy` 가 사라지는지 로그 모니터
  - 한 줄 주석으로 "단일 JDBC connection 공유 직렬화" 사유 명시

- [x] **C2. WidgetRenderer 단위 ErrorBoundary** — `monigrid-fe/src/pages/WidgetRenderer.jsx` (commit `a9bd16d`)
  - 새 파일 또는 같은 파일 내 `class WidgetErrorBoundary extends React.Component` 추가
  - `componentDidCatch` 에서 console.error + 위젯 카드 모양의 fallback UI 렌더 (제목 + "위젯 오류, 새로고침 권장" + 재시도 버튼)
  - WidgetRenderer 의 위젯 출력부를 boundary 로 wrap
  - 변경 후 검증: 임의 위젯 컴포넌트에 `throw new Error("test")` 한 줄 넣고 다른 위젯들이 정상 표시되는지 확인 후 원복

### High

- [x] **H1. Endpoint cache 루프 broad except** — `monigrid-be/app/endpoint_cache_manager.py:120-146` (commit `f0e7b84`)
  - `_refresh_loop` 의 `while not self._stop.is_set()` 본문 전체를 `try/except Exception` 으로 감싸기
  - except 시 `self._logger.exception(...)` + `self._stop.wait(self._fallback_sleep_sec or 5)`
  - settings DB 일시 단절 시 부분 정전 방지

- [x] **H2. http_health_checker stream=True** — `monigrid-be/app/http_health_checker.py:37-44` (commit `ee7166c`)
  - `requests.get(url, timeout=..., stream=True, allow_redirects=True, verify=False)` 로 변경
  - body 는 `next(resp.iter_content(_BODY_BYTES_LIMIT, decode_unicode=False))` 로 첫 청크만 읽고 즉시 close
  - `resp.close()` finally 보장
  - 변경 후 검증: 1MB+ 응답을 주는 URL 로 테스트 (curl httpbin.org/bytes/1048576 같은)

- [x] **H3. JWT secret 강제 검증** — `monigrid-be/app/auth.py:20-38` (commit `9ca0c37`)
  - 32B 미만 + `os.environ.get("FLASK_ENV") != "development"` 면 `raise RuntimeError(...)` 로 startup abort
  - 개발 모드에서는 기존 warn 유지

- [x] **H4. SSH 세션 keepalive 캐시** — `monigrid-be/app/server_resource_collector.py:497` (commit `df1285d`)
  - module-level dict `_ssh_pool: dict[target_id, (_SshRunner, last_used_ts)]`
  - LRU 만료 (idle 5분 초과 시 close)
  - thread-safe 락 + collector 재기동 시 풀 비우기 (service.reload 와 연동)
  - 가장 변경 범위 큰 패치 — H 항목 마지막에 처리 권장

- [x] **H5. JVM classpath reload 안내** — `monigrid-be/app/db.py:46-92`, `service.py:108-117` (commit `827a609`)
  - reload 시점에 신규 connection.jdbc_jars 가 기존 classpath 에 없으면 `RuntimeError("...JVM 재시작 필요")` 명시
  - 또는 dashboard reload-config 응답에 warning 포함

- [x] **H6. LogReader tail 스트림** — `monigrid-be/app/log_reader.py:71-72` (commit `f924a59`)
  - `f.readlines()` 대신 마지막 N 라인을 `seek` + `read` 로 가져오기 (deque(maxlen=N) 패턴)
  - `max_lines` 가 cap 역할 (이미 1..10000 clamp 됨)
  - 변경 후 검증: 100MB 더미 로그 생성 후 `/logs?max_lines=1000` 의 메모리 사용량

- [x] **H7. FE AbortController** — `monigrid-fe/src/hooks/useWidgetApiData.js:131-211` (commit `ff08e4c`)
  - 위젯별 `AbortController` 를 ref 로 저장
  - 폴링 진입 시 새 controller 생성, axios `signal` 전달
  - cleanup / 위젯 제거 시 `controller.abort()`
  - useApiData 도 동일 패턴 적용

- [x] **H8. FE jitter 도입** — `monigrid-fe/src/hooks/useWidgetApiData.js:228-254` (commit `50c2f05`)
  - 위젯 ID 해시 기반 phase shift: `const phaseMs = (hash(widgetId) % 1000) * (intervalSec * 1000 / 1000)`
  - `setTimeout(firstFetch, phaseMs)` 후 `setInterval(...)` 시작
  - 또는 `Math.random() * intervalSec * 0.3 * 1000` 초기 지연
  - 검증: Network 탭에서 burst 가 분산되는지

- [x] **H9. dashboardStore sync race** — `monigrid-fe/src/store/dashboardStore.js:277-331` (commit `0ff7f60`)
  - sync 진행 중 `_syncInFlight = true`, mutation 발생 시 `_dirtyDuringSync = true`
  - sync 응답 적용 후 `_dirtyDuringSync` 면 즉시 `queueServerPush()` (debounce 우회)

### Medium (시간 되면)

- [x] M1. Collector / cache 풀 분리 (`monigrid-be/app/service.py:59-103`) — commit `22a0956`
- [x] M2. cache miss coalesce (`monigrid-be/app/endpoint_cache_manager.py:317-322`) — commit `baa90f9`
- [x] M3. CORS allowlist (`monigrid-be/monigrid_be.py:127,144`) — commit `e6eb7b5`
- [x] M4. 삭제 target snapshot 정리 (`monigrid-be/app/monitor_collector_manager.py:138-146`) — commit `063f8fc`
- [x] M5. settings_store replace_* commit (`monigrid-be/app/settings_store.py:600-685`) — commit `3c23f82`
- [x] M6. `_rateLimitByPath` sweep (`monigrid-fe/src/services/http.js:183,248-258`) — commit `3fe0b28`
- [x] M7. 401 latch (`monigrid-fe/src/services/http.js:243-287`) — commit `3fe0b28`
- [x] M8. layouts 객체 useMemo (`monigrid-fe/src/pages/DashboardPage.jsx:737-743`) — commit `ad6f8e4`
- [x] M9. DynamicTable sort useMemo (`monigrid-fe/src/components/DynamicTable.jsx:140-191`) — commit `7bc13b2`
- [x] M10. 위젯 모달 lazy init (4개 카드) — commit `b2f0863`
- [x] M11. Electron sandbox + CSP (`monigrid-fe/electron/main.cjs:13-18`) — commit `30d7e95`

### Low (선택)

- [ ] bcrypt cost 재검토 / `_sql_signatures` sha256 만 / `_safe_close` 디버그 로그 / JWT g 캐시 / 다중 탭 storage 이벤트

---

## 커밋 메시지 템플릿

```
fix(<scope>): <한 줄 요약>

<원인 1~2 줄>
<해결 방식 1~2 줄>

Refs: .claude/AUDIT_REPORT.md <항목 ID>
```

예시:
```
fix(be): SettingsStore 동시성 — 단일 JDBC 커넥션 공유에 RLock 도입

collector/cache/Flask 워커가 같은 connection 의 cursor 를 동시에
열어 Connection is busy / ResultSet already closed 가 산발했다.
public 메서드 진입 시점에 self._lock 으로 직렬화한다.

Refs: .claude/AUDIT_REPORT.md C1
```

---

## 진행 메모 (각 세션에서 추가/갱신)

> 작업하면서 발견한 새 사실, 위 보고서가 틀린 부분, 사용자와의 합의사항을 여기에 누적.

- (2026-05-03) 보고서 작성, 코드 변경 없음. 다음 세션에서 C1 부터 시작 권장.

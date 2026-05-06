# Phase 5B — Partial Config Reload Design

**Status**: Draft (2026-05-07)
**Scope**: BE concurrency hotfix — replace nuclear `service.reload()` with item-level partial reload + integrate I-2 (JVM classpath log noise).
**Resolves**: C-2 (concurrent reload not serialized), I-2 (ERROR log every reload), I-3 (sync 2-second reload), Issue #2 (admin save UX).

## Goal

대시보드 admin 이 config 또는 monitor target 을 저장할 때, 현재 BE 가 모든 connection pool / executor / cache / monitor thread 를 **재생성** 하면서 ~2 초 동기 처리 + 변경 안 된 위젯에까지 cache miss 가 전파되어 thundering herd 형태로 동시 알람이 발생하는 문제를 제거한다.

변경된 항목만 식별해 그 항목만 적용하고, 변경 안 된 connection pool / cache / monitor thread 는 절대 건드리지 않는다.

## Motivation

현재 `service.reload()` ([service.py:365-460](../../../monigrid-be/app/service.py)) 는 어떤 종류의 변경이든 다음 작업을 모두 수행한다:

1. 모든 ThreadPoolExecutor (jdbc + monitor) drain + 재생성
2. 모든 DBConnectionPool close + 재생성
3. EndpointCacheManager `clear()` — 전체 cache 비움
4. MonitorCollectorManager `stop + clear + start` — 모든 collector thread 재생성 + 모든 target initial collection 재실행

부작용:
- 단일 admin 의 작은 config 변경 (예: connection title 한 글자 수정) 이 다른 사용자의 in-flight query 를 중단시키고 모든 위젯의 cache 를 비운다.
- Cache 가 비워진 직후 모든 client 의 polling 이 동시에 cache miss → BE 가 한 번 쿼리 (Phase 2 coalesce) → 모든 client 가 같은 timestamp 의 같은 결과 수신 → 임계치 넘으면 N 개 client 가 동시 알람.
- monitor target 이 50개라면 reload 마다 50개 thread 를 재생성하고 50개 host 에 대한 initial collection 을 동기 대기 → ~10-30 초 응답.
- 동시 reload 호출이 직렬화되지 않아 (`_reload_lock` 부재) 두 admin 이 거의 동시에 저장하면 두 reload 가 병렬 실행되며 in-memory state 가 race condition 에 노출된다.

## Architecture Overview

새 진입점 `apply_partial_config_reload(new_config_dict)` 와 `apply_monitor_targets_partial(batch_request)` 를 추가한다. 두 진입점 모두 단일 `_reload_lock` 안에서 실행된다. 기존 nuclear `reload()` 는 escape hatch 로 유지 (admin 이 explicit 으로 "fresh state" 를 원하는 경우, 예를 들어 JVM classpath 변경 후 의도적인 사용).

```
PUT /dashboard/config
  └─ service.apply_partial_config_reload(new_dict)
       └─ with self._reload_lock:
            settings_store.save_config_dict(new_dict)
            new_config = config_reloader()
            diff = compute_config_diff(old=self.config, new=new_config)
            self._apply_config_diff(diff, new_config)
            self.config = new_config
            self._check_classpath_for_reload(new_config)  # I-2

POST /dashboard/monitor-targets/batch
  └─ service.apply_monitor_targets_partial(batch_request)
       └─ with self._reload_lock:
            store_result = settings_store.apply_monitor_targets_batch(...)
            for t in store_result.created: monitor_collector.add_target(t)
            for t in store_result.updated: monitor_collector.update_target_in_place(t)
            for tid in store_result.deleted: monitor_collector.remove_target(tid)

POST /dashboard/reload-config (unchanged behavior — escape hatch)
  └─ service.reload()  # 기존 nuclear, lock 만 추가
```

### New modules

- `monigrid-be/app/config_diff.py` — `compute_config_diff(old, new) -> ConfigDiff` + `ConfigDiff` dataclass.
- `monigrid-be/app/ssh_session_pool.py` — `clear_ssh_pool_for_host(host)` 추가 (현재 `clear_ssh_pool()` 의 host-scoped 변형).

### Modified files

- `service.py` — `_reload_lock`, `apply_partial_config_reload()`, `apply_monitor_targets_partial()`, `_apply_config_diff()`, `_check_classpath_for_reload()`, 기존 `reload()` 에 lock 추가.
- `monitor_collector_manager.py` — `_stop_event` → `_stop_events: dict[str, Event]`, `_threads: list` → `_threads: dict[str, Thread]`, public `add_target/remove_target/update_target_in_place`, `_refresh_loop` 의 stop event 사용 부분.
- `routes/dashboard_routes.py` — `update_config()` 가 `backend.reload()` 대신 `backend.apply_partial_config_reload()` 호출.
- `routes/monitor_routes.py` — `monitor_targets_batch()` 가 `backend.apply_monitor_targets_partial()` 호출.

## Diff Computation

`compute_config_diff(old: AppConfig, new: AppConfig) -> ConfigDiff`:

```python
@dataclass
class ConnectionDiff:
    added: list[str]              # connection ids
    removed: list[str]
    changed_pool: list[str]       # pool-affecting fields changed
    changed_metadata: list[str]   # metadata-only fields changed

@dataclass
class ApiDiff:
    added: list[str]              # api ids
    removed: list[str]
    changed_data: list[str]       # sql/connection_id/endpoint changed
    changed_metadata: list[str]   # title/description/enabled changed

@dataclass
class GlobalDiff:
    logging_changed: bool
    auth_changed: bool
    rate_limits_changed: bool
    immutable_changed: list[str]  # thread_pool_size, server.host, server.port

@dataclass
class ConfigDiff:
    connections: ConnectionDiff
    apis: ApiDiff
    globals: GlobalDiff
```

Connection pool-affecting fields (set 으로 명시):
```python
_POOL_AFFECTING = frozenset({"jdbc_url", "username", "password", "jdbc_jars", "jdbc_driver_class", "db_type"})
_CONNECTION_METADATA = frozenset({"title", "description"})
```

API data-affecting fields:
```python
_API_DATA_AFFECTING = frozenset({"sql", "connection_id", "endpoint"})
_API_METADATA = frozenset({"title", "description", "enabled"})
```

Diff 함수는 dict comparison 으로 단순 구현. 새 field 가 추가되어 두 set 어디에도 속하지 않으면 안전하게 `changed_pool` / `changed_data` 로 분류 (보수적).

## Action Matrix

### Connection diff actions

| Diff entry | Action | Notes |
|---|---|---|
| `added` | `db_pools[id] = DBConnectionPool(max_size=DB_POOL_SIZE)` | Lazy connect (현재 동작 유지) |
| `removed` | `db_pools[id].close_all(); del db_pools[id]` | 다른 pool 영향 없음 |
| `changed_pool` | `reset_connections(id)` | 기존 함수 재사용 ([service.py:354](../../../monigrid-be/app/service.py)) |
| `changed_metadata` | `backend.config.connections[id]` swap | pool 안 건드림 |

### API diff actions

| Diff entry | Action | Notes |
|---|---|---|
| `added` | `apis[api_id] = entry` | cache 는 lazy, 첫 GET 시 채워짐 |
| `removed` | `del apis[api_id]; cache_manager.invalidate(api_id)` | 해당 cache entry 만 |
| `changed_data` | `apis[api_id]` swap + `cache_manager.invalidate(api_id)` | 다른 endpoint cache 보존 |
| `changed_metadata` | `apis[api_id]` swap | cache 보존 |

### Monitor target diff actions

settings_store.apply_monitor_targets_batch 결과의 `created/updated/deleted` 를 그대로 사용 (이미 #6 에서 구조화됨).

| Diff entry | Action | Notes |
|---|---|---|
| `created` | `monitor_collector.add_target(target)` | 새 stop_event + thread spawn + initial collection (sync, 1개) |
| `deleted` | `monitor_collector.remove_target(target_id)` | 해당 stop_event set + join(1.5s) + snapshot drop + `clear_ssh_pool_for_host(host)` |
| `updated` (schedule-only: interval/threshold/enabled) | `update_target_in_place(target)` — `_targets_by_id[id]` swap | 기존 thread 가 다음 sleep tick 후 픽업 |
| `updated` (connection-affecting: host/ssh_username/ssh_password) | `update_target_in_place(target)` + `clear_ssh_pool_for_host(target.host)` | 다음 collection 에서 새 credentials 로 재연결 |

### Global diff actions

| Field | Action |
|---|---|
| `logging.*` | `configure_logging(new.logging) + log_reader.update_logging_config(new.logging)` |
| `auth.username/password` | metadata swap (login 검증 시점에 새 값 사용) |
| `rate_limits.*` | metadata swap + WARNING "rate_limits change applied on next BE restart" (Flask-Limiter 가 데코 시점 캡처) |
| `thread_pool_size`, `server.host`, `server.port` | **Apply 안 함** + WARNING "field requires BE restart" — settings DB 에는 저장됨 |

## Monitor Collector Refactor

### State 변경

```python
# Before
self._stop_event: threading.Event = threading.Event()
self._threads: list[threading.Thread] = []

# After
self._stop_events: dict[str, threading.Event] = {}
self._threads: dict[str, threading.Thread] = {}
```

### `_refresh_loop(target_id)` 변경

```python
def _refresh_loop(self, target_id: str) -> None:
    stop_event = self._stop_events.get(target_id)
    if stop_event is None:
        return  # spawn 직후 remove 된 race
    while not stop_event.is_set():
        ...existing collection logic...
        if stop_event.wait(timeout=interval): break
```

### Public API

```python
def add_target(self, target: dict) -> None:
    """Spawn collector thread for a new target. Synchronously runs initial collection."""
    target_id = target["id"]
    with self._targets_lock:
        self._targets_by_id[target_id] = target
        self._snapshots[target_id] = _initial_snapshot(target)
    if not target.get("enabled", True):
        return
    # Initial collection (sync, 1 target)
    try:
        self._collect_target(target, "add")
    except Exception:
        self._logger.exception("Initial collection failed targetId=%s", target_id)
    # Spawn refresh loop
    stop_event = threading.Event()
    self._stop_events[target_id] = stop_event
    thread = threading.Thread(
        target=self._refresh_loop, args=(target_id,),
        name=f"monitor-collect-{target_id}", daemon=True,
    )
    self._threads[target_id] = thread
    thread.start()

def remove_target(self, target_id: str) -> None:
    """Stop collector thread for a deleted target. Drains its SSH session."""
    stop_event = self._stop_events.pop(target_id, None)
    thread = self._threads.pop(target_id, None)
    if stop_event is not None:
        stop_event.set()
    if thread is not None:
        thread.join(timeout=1.5)
    with self._targets_lock:
        target = self._targets_by_id.pop(target_id, None)
    with self._snapshot_lock:
        self._snapshots.pop(target_id, None)
    if target is not None:
        host = target.get("host")
        if host:
            clear_ssh_pool_for_host(host)

def update_target_in_place(self, target: dict, *, ssh_credentials_changed: bool = False) -> None:
    """Mutate _targets_by_id[id]. Existing thread picks up changes on next sleep."""
    target_id = target["id"]
    with self._targets_lock:
        self._targets_by_id[target_id] = target
    if ssh_credentials_changed:
        host = target.get("host")
        if host:
            clear_ssh_pool_for_host(host)
```

`stop()` 은 모든 stop_events 를 set + 모든 thread join. `start()` 는 각 target 마다 add_target 호출 (또는 fast path 로 init 시 일괄 spawn).

### SSH session pool host-scoped drain

`monigrid-be/app/ssh_session_pool.py` 에 신규 함수:

```python
def clear_ssh_pool_for_host(host: str) -> None:
    """Drain SSH sessions for a single host. Other hosts unaffected."""
    with _pool_lock:
        keys_to_remove = [k for k in _sessions.keys() if k.host == host]
        for key in keys_to_remove:
            session = _sessions.pop(key, None)
            if session is not None:
                try: session.close()
                except Exception: pass
```

기존 `clear_ssh_pool()` 은 그대로 둠 (full reload escape hatch 가 사용).

## Concurrency Model

### Single reload lock

```python
# service.py __init__
self._reload_lock = threading.Lock()
```

다음 메서드가 모두 이 lock 안에서 실행:
- `apply_partial_config_reload(new_config_dict)` — 새 진입점
- `apply_monitor_targets_partial(batch_request)` — 새 진입점
- `reload()` — 기존 nuclear, lock 만 추가

`settings_store.save_config_dict()` 는 자체 `@_sync` lock 보유. 두 lock 은 nested 가능 (같은 thread). dead-lock 위험 없음.

### Lock 의 보장

1. 두 admin 동시 저장 → 두 번째는 첫 번째 끝날 때까지 wait. partial reload 가 ms 단위라 부담 없음.
2. `compute_config_diff(old, new)` 가 보는 `old` 가 다른 thread 에 의해 mutate 될 가능성 차단.
3. `apply_partial_config_reload` 와 `apply_monitor_targets_partial` 도 서로 직렬화 → config 변경과 monitor target 변경이 절대 인터리브 되지 않음.
4. 기존 nuclear `reload()` 도 직렬화 → C-2 자동 해결.

### Lock 밖에서 실행되는 작업

- `monitor_collector._refresh_loop(target_id)` — 각 target 의 collection 사이클은 lock 과 무관. lock 안에서 실행되는 `_targets_by_id[id]` mutation 만 보호되면 충분 (존재하는 `_targets_lock`).
- `db_pools[id]` 의 `borrow/return` — pool 내부 lock. reload lock 과 무관.

## JVM Classpath Logging (I-2)

### Before

```python
# service.py reload() 안
missing_jars = jvm_classpath_missing(new_jars)
if missing_jars:
    self.logger.error("Reload introduced JDBC jars not on the running JVM classpath ... missing=%s", missing_jars)
```

매 reload 마다 ERROR 로그 → alert fatigue.

### After

`__init__` 에서 1회:
```python
def __init__(self, ...):
    ...
    self._known_missing_jars: set[str] = set()
    self._log_loaded_jdbc_drivers()  # INFO 1줄

def _log_loaded_jdbc_drivers(self) -> None:
    all_jars = ...  # initial config 의 모든 jar
    self.logger.info("Loaded JDBC drivers: %d jars", len(all_jars))
    initial_missing = set(jvm_classpath_missing(all_jars))
    if initial_missing:
        self.logger.info("JDBC jars not on classpath (will be ignored on reload): %s", sorted(initial_missing))
        self._known_missing_jars |= initial_missing
```

reload 시:
```python
def _check_classpath_for_reload(self, new_config: AppConfig) -> None:
    new_jars = list(dict.fromkeys(jar for conn in new_config.connections.values() for jar in conn.jdbc_jars))
    current_missing = set(jvm_classpath_missing(new_jars))
    newly_missing = current_missing - self._known_missing_jars
    if newly_missing:
        self.logger.warning(
            "JDBC jars not on classpath — queries against the new connections will fail until BE restart. newly_missing=%s",
            sorted(newly_missing),
        )
        self._known_missing_jars |= newly_missing
```

결과: 부팅 시 INFO 1회. 운영자가 새 connection (새 jar) 추가 시 새로 누락된 jar 만 WARNING 1회. 이미 알려진 누락 jar 는 silent.

## Routes & Backwards Compatibility

| Route | 변경 후 동작 |
|---|---|
| `PUT /dashboard/config` | `apply_partial_config_reload()` 호출. 응답 shape 변경 (아래 참조). 기존 client 와 호환되도록 `saved`, `reloaded`, `endpointCount`, `connectionCount` 필드는 유지. |
| `POST /dashboard/reload-config` | 기존 `backend.reload()` 그대로. **응답 shape 변경 없음**. (escape hatch 보존) |
| `POST /dashboard/monitor-targets/batch` | `apply_monitor_targets_partial()` 호출. 기존 응답 shape (`created/updated/deleted/failed`) + 신규 `applied/skipped/errors` 도 추가. |
| `POST/PUT/DELETE /dashboard/monitor-targets[/<id>]` | 단일 항목 라우트도 partial 경로로 통합 (내부적으로 1개짜리 batch 로 wrap). |

### Response shape (PUT /dashboard/config)

```json
{
  "saved": true,
  "reloaded": true,
  "endpointCount": 2,
  "connectionCount": 1,
  "applied": [
    {"resource": "connection", "id": "mariadb-main", "action": "metadata_swap"},
    {"resource": "api", "id": "status", "action": "data_changed"}
  ],
  "skipped": [
    {"resource": "global", "field": "thread_pool_size", "reason": "requires_restart"}
  ],
  "errors": []
}
```

HTTP status: errors 배열 비어있으면 200, 비어있지 않으면 207 Multi-Status.

## Error Handling

**Best-effort apply, no rollback.**

이유: in-memory mutation 이 일부 성공·일부 실패한 경우, 이미 수행한 mutation 을 되돌리는 코드는 본 mutation 코드만큼 복잡해지고 자체 버그 위험이 더 큼. settings DB 의 batch transaction 은 원자성 보장 (이미 #6 의 `apply_monitor_targets_batch` 가 보유). in-memory apply 는:

1. 항목별 try/except 로 감쌈
2. 실패한 항목은 `errors` 배열에 추가, 다른 항목은 계속 진행
3. settings DB 와 in-memory state 가 잠시 불일치할 수 있으나 (예: 새 connection 이 DB 에는 있는데 pool 생성 실패), 다음 BE restart 시 자동 복구 (init 시 모든 pool 생성)
4. errors 배열은 FE 에 전달 → 사용자가 부분 실패 인지 가능

## Testing Strategy

5A 회귀 테스트 인프라 미도입 상태이므로 **ad-hoc 스크립트 + 수동 smoke test plan** 으로 검증한다.

### Ad-hoc 스크립트

`monigrid-be/scripts/test_partial_reload.py` (새 파일) — 실행 가능한 단일 Python 스크립트:

```python
# 시나리오 1: connection title 만 수정 → pool 안 닫힘
old_pool_id = id(backend.db_pools["mariadb-main"])
PUT /dashboard/config { ...connections[0].title = "new title"... }
assert id(backend.db_pools["mariadb-main"]) == old_pool_id

# 시나리오 2: API SQL 수정 → 그 endpoint cache 만 invalidate
GET /api/status (warm cache)
GET /api/monigrid_sql_queries (warm cache)
PUT /dashboard/config { ...apis[status].sql = "SELECT 1"... }
assert cache_manager.has("status") == False
assert cache_manager.has("monigrid_sql_queries") == True  # 보존

# 시나리오 3: monitor target 임계치 수정 → thread 안 재생성
old_thread_ids = {tid: id(t) for tid, t in monitor_collector._threads.items()}
POST /dashboard/monitor-targets/batch { update: [{id: "t1", threshold_cpu: 90}] }
assert {tid: id(t) for tid, t in monitor_collector._threads.items()} == old_thread_ids

# 시나리오 4: 동시 2개 reload 호출 → 직렬화
import threading
results = []
def fire(): results.append(time.perf_counter()); PUT /dashboard/config; results.append(time.perf_counter())
threads = [threading.Thread(target=fire) for _ in range(2)]
for t in threads: t.start()
for t in threads: t.join()
# results 의 [start1, end1, start2, end2] 가 직렬 (start2 >= end1) 인지 확인
```

### Smoke test plan (ADMIN_MANUAL 에 추가)

`docs/ADMIN_MANUAL.md` 5-5 절 신설:
- "Phase 5B partial reload 운영 가이드"
- partial 경로 / nuclear 경로 차이
- 부분 실패 응답 (errors 배열) 해석 방법
- thread_pool_size / server.host / server.port 변경 시 BE 재시작 필요 안내
- I-2 의 INFO 로그 기준 (new jar 추가 시 WARNING 등장)

## Out of Scope (YAGNI)

이번 5B 에서 다루지 않는다:

1. **Async response + status polling** — partial reload 가 ~50ms 라 sync 응답으로 충분. 100+ target fleet 대응이 필요해지는 시점에 별도 brainstorming.
2. **회귀 테스트 인프라** — 5A 의 별도 sub-project 로 추후 도입.
3. **rate_limits hot-reload** — Flask-Limiter 가 데코 시점 캡처라 runtime 에 변경 불가능. settings DB 만 갱신, 재시작 시 적용.
4. **Per-resource granular lock (B 옵션)** — 단일 `_reload_lock` 으로 충분. 두 admin 동시 저장 시나리오가 실제로 거의 발생 안 함.
5. **WebSocket / SSE 기반 reload 알림** — admin 의 저장 후 다른 client 들에게 push 알림. 현재는 다른 client 가 다음 polling 에 자연스럽게 새 데이터 픽업 (이게 사용자 인사이트의 핵심).

## Success Criteria

- [ ] Connection title 만 수정 시 그 connection 의 pool 객체 id 가 동일 (재생성 안 됨).
- [ ] API SQL 수정 시 다른 API 의 cache 가 보존.
- [ ] Monitor target 임계치 수정 시 thread 재생성 없음.
- [ ] 동시 2개 reload 호출이 직렬화 (lock 검증).
- [ ] `apply_partial_config_reload` 평균 응답 시간 < 200ms (통상 변경 시).
- [ ] BE 부팅 시 INFO "Loaded JDBC drivers" 1회. 그 이후 reload 에서 동일 누락 jar 는 silent.
- [ ] `runtime-immutable` 필드 변경 시 WARNING 만 로그, in-memory state 변경 안 됨.
- [ ] `errors` 배열이 비어있지 않으면 HTTP 207 응답.

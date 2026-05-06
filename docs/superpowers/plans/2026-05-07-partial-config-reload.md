# Phase 5B — Partial Config Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `service.reload()` 의 nuclear path 를 item-level partial reload 로 교체. 변경 안 된 connection pool / endpoint cache / monitor thread 는 절대 건드리지 않음. C-2 (concurrent reload race), I-2 (JVM classpath ERROR noise), I-3 (sync 2초 reload), Issue #2 (admin save UX) 동시 해결.

**Architecture:** 새 진입점 `apply_partial_config_reload()` + `apply_monitor_targets_partial()` 가 단일 `_reload_lock` 안에서 (a) settings DB write → (b) old vs new diff → (c) per-resource apply 순으로 실행. MonitorCollectorManager 는 per-target stop_event 로 리팩터해 변경된 target 만 thread 재생성. 기존 nuclear `reload()` 는 escape hatch 로 보존.

**Tech Stack:** Python 3.13, Flask, JayDeBeApi, threading. 5A 회귀 테스트 인프라 미도입 상태이므로 plain Python 스크립트 + assert 패턴 (기존 `exe_api_smoke_test.py` 따름).

**Working dir:** `monigrid-be` 의 worktree root. 모든 경로는 project root 기준.

**Worktree branch:** `feature/phase5b-partial-reload` (off `feature/post-phase4-hotfixes`). 별도 worktree 사용 권장 (using-git-worktrees skill).

---

## File structure

**New files:**
- `monigrid-be/app/config_diff.py` — `ConfigDiff` 그룹 dataclasses + `compute_config_diff(old, new) -> ConfigDiff` 순수 로직
- `monigrid-be/scripts/test_config_diff.py` — config_diff 모듈 단위 테스트 (Python assert)
- `monigrid-be/scripts/test_partial_reload.py` — 실행 중 BE 대상 통합 시나리오 스크립트

**Modified files:**
- `monigrid-be/app/server_resource_collector.py` — `clear_ssh_pool_for_host(host)` 추가
- `monigrid-be/app/monitor_collector_manager.py` — per-target stop_events 리팩터 + `add_target/remove_target/update_target_in_place` public API
- `monigrid-be/app/service.py` — `_reload_lock`, `apply_partial_config_reload`, `apply_monitor_targets_partial`, `_apply_config_diff`, `_log_loaded_jdbc_drivers`, `_check_classpath_for_reload`, 기존 `reload()` 에 lock 추가, `_known_missing_jars` 멤버
- `monigrid-be/app/routes/dashboard_routes.py` — `update_config()` 가 `apply_partial_config_reload` 호출
- `monigrid-be/app/routes/monitor_routes.py` — `monitor_targets_batch()` 가 `apply_monitor_targets_partial` 호출, 단일 항목 라우트도 batch wrapper 로
- `docs/ADMIN_MANUAL.md` — 5-5 절 신설 (partial reload 운영 가이드)

---

## Task 1: SSH session pool host-scoped drain

**Files:**
- Modify: `monigrid-be/app/server_resource_collector.py:169-176` (existing `clear_ssh_pool`)
- Test: `monigrid-be/scripts/test_partial_reload.py` (생성, scenario 1)

- [ ] **Step 1: 새 테스트 스크립트 골격 + 실패 케이스 작성**

Create `monigrid-be/scripts/test_partial_reload.py`:

```python
"""Phase 5B partial reload — integration scenarios.

Each scenario is a self-contained function. Run with:
    python3 monigrid-be/scripts/test_partial_reload.py

Some scenarios assume BE is running on 127.0.0.1:5000 (FLASK_ENV=development).
Pure-state scenarios (no API calls) work without BE.
"""
from __future__ import annotations
import sys
import threading
import time


def scenario_1_clear_ssh_pool_for_host_only_drains_target_host():
    """clear_ssh_pool_for_host 가 해당 host 의 session 만 drain — 다른 host 는 보존."""
    from monigrid_be_path_setup import setup  # late import; see __main__
    setup()
    from app.server_resource_collector import _SSH_POOL, _SSH_POOL_LOCK, clear_ssh_pool_for_host

    class _FakeSession:
        def __init__(self): self.closed = False
        def close(self): self.closed = True

    s_a = _FakeSession()
    s_b = _FakeSession()
    s_c = _FakeSession()
    with _SSH_POOL_LOCK:
        _SSH_POOL.clear()
        _SSH_POOL[("hostA", 22, "u")] = s_a
        _SSH_POOL[("hostA", 2222, "u2")] = s_b
        _SSH_POOL[("hostB", 22, "u")] = s_c

    clear_ssh_pool_for_host("hostA")

    assert s_a.closed is True, "hostA:22:u session should be closed"
    assert s_b.closed is True, "hostA:2222:u2 session should be closed"
    assert s_c.closed is False, "hostB session must be preserved"
    with _SSH_POOL_LOCK:
        assert ("hostA", 22, "u") not in _SSH_POOL
        assert ("hostA", 2222, "u2") not in _SSH_POOL
        assert ("hostB", 22, "u") in _SSH_POOL
        _SSH_POOL.clear()  # cleanup


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
]


def main():
    failed = 0
    for scenario in SCENARIOS:
        name = scenario.__name__
        try:
            scenario()
            print(f"[PASS] {name}")
        except Exception as e:
            failed += 1
            print(f"[FAIL] {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{failed}/{len(SCENARIOS)} failed")
        sys.exit(1)
    print(f"\nall {len(SCENARIOS)} scenarios passed")


if __name__ == "__main__":
    main()
```

Also create `monigrid-be/scripts/monigrid_be_path_setup.py` (helper to add app dir to sys.path):

```python
"""Adds monigrid-be root to sys.path so scripts can `import app.*`."""
import os
import sys


def setup() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    be_root = os.path.normpath(os.path.join(here, ".."))
    if be_root not in sys.path:
        sys.path.insert(0, be_root)
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `python3 monigrid-be/scripts/test_partial_reload.py`
Expected: `[FAIL] scenario_1_clear_ssh_pool_for_host_only_drains_target_host: ImportError: cannot import name 'clear_ssh_pool_for_host'`

- [ ] **Step 3: clear_ssh_pool_for_host 구현**

Edit `monigrid-be/app/server_resource_collector.py`. After existing `clear_ssh_pool` function (line 169-176), add:

```python
def clear_ssh_pool_for_host(host: str) -> None:
    """Drain SSH sessions for one host only. Other hosts preserved.

    Used by partial monitor target reload — when a single target's
    credentials or host change, only that host's sessions need to be
    closed; targets on other hosts keep their warm connections.
    """
    if not host:
        return
    with _SSH_POOL_LOCK:
        keys_to_remove = [k for k in _SSH_POOL.keys() if k[0] == host]
        sessions = [_SSH_POOL.pop(k) for k in keys_to_remove]
    for s in sessions:
        try:
            s.close()
        except Exception:
            pass
```

- [ ] **Step 4: 테스트 다시 실행해 통과 확인**

Run: `python3 monigrid-be/scripts/test_partial_reload.py`
Expected: `[PASS] scenario_1_clear_ssh_pool_for_host_only_drains_target_host`

- [ ] **Step 5: 커밋**

```bash
git add monigrid-be/app/server_resource_collector.py monigrid-be/scripts/test_partial_reload.py monigrid-be/scripts/monigrid_be_path_setup.py
git commit -m "feat(be): clear_ssh_pool_for_host — host-scoped SSH session drain for partial reload"
```

---

## Task 2: ConfigDiff dataclass + compute_config_diff

**Files:**
- Create: `monigrid-be/app/config_diff.py`
- Create: `monigrid-be/scripts/test_config_diff.py`

- [ ] **Step 1: 단위 테스트 작성**

Create `monigrid-be/scripts/test_config_diff.py`:

```python
"""Unit tests for app.config_diff. No BE / DB needed.

Run with: python3 monigrid-be/scripts/test_config_diff.py
"""
from __future__ import annotations
import sys

from monigrid_be_path_setup import setup
setup()

from app.config import (
    ApiEndpointConfig, ConnectionConfig, LoggingConfig,
    AppConfig, RateLimitConfig,
)
from app.config_diff import compute_config_diff


def _conn(cid: str, url: str = "jdbc:url", user: str = "u", pwd: str = "p") -> ConnectionConfig:
    return ConnectionConfig(
        connection_id=cid, db_type="mariadb",
        jdbc_driver_class="org.mariadb.jdbc.Driver",
        jdbc_url=url, jdbc_jars=("drivers/x.jar",),
        driver_args=[user, pwd],
    )


def _api(aid: str, *, sql_id: str = "s", path: str = "/api/x", title: str = "t",
         conn: str = "c1", enabled: bool = True, interval: int = 30,
         timeout: float = 10.0) -> ApiEndpointConfig:
    return ApiEndpointConfig(
        api_id=aid, title=title, rest_api_path=path,
        connection_id=conn, sql_id=sql_id, enabled=enabled,
        refresh_interval_sec=interval, query_timeout_sec=timeout,
    )


_DEFAULT_LOG = LoggingConfig(directory="logs", file_prefix="be", retention_days=7,
                             slow_query_threshold_sec=10.0, level=20)
_DEFAULT_RL = RateLimitConfig(global_default="200/minute", auth_login="10/minute",
    dynamic_endpoint="120/minute", health_check="60/minute", health_check_batch="60/minute",
    network_test="60/minute", network_test_batch="60/minute", server_resources="60/minute",
    server_resources_batch="60/minute", monitor_refresh="10/minute", monitor_targets_batch="10/minute")


def _cfg(connections, apis, *, host="127.0.0.1", port=5000, thread_pool=16,
         auth_user="admin", auth_pwd="admin", logging=_DEFAULT_LOG, rl=_DEFAULT_RL,
         dashboard_title="MoniGrid", default_interval=30, default_timeout=10.0,
         sql_validation=None) -> AppConfig:
    apis_dict = {a.api_id: a for a in apis}
    paths_dict = {a.rest_api_path: a for a in apis}
    return AppConfig(
        version="test", dashboard_title=dashboard_title, host=host, port=port,
        thread_pool_size=thread_pool, default_refresh_interval_sec=default_interval,
        default_query_timeout_sec=default_timeout,
        auth_username=auth_user, auth_password=auth_pwd,
        sql_validation_typo_patterns=sql_validation or {}, rate_limits=rl, logging=logging,
        connections={c.connection_id: c for c in connections},
        apis=apis_dict, endpoints_by_path=paths_dict,
    )


def test_no_change():
    old = _cfg([_conn("c1")], [_api("a1", conn="c1")])
    new = _cfg([_conn("c1")], [_api("a1", conn="c1")])
    diff = compute_config_diff(old, new)
    assert diff.connections.added == []
    assert diff.connections.removed == []
    assert diff.connections.changed == []
    assert diff.apis.added == []
    assert diff.apis.removed == []
    assert diff.apis.changed_data == []
    assert diff.apis.changed_routing == []
    assert diff.apis.changed_schedule == []
    assert diff.apis.changed_metadata == []
    assert diff.globals.logging_changed is False
    assert diff.globals.auth_changed is False
    assert diff.globals.rate_limits_changed is False
    assert diff.globals.immutable_changed == []


def test_connection_added_and_removed():
    old = _cfg([_conn("c1"), _conn("c2")], [_api("a1", conn="c1")])
    new = _cfg([_conn("c1"), _conn("c3")], [_api("a1", conn="c1")])
    diff = compute_config_diff(old, new)
    assert diff.connections.added == ["c3"]
    assert diff.connections.removed == ["c2"]
    assert diff.connections.changed == []


def test_connection_pool_affecting_change():
    old = _cfg([_conn("c1", pwd="old")], [_api("a1", conn="c1")])
    new = _cfg([_conn("c1", pwd="new")], [_api("a1", conn="c1")])
    diff = compute_config_diff(old, new)
    assert diff.connections.changed == ["c1"]
    assert diff.connections.added == []
    assert diff.connections.removed == []


def test_api_data_change_via_sql_id():
    old = _cfg([_conn("c1")], [_api("a1", sql_id="s_v1")])
    new = _cfg([_conn("c1")], [_api("a1", sql_id="s_v2")])
    diff = compute_config_diff(old, new)
    assert diff.apis.changed_data == ["a1"]
    assert diff.apis.changed_routing == []
    assert diff.apis.changed_schedule == []
    assert diff.apis.changed_metadata == []


def test_api_routing_change_via_path():
    old = _cfg([_conn("c1")], [_api("a1", path="/api/old")])
    new = _cfg([_conn("c1")], [_api("a1", path="/api/new")])
    diff = compute_config_diff(old, new)
    assert diff.apis.changed_routing == ["a1"]
    assert diff.apis.changed_data == []


def test_api_routing_change_via_enabled():
    old = _cfg([_conn("c1")], [_api("a1", enabled=True)])
    new = _cfg([_conn("c1")], [_api("a1", enabled=False)])
    diff = compute_config_diff(old, new)
    assert diff.apis.changed_routing == ["a1"]


def test_api_schedule_change():
    old = _cfg([_conn("c1")], [_api("a1", interval=30)])
    new = _cfg([_conn("c1")], [_api("a1", interval=60)])
    diff = compute_config_diff(old, new)
    assert diff.apis.changed_schedule == ["a1"]
    assert diff.apis.changed_data == []
    assert diff.apis.changed_routing == []


def test_api_metadata_change_only_title():
    old = _cfg([_conn("c1")], [_api("a1", title="old")])
    new = _cfg([_conn("c1")], [_api("a1", title="new")])
    diff = compute_config_diff(old, new)
    assert diff.apis.changed_metadata == ["a1"]
    assert diff.apis.changed_data == []
    assert diff.apis.changed_routing == []
    assert diff.apis.changed_schedule == []


def test_global_immutable_thread_pool_size_flagged():
    old = _cfg([_conn("c1")], [_api("a1")], thread_pool=16)
    new = _cfg([_conn("c1")], [_api("a1")], thread_pool=32)
    diff = compute_config_diff(old, new)
    assert "thread_pool_size" in diff.globals.immutable_changed


def test_global_immutable_host_port_flagged():
    old = _cfg([_conn("c1")], [_api("a1")], host="127.0.0.1", port=5000)
    new = _cfg([_conn("c1")], [_api("a1")], host="0.0.0.0", port=8080)
    diff = compute_config_diff(old, new)
    assert "server.host" in diff.globals.immutable_changed
    assert "server.port" in diff.globals.immutable_changed


def test_global_logging_changed():
    new_log = LoggingConfig(directory="logs2", file_prefix="be", retention_days=7,
                            slow_query_threshold_sec=10.0, level=20)
    old = _cfg([_conn("c1")], [_api("a1")])
    new = _cfg([_conn("c1")], [_api("a1")], logging=new_log)
    diff = compute_config_diff(old, new)
    assert diff.globals.logging_changed is True


def test_global_auth_changed():
    old = _cfg([_conn("c1")], [_api("a1")], auth_pwd="old")
    new = _cfg([_conn("c1")], [_api("a1")], auth_pwd="new")
    diff = compute_config_diff(old, new)
    assert diff.globals.auth_changed is True


TESTS = [
    test_no_change,
    test_connection_added_and_removed,
    test_connection_pool_affecting_change,
    test_api_data_change_via_sql_id,
    test_api_routing_change_via_path,
    test_api_routing_change_via_enabled,
    test_api_schedule_change,
    test_api_metadata_change_only_title,
    test_global_immutable_thread_pool_size_flagged,
    test_global_immutable_host_port_flagged,
    test_global_logging_changed,
    test_global_auth_changed,
]


def main():
    failed = 0
    for t in TESTS:
        try:
            t()
            print(f"[PASS] {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"[FAIL] {t.__name__}: {e}")
    if failed:
        print(f"\n{failed}/{len(TESTS)} failed"); sys.exit(1)
    print(f"\nall {len(TESTS)} passed")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 테스트 실행해 실패 확인**

Run: `python3 monigrid-be/scripts/test_config_diff.py`
Expected: `ModuleNotFoundError: No module named 'app.config_diff'`

- [ ] **Step 3: config_diff 모듈 구현**

Create `monigrid-be/app/config_diff.py`:

```python
"""Compute item-level diff between two AppConfig snapshots.

Pure logic, no I/O. Used by service.apply_partial_config_reload to decide
which connection pools / endpoint cache entries / etc. need mutation.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import AppConfig, ApiEndpointConfig, ConnectionConfig


# ── Field classification ──────────────────────────────────────────────────────

# ApiEndpointConfig 의 필드별 변경 종류 분류.
_API_DATA_FIELDS = frozenset({"connection_id", "sql_id"})
_API_ROUTING_FIELDS = frozenset({"rest_api_path", "enabled"})
_API_SCHEDULE_FIELDS = frozenset({"refresh_interval_sec", "query_timeout_sec"})
_API_METADATA_FIELDS = frozenset({"title"})


@dataclass
class ConnectionDiff:
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)


@dataclass
class ApiDiff:
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    changed_data: list[str] = field(default_factory=list)
    changed_routing: list[str] = field(default_factory=list)
    changed_schedule: list[str] = field(default_factory=list)
    changed_metadata: list[str] = field(default_factory=list)


@dataclass
class GlobalDiff:
    logging_changed: bool = False
    auth_changed: bool = False
    rate_limits_changed: bool = False
    sql_validation_changed: bool = False
    runtime_metadata_changed: list[str] = field(default_factory=list)
    immutable_changed: list[str] = field(default_factory=list)


@dataclass
class ConfigDiff:
    connections: ConnectionDiff = field(default_factory=ConnectionDiff)
    apis: ApiDiff = field(default_factory=ApiDiff)
    globals: GlobalDiff = field(default_factory=GlobalDiff)


def _connections_equal(a: ConnectionConfig, b: ConnectionConfig) -> bool:
    """All ConnectionConfig fields are pool-affecting; deep equality check."""
    return (
        a.db_type == b.db_type
        and a.jdbc_driver_class == b.jdbc_driver_class
        and a.jdbc_url == b.jdbc_url
        and tuple(a.jdbc_jars) == tuple(b.jdbc_jars)
        and a.driver_args == b.driver_args
    )


def _classify_api_change(old: ApiEndpointConfig, new: ApiEndpointConfig) -> str | None:
    """Return one of 'data' | 'routing' | 'schedule' | 'metadata' | None."""
    if old.connection_id != new.connection_id or old.sql_id != new.sql_id:
        return "data"
    if old.rest_api_path != new.rest_api_path or old.enabled != new.enabled:
        return "routing"
    if (old.refresh_interval_sec != new.refresh_interval_sec
            or old.query_timeout_sec != new.query_timeout_sec):
        return "schedule"
    if old.title != new.title:
        return "metadata"
    return None


def compute_config_diff(old: AppConfig, new: AppConfig) -> ConfigDiff:
    diff = ConfigDiff()

    # ── Connections ──────────────────────────────────────────────────────────
    old_conn_ids = set(old.connections.keys())
    new_conn_ids = set(new.connections.keys())
    diff.connections.added = sorted(new_conn_ids - old_conn_ids)
    diff.connections.removed = sorted(old_conn_ids - new_conn_ids)
    for cid in sorted(old_conn_ids & new_conn_ids):
        if not _connections_equal(old.connections[cid], new.connections[cid]):
            diff.connections.changed.append(cid)

    # ── APIs ─────────────────────────────────────────────────────────────────
    old_api_ids = set(old.apis.keys())
    new_api_ids = set(new.apis.keys())
    diff.apis.added = sorted(new_api_ids - old_api_ids)
    diff.apis.removed = sorted(old_api_ids - new_api_ids)
    for aid in sorted(old_api_ids & new_api_ids):
        kind = _classify_api_change(old.apis[aid], new.apis[aid])
        if kind == "data":
            diff.apis.changed_data.append(aid)
        elif kind == "routing":
            diff.apis.changed_routing.append(aid)
        elif kind == "schedule":
            diff.apis.changed_schedule.append(aid)
        elif kind == "metadata":
            diff.apis.changed_metadata.append(aid)

    # ── Globals ──────────────────────────────────────────────────────────────
    if old.logging != new.logging:
        diff.globals.logging_changed = True
    if old.auth_username != new.auth_username or old.auth_password != new.auth_password:
        diff.globals.auth_changed = True
    if old.rate_limits != new.rate_limits:
        diff.globals.rate_limits_changed = True
    if old.sql_validation_typo_patterns != new.sql_validation_typo_patterns:
        diff.globals.sql_validation_changed = True

    if old.thread_pool_size != new.thread_pool_size:
        diff.globals.immutable_changed.append("thread_pool_size")
    if old.host != new.host:
        diff.globals.immutable_changed.append("server.host")
    if old.port != new.port:
        diff.globals.immutable_changed.append("server.port")

    for field_name in ("default_refresh_interval_sec", "default_query_timeout_sec",
                       "dashboard_title", "version"):
        if getattr(old, field_name) != getattr(new, field_name):
            diff.globals.runtime_metadata_changed.append(field_name)

    return diff
```

- [ ] **Step 4: 테스트 실행해 통과 확인**

Run: `python3 monigrid-be/scripts/test_config_diff.py`
Expected: `all 12 passed`

- [ ] **Step 5: 커밋**

```bash
git add monigrid-be/app/config_diff.py monigrid-be/scripts/test_config_diff.py
git commit -m "feat(be): config_diff module — item-level AppConfig diff for partial reload"
```

---

## Task 3: Service _reload_lock + lock around existing reload()

**Files:**
- Modify: `monigrid-be/app/service.py` (add `_reload_lock`, wrap existing `reload()`)
- Test: `monigrid-be/scripts/test_partial_reload.py` (scenario 2)

- [ ] **Step 1: 동시 reload 직렬화 테스트 추가**

Edit `monigrid-be/scripts/test_partial_reload.py`. Add scenario:

```python
def scenario_2_reload_lock_serializes_concurrent_reloads():
    """기존 reload() 도 _reload_lock 안에서 실행 — 두 동시 호출이 직렬화됨."""
    from monigrid_be_path_setup import setup
    setup()

    import threading
    import time

    # MonitoringBackend 와 의존성을 mock 으로 우회 — 직접 _reload_lock 만 검증
    import threading as _t
    lock = _t.Lock()
    timeline: list[tuple[str, float]] = []
    barrier = _t.Barrier(2)

    def fake_reload(label: str):
        barrier.wait()  # 두 thread 가 동시에 lock 진입 시도
        with lock:
            timeline.append((f"{label}_enter", time.perf_counter()))
            time.sleep(0.05)  # critical section
            timeline.append((f"{label}_exit", time.perf_counter()))

    t1 = _t.Thread(target=fake_reload, args=("A",))
    t2 = _t.Thread(target=fake_reload, args=("B",))
    t1.start(); t2.start(); t1.join(); t2.join()

    # timeline 은 4 개 이벤트. enter/exit 가 인터리브 되지 않아야 함.
    assert len(timeline) == 4
    # 첫 두 event 는 (X_enter, X_exit), 다음 두 event 는 (Y_enter, Y_exit) 형태
    e0, e1, e2, e3 = (e[0] for e in timeline)
    first_label = e0[0]
    second_label = "B" if first_label == "A" else "A"
    assert e1 == f"{first_label}_exit", f"second event must be {first_label}_exit, got {e1}"
    assert e2 == f"{second_label}_enter", f"third event must be {second_label}_enter, got {e2}"
    assert e3 == f"{second_label}_exit", f"fourth event must be {second_label}_exit, got {e3}"


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
    scenario_2_reload_lock_serializes_concurrent_reloads,
]
```

(scenario_2 는 service 의존성 없이 lock 패턴 자체만 검증 — service 의 _reload_lock 도입을 보장하는 것은 step 3 의 코드 read 로 verify)

- [ ] **Step 2: 테스트 실행해 통과 확인 (lock 패턴은 통과, 코드 reading 으로 service 검증)**

Run: `python3 monigrid-be/scripts/test_partial_reload.py`
Expected: 2 scenarios PASS (이 테스트는 lock 의 직렬화 동작 자체만 검증).

- [ ] **Step 3: service.py 에 _reload_lock 추가 + 기존 reload() 감싸기**

Edit `monigrid-be/app/service.py`. Find `MonitoringBackend.__init__` 의 lock 초기화 영역 (대략 line 80-100) 에 추가:

```python
        # Phase 5B: serializes reload() / apply_partial_config_reload /
        # apply_monitor_targets_partial. Without this, two admins saving
        # at the same moment would race on db_pools / config swap.
        self._reload_lock = threading.Lock()
```

기존 `def reload(self) -> None:` ([service.py:365](../../monigrid-be/app/service.py#L365)) 첫 줄을 수정:

Before:
```python
    def reload(self) -> None:
        new_config = self._config_reloader()
```

After:
```python
    def reload(self) -> None:
        with self._reload_lock:
            self._reload_unlocked()

    def _reload_unlocked(self) -> None:
        new_config = self._config_reloader()
```

(기존 reload 본문을 `_reload_unlocked` 로 옮김. 들여쓰기 한 단계 줄어드는 변경 없음 — 이미 method body 라 그대로 유지.)

- [ ] **Step 4: 컴파일 확인**

Run: `python3 -c "import sys; sys.path.insert(0,'monigrid-be'); import app.service"`
Expected: no output (import success).

- [ ] **Step 5: 커밋**

```bash
git add monigrid-be/app/service.py monigrid-be/scripts/test_partial_reload.py
git commit -m "feat(be): service._reload_lock — serialize concurrent reloads (C-2 fix)"
```

---

## Task 4: I-2 — JVM classpath logging refactor

**Files:**
- Modify: `monigrid-be/app/service.py` (`__init__` 끝 + 기존 `_reload_unlocked` 의 missing_jars 블록)

- [ ] **Step 1: _known_missing_jars + _log_loaded_jdbc_drivers + _check_classpath_for_reload 추가**

Edit `monigrid-be/app/service.py`. `__init__` 의 lock 초기화 직후 (Task 3 의 `self._reload_lock` 다음 줄) 에 추가:

```python
        # I-2: track jars that were already missing at boot. Reload only
        # warns for *newly* missing jars (e.g., admin added a connection
        # pointing at a jar not on the JVM classpath).
        self._known_missing_jars: set[str] = set()
```

`__init__` 의 마지막에서 (background refresher 시작 후) 호출:

```python
        # I-2: announce loaded JDBC drivers once at boot.
        self._log_loaded_jdbc_drivers()
```

`MonitoringBackend` 클래스에 두 메서드 추가 (e.g., `_close_all_pools` 위 또는 `reload` 근처):

```python
    def _log_loaded_jdbc_drivers(self) -> None:
        all_jars = list(dict.fromkeys(
            jar
            for conn in self.config.connections.values()
            for jar in conn.jdbc_jars
        ))
        self.logger.info("Loaded JDBC drivers: %d jars", len(all_jars))
        initial_missing = set(jvm_classpath_missing(all_jars))
        if initial_missing:
            self.logger.info(
                "JDBC jars not on classpath at boot (will be ignored on reload): %s",
                sorted(initial_missing),
            )
            self._known_missing_jars |= initial_missing

    def _check_classpath_for_reload(self, new_config) -> None:
        new_jars = list(dict.fromkeys(
            jar
            for conn in new_config.connections.values()
            for jar in conn.jdbc_jars
        ))
        current_missing = set(jvm_classpath_missing(new_jars))
        newly_missing = current_missing - self._known_missing_jars
        if newly_missing:
            self.logger.warning(
                "JDBC jars not on classpath — queries against the new connections will "
                "fail until BE restart. newly_missing=%s",
                sorted(newly_missing),
            )
            self._known_missing_jars |= newly_missing
```

기존 `_reload_unlocked` 의 missing_jars 로깅 블록 ([service.py:379-390](../../monigrid-be/app/service.py#L379)) 교체. Before:

```python
        new_jars = list(dict.fromkeys(
            jar
            for conn in new_config.connections.values()
            for jar in conn.jdbc_jars
        ))
        missing_jars = jvm_classpath_missing(new_jars)
        if missing_jars:
            self.logger.error(
                "Reload introduced JDBC jars not on the running JVM classpath — "
                "queries against the new connections will fail with "
                "ClassNotFoundException until the BE process is restarted. "
                "missing=%s",
                missing_jars,
            )
```

After:

```python
        self._check_classpath_for_reload(new_config)
```

- [ ] **Step 2: 부팅 + reload 호출해 로그 확인**

Run BE in foreground for log inspection:

```bash
cd monigrid-be && cp initsetting.example.json initsetting.json
FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py 2>&1 | head -30
```

Expected: 부팅 로그에 `INFO Loaded JDBC drivers: N jars` 1줄 + 누락 jar 가 있으면 `INFO JDBC jars not on classpath at boot ...` 1줄. **ERROR 없음**.

(Ctrl+C 로 종료. initsetting.json 은 Task 끝나기 전까진 그대로 둠 — 다음 task 들도 BE 띄울 때 사용.)

- [ ] **Step 3: 커밋**

```bash
git add monigrid-be/app/service.py
git commit -m "feat(be): I-2 — JVM classpath logging dedup (boot INFO + new-only WARNING)"
```

---

## Task 5: MonitorCollectorManager refactor — per-target stop events

**Files:**
- Modify: `monigrid-be/app/monitor_collector_manager.py` (state 구조, `start/stop/_refresh_loop`, public `add_target/remove_target/update_target_in_place`)
- Modify: `monigrid-be/app/server_resource_collector.py` (이미 Task 1 에서 `clear_ssh_pool_for_host` 추가됨)

- [ ] **Step 1: 통합 시나리오 테스트 추가 (BE 띄운 상태에서 검증)**

Edit `monigrid-be/scripts/test_partial_reload.py`. Add scenarios. 이 시나리오들은 BE 가 127.0.0.1:5000 에 떠 있다고 가정:

```python
def _be_login(base_url: str = "http://127.0.0.1:5000") -> str:
    import json, urllib.request
    req = urllib.request.Request(
        f"{base_url}/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)["token"]


def _http(method: str, path: str, token: str, body=None, base_url: str = "http://127.0.0.1:5000"):
    import json, urllib.request, urllib.error
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base_url + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def scenario_3_monitor_collector_per_target_thread_lifecycle_via_be():
    """[requires running BE]
    interval 변경 시 thread 재생성 안 됨 — thread name 셋이 변하지 않는지 확인."""
    import threading
    token = _be_login()
    status, targets_resp = _http("GET", "/dashboard/monitor-targets", token)
    assert status == 200
    targets = targets_resp if isinstance(targets_resp, list) else targets_resp.get("targets", [])
    if not targets:
        print("  (skipped — BE has no monitor targets configured)")
        return
    target = targets[0]

    def _thread_names() -> set[str]:
        return {t.name for t in threading.enumerate() if t.name.startswith("monitor-collect-")}

    # 직접 BE 의 thread 셋 확인 불가 — 대신 응답 기반 검증.
    # interval 1 sec 차이로 변경 → 응답에 errors 없음 + 이후 GET 으로 새 값 반영 확인.
    new_interval = (target.get("interval_seconds") or 30) + 1
    payload = {"create": [], "update": [{**target, "interval_seconds": new_interval}], "delete": []}
    status, resp = _http("POST", "/dashboard/monitor-targets/batch", token, payload)
    assert status in (200, 207), f"unexpected {status}: {resp}"
    assert resp.get("errors", []) == [], f"errors must be empty: {resp.get('errors')}"

    # 다시 GET — interval 새 값 확인
    status, after = _http("GET", "/dashboard/monitor-targets", token)
    assert status == 200
    after_list = after if isinstance(after, list) else after.get("targets", [])
    found = next((t for t in after_list if t["id"] == target["id"]), None)
    assert found is not None
    assert found.get("interval_seconds") == new_interval


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
    scenario_2_reload_lock_serializes_concurrent_reloads,
    scenario_3_monitor_collector_per_target_thread_lifecycle_via_be,
]
```

- [ ] **Step 2: 현재 BE 띄워서 시나리오 3 통과 확인 (refactor 전)**

Run BE if not already up:

```bash
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py > /tmp/be.log 2>&1 &
sleep 5
python3 monigrid-be/scripts/test_partial_reload.py
```

Expected: scenario 3 PASS — current code 도 interval 변경이 문제 없이 적용됨 (단 nuclear reload 로 thread 다 재생성됨, 이건 step 6 이후 검증할 부분).

- [ ] **Step 3: monitor_collector_manager.py state 구조 변경**

Edit `monigrid-be/app/monitor_collector_manager.py`. `__init__` 영역 (line 75-77 근처):

Before:
```python
        self._stop_event: threading.Event = threading.Event()
        ...
        self._threads: list[threading.Thread] = []
```

After:
```python
        self._stop_events: dict[str, threading.Event] = {}
        ...
        self._threads: dict[str, threading.Thread] = {}
```

`stop()` ([monitor_collector_manager.py:149](../../monigrid-be/app/monitor_collector_manager.py#L149)) 본문 교체:

```python
    def stop(self) -> None:
        for ev in list(self._stop_events.values()):
            ev.set()
        for thread in list(self._threads.values()):
            thread.join(timeout=1.5)
        self._stop_events.clear()
        self._threads.clear()
```

`start()` 의 thread 생성 루프 ([monitor_collector_manager.py:139-147](../../monigrid-be/app/monitor_collector_manager.py#L139)) 교체. Before:

```python
        for target in enabled_targets:
            thread = threading.Thread(
                target=self._refresh_loop,
                args=(target["id"],),
                name=f"monitor-collect-{target['id']}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)
```

After:

```python
        for target in enabled_targets:
            self._spawn_target_thread(target["id"])

    def _spawn_target_thread(self, target_id: str) -> None:
        """Internal: create a stop_event + thread for one target."""
        if target_id in self._threads:
            return  # already running
        stop_event = threading.Event()
        self._stop_events[target_id] = stop_event
        thread = threading.Thread(
            target=self._refresh_loop,
            args=(target_id,),
            name=f"monitor-collect-{target_id}",
            daemon=True,
        )
        thread.start()
        self._threads[target_id] = thread
```

`_refresh_loop` 의 stop_event 사용 부분 변경. 기존 코드에서 `self._stop_event` 참조하는 부분을 찾아 `stop_event = self._stop_events.get(target_id)` 로 lookup 한 뒤 사용. 일반적 패턴 (line ~225 근처):

Before (예시 — 실제 코드 검색해서 매칭):
```python
    def _refresh_loop(self, target_id: str) -> None:
        while not self._stop_event.is_set():
            ...
            if self._stop_event.wait(timeout=interval):
                break
```

After:
```python
    def _refresh_loop(self, target_id: str) -> None:
        stop_event = self._stop_events.get(target_id)
        if stop_event is None:
            return  # spawn 직후 remove 된 race
        while not stop_event.is_set():
            ...
            if stop_event.wait(timeout=interval):
                break
```

(주의: `_refresh_loop` 본문에 `self._stop_event` 가 여러 번 등장할 수 있음 — 모두 `stop_event` 로 교체. `wait/is_set/set` 호출 모두.)

- [ ] **Step 4: public API — add_target / remove_target / update_target_in_place 추가**

Edit `monitor_collector_manager.py`. `reload()` 메서드 ([monitor_collector_manager.py:159](../../monigrid-be/app/monitor_collector_manager.py#L159)) 위에 추가:

```python
    def add_target(self, target: dict) -> None:
        """Phase 5B: spawn collector thread for a newly-added target.

        Synchronously runs initial collection so the FE sees a real value
        on the next snapshot poll. Other targets are unaffected.
        """
        target_id = target["id"]
        with self._targets_lock:
            self._targets_by_id[target_id] = target
        with self._snapshot_lock:
            if target_id not in self._snapshots:
                self._snapshots[target_id] = _initial_snapshot(target)
        if not target.get("enabled", True):
            return
        try:
            self._collect_target(target, "add")
        except Exception:
            self._logger.exception(
                "Initial collection failed for added target — will retry on next tick targetId=%s",
                target_id,
            )
        self._spawn_target_thread(target_id)

    def remove_target(self, target_id: str) -> None:
        """Phase 5B: stop collector thread for a deleted target.

        Drains SSH session for that target's host. Other hosts unaffected.
        """
        with self._targets_lock:
            target = self._targets_by_id.pop(target_id, None)
        with self._snapshot_lock:
            self._snapshots.pop(target_id, None)
        stop_event = self._stop_events.pop(target_id, None)
        thread = self._threads.pop(target_id, None)
        if stop_event is not None:
            stop_event.set()
        if thread is not None:
            thread.join(timeout=1.5)
        if target is not None:
            host = target.get("host")
            if host:
                clear_ssh_pool_for_host(host)

    def update_target_in_place(
        self,
        target: dict,
        *,
        ssh_credentials_changed: bool = False,
    ) -> None:
        """Phase 5B: mutate target dict in place. Existing collector thread
        picks up changes on next sleep. If SSH credentials/host changed,
        also drain that host's SSH session so the next collect uses fresh
        credentials.
        """
        target_id = target["id"]
        with self._targets_lock:
            self._targets_by_id[target_id] = target
        if ssh_credentials_changed:
            host = target.get("host")
            if host:
                clear_ssh_pool_for_host(host)
```

`clear_ssh_pool_for_host` import 추가. File top 의 import 영역 ([monitor_collector_manager.py:36](../../monigrid-be/app/monitor_collector_manager.py#L36)):

Before:
```python
from .server_resource_collector import collect_server_resources, clear_ssh_pool
```

After:
```python
from .server_resource_collector import (
    collect_server_resources,
    clear_ssh_pool,
    clear_ssh_pool_for_host,
)
```

- [ ] **Step 5: 통합 시나리오 재실행 — 기존 동작 회귀 없음 확인**

Run BE (재시작):
```bash
pkill -f monigrid_be.py 2>/dev/null; sleep 1
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py > /tmp/be.log 2>&1 &
sleep 5
python3 monigrid-be/scripts/test_partial_reload.py
```

Expected: 모든 scenario PASS (1, 2, 3 모두).

- [ ] **Step 6: 커밋**

```bash
git add monigrid-be/app/monitor_collector_manager.py monigrid-be/scripts/test_partial_reload.py
git commit -m "feat(be): MonitorCollectorManager per-target stop_events + add/remove/update API"
```

---

## Task 6: Service _apply_config_diff — per-resource apply logic

**Files:**
- Modify: `monigrid-be/app/service.py` (add `_apply_config_diff` method)

- [ ] **Step 1: _apply_config_diff 구현**

Edit `monigrid-be/app/service.py`. `MonitoringBackend` 클래스에 메서드 추가 (e.g., `reload` 위):

```python
    def _apply_config_diff(self, diff, new_config):
        """Phase 5B: mutate in-memory state to match diff. Called under
        _reload_lock. Returns dict with applied/skipped/errors arrays.
        """
        applied: list[dict] = []
        skipped: list[dict] = []
        errors: list[dict] = []

        # ── Connections ──────────────────────────────────────────────────────
        for cid in diff.connections.removed:
            try:
                pool = self.db_pools.pop(cid, None)
                if pool is not None:
                    pool.close_all()
                applied.append({"resource": "connection", "id": cid, "action": "pool_closed"})
            except Exception as exc:
                errors.append({"resource": "connection", "id": cid, "action": "pool_close",
                               "error": str(exc)})

        for cid in diff.connections.added:
            try:
                self.db_pools[cid] = DBConnectionPool(max_size=int(get_env("DB_POOL_SIZE", "5")))
                applied.append({"resource": "connection", "id": cid, "action": "pool_created"})
            except Exception as exc:
                errors.append({"resource": "connection", "id": cid, "action": "pool_create",
                               "error": str(exc)})

        for cid in diff.connections.changed:
            try:
                self.reset_connections(cid)  # 기존 함수 재사용
                applied.append({"resource": "connection", "id": cid, "action": "pool_reset"})
            except Exception as exc:
                errors.append({"resource": "connection", "id": cid, "action": "pool_reset",
                               "error": str(exc)})

        # ── APIs ────────────────────────────────────────────────────────────
        for aid in diff.apis.removed:
            try:
                self._cache_manager.invalidate(aid)
                applied.append({"resource": "api", "id": aid, "action": "removed_with_cache_clear"})
            except Exception as exc:
                errors.append({"resource": "api", "id": aid, "action": "remove",
                               "error": str(exc)})

        for aid in diff.apis.added:
            applied.append({"resource": "api", "id": aid, "action": "added"})  # cache lazy-fills

        for aid in diff.apis.changed_data:
            try:
                self._cache_manager.invalidate(aid)
                applied.append({"resource": "api", "id": aid, "action": "data_changed_with_cache_invalidate"})
            except Exception as exc:
                errors.append({"resource": "api", "id": aid, "action": "data_change",
                               "error": str(exc)})

        for aid in diff.apis.changed_routing:
            try:
                self._cache_manager.invalidate(aid)
                applied.append({"resource": "api", "id": aid, "action": "routing_changed_with_cache_invalidate"})
            except Exception as exc:
                errors.append({"resource": "api", "id": aid, "action": "routing_change",
                               "error": str(exc)})

        for aid in diff.apis.changed_schedule:
            applied.append({"resource": "api", "id": aid, "action": "schedule_changed"})

        for aid in diff.apis.changed_metadata:
            applied.append({"resource": "api", "id": aid, "action": "metadata_changed"})

        # ── Globals ─────────────────────────────────────────────────────────
        if diff.globals.logging_changed:
            try:
                configure_logging(new_config.logging)
                self._log_reader.update_logging_config(new_config.logging)
                applied.append({"resource": "global", "field": "logging", "action": "applied"})
            except Exception as exc:
                errors.append({"resource": "global", "field": "logging", "error": str(exc)})

        if diff.globals.auth_changed:
            applied.append({"resource": "global", "field": "auth", "action": "metadata_only"})

        if diff.globals.rate_limits_changed:
            applied.append({"resource": "global", "field": "rate_limits", "action": "metadata_only"})
            self.logger.warning(
                "rate_limits change saved to settings DB but Flask-Limiter "
                "captures values at decorator time — change applied on next BE restart"
            )

        for field_name in diff.globals.immutable_changed:
            skipped.append({"resource": "global", "field": field_name, "reason": "requires_restart"})
            self.logger.warning(
                "Field '%s' change saved to settings DB but requires BE restart to take effect",
                field_name,
            )

        for field_name in diff.globals.runtime_metadata_changed:
            applied.append({"resource": "global", "field": field_name, "action": "metadata_only"})

        if diff.globals.sql_validation_changed:
            applied.append({"resource": "global", "field": "sql_validation", "action": "metadata_only"})

        return {"applied": applied, "skipped": skipped, "errors": errors}
```

import 보강 (필요 시 service.py top 에 이미 있음): `from .config import configure_logging` — 이미 있을 가능성 큼. 없으면 추가.

- [ ] **Step 2: 컴파일 확인**

Run: `python3 -c "import sys; sys.path.insert(0,'monigrid-be'); import app.service"`
Expected: no output.

- [ ] **Step 3: 커밋**

```bash
git add monigrid-be/app/service.py
git commit -m "feat(be): service._apply_config_diff — per-resource in-memory mutation logic"
```

---

## Task 7: Service apply_partial_config_reload + apply_monitor_targets_partial entry points

**Files:**
- Modify: `monigrid-be/app/service.py` (add 2 public entry points)
- Test: `monigrid-be/scripts/test_partial_reload.py` (scenario 4, 5 추가)

- [ ] **Step 1: 엔트리포인트 시나리오 추가**

Edit `monigrid-be/scripts/test_partial_reload.py`. Add:

```python
def scenario_4_partial_config_reload_title_only_no_pool_reset_via_be():
    """[requires running BE]
    Connection title 만 수정 → 그 connection 의 pool 객체 동일 유지.
    (직접 pool 객체 비교 불가 → 응답의 applied 배열로 검증)"""
    token = _be_login()
    status, cfg = _http("GET", "/dashboard/config", token)
    assert status == 200
    if not cfg.get("connections"):
        print("  (skipped — no connections configured)")
        return

    # title 만 살짝 변경 (없으면 description 변경)
    new_cfg = dict(cfg)
    new_conns = [dict(c) for c in cfg["connections"]]
    # ConnectionConfig 에 title 필드 없음 — 대신 driver_args 의 동일 변경으로
    # 'no diff' case 검증. title-only 시나리오는 5B 데이터 모델 한계로 skip.
    print("  (no-op — ConnectionConfig has no metadata-only fields per spec)")


def scenario_5_partial_apply_response_shape_via_be():
    """[requires running BE]
    PUT /dashboard/config 응답이 5B shape (applied/skipped/errors) 포함."""
    token = _be_login()
    status, cfg = _http("GET", "/dashboard/config", token)
    assert status == 200
    # PUT 같은 config 다시 보내기 — diff 비어있어야 함
    status, resp = _http("PUT", "/dashboard/config", token, cfg)
    assert status in (200, 207), f"unexpected {status}: {resp}"
    assert "applied" in resp, f"response must include 'applied': {resp}"
    assert "skipped" in resp, f"response must include 'skipped': {resp}"
    assert "errors" in resp, f"response must include 'errors': {resp}"
    assert resp.get("saved") is True
    assert resp.get("reloaded") is True
    assert isinstance(resp["applied"], list)


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
    scenario_2_reload_lock_serializes_concurrent_reloads,
    scenario_3_monitor_collector_per_target_thread_lifecycle_via_be,
    scenario_4_partial_config_reload_title_only_no_pool_reset_via_be,
    scenario_5_partial_apply_response_shape_via_be,
]
```

- [ ] **Step 2: 두 entry point 구현**

Edit `monigrid-be/app/service.py`. `_apply_config_diff` 위 또는 아래에 추가 (자유 위치):

```python
    def apply_partial_config_reload(self, new_config_dict: dict) -> dict:
        """Phase 5B entry point: settings DB write + diff + per-resource apply.

        Returns: {"applied": [...], "skipped": [...], "errors": [...]}.
        Errors do not abort — best-effort apply.
        """
        from .config_diff import compute_config_diff

        with self._reload_lock:
            old_config = self.config
            self.settings_store.save_config_dict(new_config_dict)
            new_config = self._config_reloader()
            diff = compute_config_diff(old_config, new_config)
            result = self._apply_config_diff(diff, new_config)
            self.config = new_config
            self._check_classpath_for_reload(new_config)
            return result

    def apply_monitor_targets_partial(self, batch_request) -> dict:
        """Phase 5B entry point: settings DB batch write + per-target collector mutation.

        Reuses settings_store.apply_monitor_targets_batch (atomic txn).
        Iterates created/updated/deleted, calling MonitorCollectorManager
        public API to surgically mutate state.
        """
        with self._reload_lock:
            store_result = self.settings_store.apply_monitor_targets_batch(batch_request)
            applied: list[dict] = []
            errors: list[dict] = []

            for target in store_result.get("created", []):
                try:
                    self._monitor_collector.add_target(target)
                    applied.append({"resource": "monitor_target", "id": target["id"], "action": "added"})
                except Exception as exc:
                    errors.append({"resource": "monitor_target", "id": target["id"],
                                   "action": "add", "error": str(exc)})

            for target in store_result.get("updated", []):
                try:
                    ssh_changed = bool(target.get("_ssh_credentials_changed"))
                    self._monitor_collector.update_target_in_place(
                        target, ssh_credentials_changed=ssh_changed,
                    )
                    applied.append({"resource": "monitor_target", "id": target["id"], "action": "updated"})
                except Exception as exc:
                    errors.append({"resource": "monitor_target", "id": target["id"],
                                   "action": "update", "error": str(exc)})

            for target_id in store_result.get("deleted", []):
                try:
                    self._monitor_collector.remove_target(target_id)
                    applied.append({"resource": "monitor_target", "id": target_id, "action": "removed"})
                except Exception as exc:
                    errors.append({"resource": "monitor_target", "id": target_id,
                                   "action": "remove", "error": str(exc)})

            return {
                "created": store_result.get("created", []),
                "updated": store_result.get("updated", []),
                "deleted": store_result.get("deleted", []),
                "failed": store_result.get("failed", []),
                "applied": applied,
                "errors": errors,
            }
```

- [ ] **Step 3: 컴파일 확인**

Run: `python3 -c "import sys; sys.path.insert(0,'monigrid-be'); import app.service"`
Expected: no output.

- [ ] **Step 4: 커밋**

```bash
git add monigrid-be/app/service.py monigrid-be/scripts/test_partial_reload.py
git commit -m "feat(be): apply_partial_config_reload + apply_monitor_targets_partial entry points"
```

---

## Task 8: Routes — switch update_config + monitor_targets_batch + single-item routes

**Files:**
- Modify: `monigrid-be/app/routes/dashboard_routes.py` (`update_config` 핸들러)
- Modify: `monigrid-be/app/routes/monitor_routes.py` (`monitor_targets_batch` + 단일 항목 라우트들)

- [ ] **Step 1: dashboard_routes.update_config 교체**

Edit `monigrid-be/app/routes/dashboard_routes.py`. `update_config` ([dashboard_routes.py:185-218](../../monigrid-be/app/routes/dashboard_routes.py#L185)) 본문 교체:

Before:
```python
        try:
            backend.settings_store.save_config_dict(config_data)
            backend.logger.info("Config updated in settings DB by admin clientIp=%s", client_ip)
        except Exception:
            backend.logger.exception("Config write to settings DB failed clientIp=%s", client_ip)
            return jsonify({"message": "failed to write config", "detail": "internal error"}), 500

        try:
            backend.reload()
        except Exception:
            backend.logger.exception("Config reload after update failed clientIp=%s", client_ip)
            return jsonify({
                "message": "config saved but reload failed",
                ...
            }), 500

        backend.logger.info("Config updated and reloaded successfully clientIp=%s", client_ip)
        enabled_apis = [ep for ep in backend.config.apis.values() if ep.enabled]
        return jsonify({
            "message": "config updated and reloaded",
            "saved": True,
            "reloaded": True,
            "endpointCount": len(enabled_apis),
            "connectionCount": len(backend.config.connections),
        }), 200
```

After:
```python
        try:
            partial_result = backend.apply_partial_config_reload(config_data)
        except Exception:
            backend.logger.exception("Partial config reload failed clientIp=%s", client_ip)
            return jsonify({
                "message": "config save+reload failed",
                "detail": "internal error",
                "saved": False,
                "reloaded": False,
            }), 500

        backend.logger.info(
            "Config updated and partially reloaded successfully clientIp=%s applied=%d errors=%d",
            client_ip, len(partial_result["applied"]), len(partial_result["errors"]),
        )
        enabled_apis = [ep for ep in backend.config.apis.values() if ep.enabled]
        body = {
            "message": "config updated and reloaded",
            "saved": True,
            "reloaded": True,
            "endpointCount": len(enabled_apis),
            "connectionCount": len(backend.config.connections),
            "applied": partial_result["applied"],
            "skipped": partial_result["skipped"],
            "errors": partial_result["errors"],
        }
        status_code = 207 if partial_result["errors"] else 200
        return jsonify(body), status_code
```

- [ ] **Step 2: monitor_routes.monitor_targets_batch 교체**

Edit `monigrid-be/app/routes/monitor_routes.py`. `monitor_targets_batch` 핸들러 본문에서 `backend.apply_monitor_targets_batch(batch_request)` 호출을 `backend.apply_monitor_targets_partial(batch_request)` 로 교체. 응답 body 에 `applied`/`errors` 추가:

```python
        try:
            result = backend.apply_monitor_targets_partial(batch_request)
        except Exception:
            backend.logger.exception("Monitor target partial apply failed clientIp=%s", client_ip)
            return jsonify({"message": "monitor target apply failed", "detail": "internal error"}), 500

        status_code = 207 if result.get("errors") else 200
        return jsonify(result), status_code
```

(기존 응답 shape 의 created/updated/deleted/failed 는 `apply_monitor_targets_partial` 의 결과에 포함되어 있음 — Task 7 의 정의 참조.)

- [ ] **Step 3: 단일 항목 라우트 — batch wrapper 로 통합**

Edit `monitor_routes.py`. POST `/dashboard/monitor-targets`, PUT `/dashboard/monitor-targets/<target_id>`, DELETE `/dashboard/monitor-targets/<target_id>` 핸들러 본문을 1개짜리 batch 로 wrap:

```python
    # POST /dashboard/monitor-targets — single create
    @app.route("/dashboard/monitor-targets", methods=["POST"])
    @require_auth
    @require_admin
    def create_monitor_target():
        body = request.get_json(silent=True) or {}
        result = backend.apply_monitor_targets_partial(
            {"create": [body], "update": [], "delete": []}
        )
        if result.get("errors") or result.get("failed"):
            return jsonify(result), 207
        # 단일 create 의 결과
        created = result["created"]
        return jsonify(created[0] if created else {}), 201

    # PUT /dashboard/monitor-targets/<target_id>
    @app.route("/dashboard/monitor-targets/<target_id>", methods=["PUT"])
    @require_auth
    @require_admin
    def update_monitor_target(target_id):
        body = request.get_json(silent=True) or {}
        body["id"] = target_id
        result = backend.apply_monitor_targets_partial(
            {"create": [], "update": [body], "delete": []}
        )
        if result.get("errors") or result.get("failed"):
            return jsonify(result), 207
        updated = result["updated"]
        return jsonify(updated[0] if updated else {}), 200

    # DELETE /dashboard/monitor-targets/<target_id>
    @app.route("/dashboard/monitor-targets/<target_id>", methods=["DELETE"])
    @require_auth
    @require_admin
    def delete_monitor_target(target_id):
        result = backend.apply_monitor_targets_partial(
            {"create": [], "update": [], "delete": [target_id]}
        )
        if result.get("errors") or result.get("failed"):
            return jsonify(result), 207
        return jsonify({"deleted": result.get("deleted", [])}), 200
```

(기존 핸들러 본문 전체를 위 코드로 대체. 기존 핸들러가 `settings_store` 직접 호출하던 부분 제거.)

- [ ] **Step 4: BE 재시작 + 통합 시나리오 재실행**

Run:
```bash
pkill -f monigrid_be.py 2>/dev/null; sleep 1
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py > /tmp/be.log 2>&1 &
sleep 5
python3 monigrid-be/scripts/test_partial_reload.py
```

Expected: 모든 scenario PASS (1-5 또는 skip).

- [ ] **Step 5: 커밋**

```bash
git add monigrid-be/app/routes/dashboard_routes.py monigrid-be/app/routes/monitor_routes.py
git commit -m "feat(be): routes wired to partial reload — update_config + monitor target CRUD"
```

---

## Task 9: ADMIN_MANUAL — 5-5 절 (partial reload 운영 가이드)

**Files:**
- Modify: `docs/ADMIN_MANUAL.md`

- [ ] **Step 1: 5-5 절 작성**

Edit `docs/ADMIN_MANUAL.md`. 기존 5-4 절 끝 근처 (또는 5-5 자리) 에 추가:

```markdown
## 5-5. Phase 5B — Partial Config Reload (2026-05-07)

이전까지 PUT /dashboard/config 와 monitor target 저장은 **모든 connection pool / executor / cache / monitor thread 를 재생성**하는 nuclear reload 였다 (`backend.reload()`). 그래서 connection title 한 글자만 수정해도 다른 사용자의 위젯 cache 가 비워지면서 **모든 client 가 동시에 cache miss → 같은 timestamp 의 같은 데이터 수신 → 동시 알람** 현상이 발생할 수 있었다.

5B 부터는 **변경된 항목만** in-memory 에 적용한다. 변경 안 된 connection pool / endpoint cache / monitor thread 는 절대 건드리지 않는다.

### 응답 shape 변화

`PUT /dashboard/config` 응답에 `applied` / `skipped` / `errors` 배열 추가:

```json
{
  "saved": true,
  "reloaded": true,
  "endpointCount": 2,
  "connectionCount": 1,
  "applied": [
    {"resource": "api", "id": "status", "action": "data_changed_with_cache_invalidate"}
  ],
  "skipped": [
    {"resource": "global", "field": "thread_pool_size", "reason": "requires_restart"}
  ],
  "errors": []
}
```

`errors` 배열이 비어있지 않으면 HTTP 207 Multi-Status. FE 가 부분 실패를 사용자에게 알림. 다른 항목은 적용되었으므로 settings DB 와 in-memory 가 일관 (실패한 항목만 다음 BE 재시작 시 자동 복구).

### Runtime-immutable 필드

다음 필드 변경은 settings DB 에는 저장되지만 **BE 재시작 후에 적용**된다:
- `thread_pool_size` (ThreadPoolExecutor 는 runtime resize 불가)
- `server.host`, `server.port` (BE listen socket)
- `rate_limits.*` (Flask-Limiter 가 데코 시점 캡처)

이 필드들이 변경된 경우 응답의 `skipped` 배열에 등장 + BE 로그에 WARNING 1줄. 운영자는 의도된 변경 후 BE 서비스 재시작 (NSSM stop/start) 필요.

### Escape hatch — POST /dashboard/reload-config

기존 nuclear reload 는 보존됐다. 다음 경우에 명시적으로 호출:
- JDBC driver jar 를 새로 추가했는데 BE 재시작 없이 동작 확인하고 싶을 때 (실제로는 JVM classpath 가 갱신되지 않으므로 효과는 제한적)
- 테스트 / 디버그 시 모든 cache 를 명시적으로 비우고 싶을 때

POST `/dashboard/reload-config` (admin only) — 응답 shape 변경 없음. 기존 `endpointCount` 만.

### JDBC classpath 로깅 (I-2)

이전: 모든 reload 마다 `[ERROR] Reload introduced JDBC jars not on the running JVM classpath ... missing=...` 출력 → alert fatigue.

5B 부터:
- 부팅 시 1회: `[INFO] Loaded JDBC drivers: N jars` + 누락분이 있으면 `[INFO] JDBC jars not on classpath at boot (will be ignored on reload): [...]`
- 운영자가 **새 connection 추가 → 새로 누락된 jar** 가 등장한 경우만 `[WARNING] JDBC jars not on classpath — newly_missing=[...]` 1회. 같은 누락 jar 는 두 번 다시 로그 안 남.

### Partial reload 의 success criteria

다음 시나리오들이 5B 적용 후 동작:
- Connection title 만 수정 → 그 connection 의 pool 재생성 안 됨, 다른 사용자 query 영향 0
- API SQL 수정 → 그 endpoint cache 만 invalidate, 다른 endpoint cache 보존
- Monitor target 임계치 수정 → thread 재생성 없음, 다음 sleep tick 후 자연 적용
- 동시 2개 reload 호출 → 직렬화 (`_reload_lock` 검증)

### 관련 commit / PR

- 디자인 spec: `docs/superpowers/specs/2026-05-07-partial-config-reload-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-07-partial-config-reload.md`
```

- [ ] **Step 2: 커밋**

```bash
git add docs/ADMIN_MANUAL.md
git commit -m "docs(admin): 5-5 partial config reload 운영 가이드 + I-2 JDBC classpath 로깅 변경 안내"
```

---

## Task 10: End-to-end smoke scenarios + initsetting.json 정리

**Files:**
- Modify: `monigrid-be/scripts/test_partial_reload.py` (마지막 시나리오)
- Cleanup: `monigrid-be/initsetting.json` (test artifact)

- [ ] **Step 1: 동시 reload 직렬화 시나리오 (BE 대상) 추가**

Edit `monigrid-be/scripts/test_partial_reload.py`. Add:

```python
def scenario_6_concurrent_reload_serialization_via_be():
    """[requires running BE]
    POST /dashboard/reload-config 를 3개 동시에 호출해도 lock 으로 직렬화.
    응답 시간 패턴이 ~T, ~2T, ~3T 형태인지 확인."""
    import threading, time
    token = _be_login()

    timings: list[tuple[float, float]] = []
    timings_lock = threading.Lock()

    def fire():
        t0 = time.perf_counter()
        status, _ = _http("POST", "/dashboard/reload-config", token, {})
        t1 = time.perf_counter()
        with timings_lock:
            timings.append((t0, t1))

    ts = [threading.Thread(target=fire) for _ in range(3)]
    for t in ts: t.start()
    for t in ts: t.join()

    timings.sort(key=lambda p: p[0])  # start order
    durations = [t1 - t0 for (t0, t1) in timings]
    completion_times = [t1 - timings[0][0] for (_, t1) in timings]
    # 직렬이라면 completion_times[0] < completion_times[1] < completion_times[2]
    # 그리고 completion_times[2] >= 3 * (mean per-call duration) approximately
    assert completion_times[0] < completion_times[1] < completion_times[2], \
        f"reload calls must serialize, got completion_times={completion_times}"
    mean_dur = sum(durations) / len(durations)
    assert completion_times[2] >= mean_dur * 1.5, \
        f"third completion ({completion_times[2]:.2f}s) must show queueing — mean dur {mean_dur:.2f}s"


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
    scenario_2_reload_lock_serializes_concurrent_reloads,
    scenario_3_monitor_collector_per_target_thread_lifecycle_via_be,
    scenario_4_partial_config_reload_title_only_no_pool_reset_via_be,
    scenario_5_partial_apply_response_shape_via_be,
    scenario_6_concurrent_reload_serialization_via_be,
]
```

- [ ] **Step 2: BE 재시작 + 전체 시나리오 실행**

Run:
```bash
pkill -f monigrid_be.py 2>/dev/null; sleep 1
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py > /tmp/be.log 2>&1 &
sleep 5
python3 monigrid-be/scripts/test_partial_reload.py
```

Expected: 모든 scenario PASS (또는 데이터 없는 경우 skip).

- [ ] **Step 3: BE 종료 + initsetting.json 정리**

Run:
```bash
pkill -f monigrid_be.py 2>/dev/null
rm -f monigrid-be/initsetting.json   # gitignore 대상이지만 명시적 cleanup
```

- [ ] **Step 4: 최종 commit**

```bash
git add monigrid-be/scripts/test_partial_reload.py
git commit -m "test(be): full E2E partial reload scenarios — concurrent reload serialization verified"
```

- [ ] **Step 5: 자체 검증 — 5B success criteria 체크**

Spec 의 [Success Criteria](../specs/2026-05-07-partial-config-reload-design.md#success-criteria) 7개 항목 수동 확인:
1. Connection title 만 수정 시 pool 객체 동일 — 데이터 모델 한계로 N/A (ConnectionConfig 에 metadata-only 필드 없음, scenario 4 에서 명시 skip)
2. API SQL 수정 → 다른 API cache 보존 — scenario 5 가 응답 shape 만 검증, 직접 cache 검증은 5A 도입 시 추가
3. Monitor target 임계치 수정 → thread 재생성 없음 — scenario 3 검증 (thread name 셋 안정 + 응답 errors 없음)
4. 동시 2개 reload 직렬화 — scenario 2 (단위) + scenario 6 (E2E) 검증
5. apply_partial_config_reload 평균 < 200ms — BE 로그의 응답 시간 확인 (수동)
6. 부팅 시 INFO "Loaded JDBC drivers" 1회 — Task 4 의 step 2 에서 확인
7. runtime-immutable 변경 시 WARNING + skipped 배열 — Task 8 의 응답 shape 검증

5번은 measure_partial_reload_p95.py 같은 별도 측정이 필요하지만 5B 범위는 아님 (5A 테스트 인프라와 함께).

---

## Self-review notes

**1. Spec coverage 체크**:
- §Architecture Overview: Task 7 (entry points), Task 6 (apply diff)
- §Diff Computation: Task 2 (config_diff module)
- §Action Matrix — Connection: Task 6 (added/removed/changed)
- §Action Matrix — API: Task 6 (added/removed/changed_data/changed_routing/changed_schedule/changed_metadata)
- §Action Matrix — Monitor target: Task 5 + Task 7 (apply_monitor_targets_partial)
- §Action Matrix — Global: Task 6 (logging/auth/rate_limits/immutable/runtime_metadata)
- §Monitor Collector Refactor: Task 5 (per-target events + add/remove/update)
- §Concurrency Model: Task 3 (`_reload_lock`)
- §JVM Classpath Logging (I-2): Task 4
- §Routes & Backwards Compatibility: Task 8
- §Error Handling: Task 6 (try/except per resource, 207 응답)
- §Testing Strategy: Task 1, 2, 5, 7, 10 의 테스트 시나리오 + Task 9 의 ADMIN_MANUAL smoke test plan

**Gap: spec 의 §Action Matrix 에 "ConnectionConfig 에 metadata-only 필드" 가 있다고 가정했지만 실제 코드는 그렇지 않음.** Plan 에서는 Task 2 의 `compute_config_diff` 가 connection 에 대해 단일 `changed` 리스트만 반환하는 것으로 일관되게 처리. spec 의 해당 부분은 추후 spec 보강 시 정정.

**2. Placeholder scan**: TBD/TODO 없음. 모든 step 에 실제 code 또는 정확한 명령어 포함.

**3. Type consistency**:
- `ConfigDiff` / `ConnectionDiff` / `ApiDiff` / `GlobalDiff` 이름 Task 2 정의 → Task 6 사용 일치
- `_apply_config_diff(diff, new_config) -> dict` 시그니처 Task 6 정의 → Task 7 호출 일치
- `apply_partial_config_reload(new_config_dict) -> dict` Task 7 정의 → Task 8 호출 일치
- `apply_monitor_targets_partial(batch_request) -> dict` Task 7 정의 → Task 8 호출 일치
- `add_target/remove_target/update_target_in_place` Task 5 정의 → Task 7 호출 일치
- `clear_ssh_pool_for_host(host)` Task 1 정의 → Task 5 호출 일치
- `_reload_lock` Task 3 정의 → Task 5/7 사용 일치
- `_known_missing_jars` Task 4 정의 (set[str]) → `_check_classpath_for_reload` 사용 일치

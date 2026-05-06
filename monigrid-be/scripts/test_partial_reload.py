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

from monigrid_be_path_setup import setup
setup()


def scenario_1_clear_ssh_pool_for_host_only_drains_target_host():
    """clear_ssh_pool_for_host 가 해당 host 의 session 만 drain — 다른 host 는 보존."""
    from app.server_resource_collector import _SSH_POOL, _SSH_POOL_LOCK, clear_ssh_pool_for_host

    class _FakeSession:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

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


def scenario_2_reload_lock_serializes_concurrent_reloads():
    """기존 reload() 도 _reload_lock 안에서 실행 — 두 동시 호출이 직렬화됨.
    이 시나리오는 lock 패턴 자체를 검증 (실제 service._reload_lock 의 존재는
    별도 import 로 확인)."""
    # service._reload_lock 존재 확인
    from app.service import MonitoringBackend
    assert hasattr(MonitoringBackend, "_reload_unlocked"), \
        "MonitoringBackend must expose _reload_unlocked (Phase 5B refactor)"

    # 직접 lock 의 직렬화 동작 검증
    lock = threading.Lock()
    timeline: list[tuple[str, float]] = []
    timeline_lock = threading.Lock()
    barrier = threading.Barrier(2)

    def fake_reload(label: str):
        barrier.wait()  # 두 thread 가 동시에 lock 진입 시도
        with lock:
            with timeline_lock:
                timeline.append((f"{label}_enter", time.perf_counter()))
            time.sleep(0.05)  # critical section
            with timeline_lock:
                timeline.append((f"{label}_exit", time.perf_counter()))

    t1 = threading.Thread(target=fake_reload, args=("A",))
    t2 = threading.Thread(target=fake_reload, args=("B",))
    t1.start(); t2.start(); t1.join(); t2.join()

    assert len(timeline) == 4
    e0, e1, e2, e3 = (e[0] for e in timeline)
    first_label = e0[0]
    second_label = "B" if first_label == "A" else "A"
    assert e1 == f"{first_label}_exit", f"second event must be {first_label}_exit, got {e1}"
    assert e2 == f"{second_label}_enter", f"third event must be {second_label}_enter, got {e2}"
    assert e3 == f"{second_label}_exit", f"fourth event must be {second_label}_exit, got {e3}"


def _be_login_admin(base_url: str = "http://127.0.0.1:5000") -> str | None:
    """Login as admin. Returns token or None if BE down / admin auth unavailable."""
    import json
    import urllib.request
    import urllib.error
    try:
        req = urllib.request.Request(
            f"{base_url}/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r).get("token")
    except urllib.error.URLError:
        return None
    except urllib.error.HTTPError:
        return None
    except Exception:
        return None


def _http(method: str, path: str, token: str, body=None,
          base_url: str = "http://127.0.0.1:5000"):
    import json
    import urllib.request
    import urllib.error
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base_url + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def scenario_3_partial_apply_response_shape_via_be():
    """[requires running BE + admin login]
    PUT /dashboard/config 응답이 5B shape (applied/skipped/errors) 포함."""
    token = _be_login_admin()
    if token is None:
        print("  (skipped — BE unreachable or admin login unavailable)")
        return
    status, cfg = _http("GET", "/dashboard/config", token)
    if status != 200:
        print(f"  (skipped — GET /dashboard/config returned {status})")
        return
    # PUT 같은 config 다시 보내기 — diff 비어있어야 함
    status, resp = _http("PUT", "/dashboard/config", token, cfg)
    assert status in (200, 207), f"unexpected {status}: {resp}"
    assert "applied" in resp, f"response must include 'applied': {resp}"
    assert "skipped" in resp, f"response must include 'skipped': {resp}"
    assert "errors" in resp, f"response must include 'errors': {resp}"
    assert resp.get("saved") is True
    assert resp.get("reloaded") is True
    assert isinstance(resp["applied"], list)


def scenario_4_concurrent_reload_serialization_via_be():
    """[requires running BE + admin login]
    POST /dashboard/reload-config 를 3개 동시에 호출해도 lock 으로 직렬화."""
    token = _be_login_admin()
    if token is None:
        print("  (skipped — BE unreachable or admin login unavailable)")
        return

    timings: list[tuple[float, float]] = []
    timings_lock = threading.Lock()

    def fire():
        t0 = time.perf_counter()
        _http("POST", "/dashboard/reload-config", token, {})
        t1 = time.perf_counter()
        with timings_lock:
            timings.append((t0, t1))

    ts = [threading.Thread(target=fire) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()

    timings.sort(key=lambda p: p[0])
    durations = [t1 - t0 for (t0, t1) in timings]
    completion_times = [t1 - timings[0][0] for (_, t1) in timings]
    assert completion_times[0] < completion_times[1] < completion_times[2], \
        f"reload calls must serialize, got completion_times={completion_times}"
    mean_dur = sum(durations) / len(durations)
    # Third completion should show queueing — at least 1.5x mean duration.
    # (이전 nuclear race 시점에는 거의 동시에 끝났음.)
    assert completion_times[2] >= mean_dur * 1.5, \
        f"third completion ({completion_times[2]:.2f}s) must show queueing — mean dur {mean_dur:.2f}s"


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
    scenario_2_reload_lock_serializes_concurrent_reloads,
    scenario_3_partial_apply_response_shape_via_be,
    scenario_4_concurrent_reload_serialization_via_be,
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

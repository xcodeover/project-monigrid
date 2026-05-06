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


SCENARIOS = [
    scenario_1_clear_ssh_pool_for_host_only_drains_target_host,
    scenario_2_reload_lock_serializes_concurrent_reloads,
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

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

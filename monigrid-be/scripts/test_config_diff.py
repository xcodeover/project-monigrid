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
    server_resources_batch="60/minute", monitor_refresh="10/minute", monitor_targets_batch="10/minute",
    cache_refresh="30/minute", reload_config="5/minute")


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

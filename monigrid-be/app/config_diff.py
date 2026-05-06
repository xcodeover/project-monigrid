"""Compute item-level diff between two AppConfig snapshots.

Pure logic, no I/O. Used by service.apply_partial_config_reload to decide
which connection pools / endpoint cache entries / etc. need mutation.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .config import AppConfig, ApiEndpointConfig, ConnectionConfig


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

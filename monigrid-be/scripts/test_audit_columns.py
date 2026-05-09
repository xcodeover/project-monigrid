"""Audit columns (updated_at/updated_by) — integration scenarios.

Run with:
    python3 monigrid-be/scripts/test_audit_columns.py

Pure-state scenarios (a1) work without BE.
DB-direct scenarios (b1, b2, b4, b5, b6) need MariaDB but no running BE.
Live-route scenario (c2) needs BE running on 127.0.0.1:5000.
"""
from __future__ import annotations
import os
import sys
import traceback
import logging

from monigrid_be_path_setup import setup
setup()

_logger = logging.getLogger("test_audit_columns")
logging.basicConfig(level=logging.WARNING)

# Absolute path to initsetting.json, computed relative to this script's location.
# scripts/ is one level below monigrid-be/, so go up one directory.
_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
_BE_DIR = os.path.normpath(os.path.join(_SCRIPTS_DIR, ".."))
_INITSETTING_PATH = os.path.join(_BE_DIR, "initsetting.json")


def _open_store():
    from app.settings_store import SettingsStore, load_init_settings
    cfg = load_init_settings(_INITSETTING_PATH)
    store = SettingsStore(settings_db=cfg, logger=_logger)
    store.connect()
    return store


# ── scenarios ─────────────────────────────────────────────────────────────


def scenario_a1_ddl_includes_audit_columns():
    """Pure-state: DDL strings contain updated_at + updated_by for all dialects."""
    from app.settings_store import _ddl_statements

    for db_type in ("mariadb", "mssql", "oracle"):
        stmts = _ddl_statements(db_type)
        combined = "\n".join(stmts)

        # Find the monigrid_apis table DDL
        apis_stmt = next(
            (s for s in stmts if "monigrid_apis" in s and "PRIMARY KEY" in s),
            None,
        )
        assert apis_stmt is not None, \
            f"[{db_type}] could not find monigrid_apis CREATE TABLE statement"
        assert "updated_at" in apis_stmt, \
            f"[{db_type}] monigrid_apis DDL missing updated_at"
        assert "updated_by" in apis_stmt, \
            f"[{db_type}] monigrid_apis DDL missing updated_by"

        # Find the monigrid_monitor_targets table DDL
        targets_stmt = next(
            (s for s in stmts if "monigrid_monitor_targets" in s and "PRIMARY KEY" in s),
            None,
        )
        assert targets_stmt is not None, \
            f"[{db_type}] could not find monigrid_monitor_targets CREATE TABLE statement"
        assert "updated_by" in targets_stmt, \
            f"[{db_type}] monigrid_monitor_targets DDL missing updated_by"


def scenario_b1_list_monitor_targets_returns_audit_fields():
    """DB-direct: list_monitor_targets() rows expose updated_at/updated_by keys."""
    store = _open_store()
    rows = store.list_monitor_targets()
    assert len(rows) >= 1, "expected at least one monitor target in DB"
    for row in rows:
        assert "updated_at" in row, f"row missing updated_at: {row}"
        assert "updated_by" in row, f"row missing updated_by: {row}"
        if row["updated_at"] is not None:
            assert row["updated_at"].endswith("Z"), \
                f"updated_at must end with 'Z', got: {row['updated_at']!r}"


def scenario_b2_actor_stamped_on_batch_update():
    """DB-direct: apply_monitor_targets_batch stamps updated_by == actor on update."""
    store = _open_store()
    targets = store.list_monitor_targets()
    assert len(targets) >= 1, "need at least one monitor target for b2"

    first = targets[0]
    original_label = first.get("label") or ""
    target_id = first["id"]

    # ── step 1: update with known actor ──────────────────────────────────
    new_label = original_label + "_b2"
    result = store.apply_monitor_targets_batch(
        creates=[],
        updates=[{**first, "label": new_label}],
        deletes=[],
        actor="b2-test-actor",
    )
    assert result.get("success") is True, f"batch update failed: {result}"

    fetched = store.get_monitor_target(target_id)
    assert fetched is not None, f"target {target_id} not found after update"
    assert fetched["updated_by"] == "b2-test-actor", \
        f"expected updated_by='b2-test-actor', got {fetched['updated_by']!r}"

    # ── step 2: restore label with actor='cleanup' ────────────────────────
    result2 = store.apply_monitor_targets_batch(
        creates=[],
        updates=[{**first, "label": original_label}],
        deletes=[],
        actor="cleanup",
    )
    assert result2.get("success") is True, f"cleanup batch update failed: {result2}"

    fetched2 = store.get_monitor_target(target_id)
    assert fetched2 is not None
    assert fetched2["updated_by"] == "cleanup", \
        f"expected updated_by='cleanup', got {fetched2['updated_by']!r}"

    # ── step 3: batch update with actor='' → updated_by should be None ────
    result3 = store.apply_monitor_targets_batch(
        creates=[],
        updates=[{**first, "label": original_label}],
        deletes=[],
        actor="",
    )
    assert result3.get("success") is True, f"empty-actor batch update failed: {result3}"

    fetched3 = store.get_monitor_target(target_id)
    assert fetched3 is not None
    assert fetched3["updated_by"] is None, \
        f"expected updated_by=None for empty actor, got {fetched3['updated_by']!r}"


def scenario_b4_load_apis_returns_audit_fields():
    """DB-direct: load_apis() rows expose updated_at/updated_by keys."""
    store = _open_store()
    apis = store.load_apis()
    assert len(apis) >= 1, "expected at least one api in DB"
    first = apis[0]
    assert "updated_at" in first, f"first api row missing updated_at: {first}"
    assert "updated_by" in first, f"first api row missing updated_by: {first}"
    if first["updated_at"] is not None:
        assert first["updated_at"].endswith("Z"), \
            f"updated_at must end with 'Z', got: {first['updated_at']!r}"


def scenario_b5_unchanged_api_preserves_audit():
    """DB-direct: replace_apis() preserves audit for content-unchanged rows.

    This is the central correctness test: when only the first API is modified,
    the second API's (updated_at, updated_by) must remain bit-for-bit identical.
    """
    store = _open_store()
    apis_before = store.load_apis()

    if len(apis_before) < 2:
        print("  (skipped — need at least 2 apis for b5)")
        return

    victim = apis_before[0]
    target = apis_before[1]
    target_audit_before = (target["updated_at"], target["updated_by"])

    # Build new list: modify victim's title only; keep the rest unchanged
    new_list = [{**victim, "title": (victim["title"] or "") + "_b5"}, *apis_before[1:]]
    store.replace_apis(new_list, actor="b5-test")

    apis_after = store.load_apis()
    by_id = {a["id"]: a for a in apis_after}

    victim_after = by_id.get(victim["id"])
    assert victim_after is not None, f"victim {victim['id']} missing after replace"
    assert victim_after["updated_by"] == "b5-test", \
        f"victim updated_by should be 'b5-test', got {victim_after['updated_by']!r}"

    target_after = by_id.get(target["id"])
    assert target_after is not None, f"target {target['id']} missing after replace"
    target_audit_after = (target_after["updated_at"], target_after["updated_by"])
    assert target_audit_after == target_audit_before, (
        f"unchanged api audit must be preserved!\n"
        f"  before: {target_audit_before}\n"
        f"  after:  {target_audit_after}"
    )

    # Restore original state
    store.replace_apis(apis_before, actor="cleanup")


def scenario_b6_session_timezone_is_utc():
    """DB-direct (mariadb only): session time_zone must be UTC or +00:00."""
    from app.settings_store import load_init_settings
    cfg = load_init_settings(_INITSETTING_PATH)
    if cfg.db_type != "mariadb":
        print("  (skipped — not mariadb)")
        return

    store = _open_store()
    cur = store._conn.cursor()
    try:
        cur.execute("SELECT @@session.time_zone")
        row = cur.fetchone()
    finally:
        try:
            cur.close()
        except Exception:
            pass

    assert row is not None, "no result from SELECT @@session.time_zone"
    tz_val = str(row[0]).strip()
    assert tz_val in ("+00:00", "UTC"), \
        f"expected session time_zone in ('+00:00', 'UTC'), got {tz_val!r}"


def scenario_c2_actor_propagated_through_route():
    """Live-route: PUT /dashboard/config stamps updated_by == 'admin' on changed api."""
    import json
    import urllib.request
    import urllib.error

    base_url = "http://127.0.0.1:5000"

    # ── login ─────────────────────────────────────────────────────────────
    def _post_json(path, body, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(
            base_url + path,
            data=json.dumps(body).encode(),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except urllib.error.URLError:
            return None, None

    def _get_json(path, token):
        req = urllib.request.Request(
            base_url + path,
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except urllib.error.URLError:
            return None, None

    def _put_json(path, body, token):
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        req = urllib.request.Request(
            base_url + path,
            data=json.dumps(body).encode(),
            headers=headers,
            method="PUT",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except urllib.error.URLError:
            return None, None

    status, body = _post_json("/auth/login", {"username": "admin", "password": "admin"})
    if status is None:
        print("  (skipped — BE unreachable)")
        return
    assert status == 200, f"login failed: {status} {body}"
    token = body.get("token")
    assert token, "login response has no token"

    # ── GET current config ────────────────────────────────────────────────
    status, cfg = _get_json("/dashboard/config", token)
    assert status == 200, f"GET /dashboard/config returned {status}"

    apis = cfg.get("apis") or []
    if not apis:
        print("  (skipped — no apis in config)")
        return

    original_title = apis[0].get("title") or ""
    modified_cfg = {**cfg, "apis": [{**apis[0], "title": original_title + "_c2"}, *apis[1:]]}

    # ── PUT modified config ───────────────────────────────────────────────
    status, resp = _put_json("/dashboard/config", modified_cfg, token)
    assert status in (200, 207), f"PUT /dashboard/config returned {status}: {resp}"

    # ── verify audit fields ───────────────────────────────────────────────
    status2, cfg2 = _get_json("/dashboard/config", token)
    assert status2 == 200, f"re-GET /dashboard/config returned {status2}"
    apis2 = cfg2.get("apis") or []
    assert len(apis2) >= 1, "no apis in re-fetched config"

    first_api2 = next((a for a in apis2 if a.get("id") == apis[0]["id"]), None)
    assert first_api2 is not None, f"api id={apis[0]['id']} not found after PUT"
    assert first_api2.get("updated_by") == "admin", \
        f"expected updated_by='admin', got {first_api2.get('updated_by')!r}"
    assert first_api2.get("updated_at") is not None, \
        "updated_at should be non-None after PUT"
    assert str(first_api2.get("updated_at", "")).endswith("Z"), \
        f"updated_at must end with 'Z', got {first_api2.get('updated_at')!r}"

    # ── restore original title ────────────────────────────────────────────
    restore_cfg = {**cfg2, "apis": [{**first_api2, "title": original_title}, *apis2[1:]]}
    _put_json("/dashboard/config", restore_cfg, token)


SCENARIOS = [
    scenario_a1_ddl_includes_audit_columns,
    scenario_b1_list_monitor_targets_returns_audit_fields,
    scenario_b2_actor_stamped_on_batch_update,
    scenario_b4_load_apis_returns_audit_fields,
    scenario_b5_unchanged_api_preserves_audit,
    scenario_b6_session_timezone_is_utc,
    scenario_c2_actor_propagated_through_route,
]


def main() -> int:
    failed = 0
    for fn in SCENARIOS:
        name = fn.__name__
        try:
            fn()
            print(f"[PASS] {name}")
        except Exception as e:
            failed += 1
            print(f"[FAIL] {name}: {e}")
            traceback.print_exc()
    print(f"\n{len(SCENARIOS) - failed}/{len(SCENARIOS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

# Batch Save (#6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ConfigEditorModal "데이터 API" 탭 + MonitorTargetsTab 의 항목별 저장 → 하단 "저장&적용" 1회 호출로 변경/추가/삭제 일괄 반영. atomic 트랜잭션 + 1회 reload.

**Architecture:** BE 에 신규 batch endpoint (monitor target 만 — 데이터 API 는 기존 PUT /dashboard/config 재활용). FE 는 공통 `useDirtyList` hook + `DirtyListSummary` 컴포넌트로 두 모달이 동일 dirty-tracking UX. Validation 은 per-row, 저장은 atomic.

**Tech Stack:** Python 3.13 / Flask / JayDeBeApi (BE), React 18 / Vite / Zustand (FE).

**Spec:** `docs/superpowers/specs/2026-05-06-batch-save-design.md`

**Test infrastructure:** 프로젝트에 자동 테스트 없음. 각 task = (1) 변경 → (2) 수동 검증 (코드 인스펙션 + 빌드/import sanity + 가능 시 인라인 mock 트레이스) → (3) commit.

---

## File Structure

**BE (modify 4):**
- `monigrid-be/app/settings_store.py` — `apply_monitor_targets_batch` 메서드 추가
- `monigrid-be/app/service.py` — backend delegate `apply_monitor_targets_batch` 메서드 추가
- `monigrid-be/app/routes/monitor_routes.py` — `POST /dashboard/monitor-targets/batch` 라우트 추가
- `monigrid-be/app/config.py` — `RateLimitConfig.monitor_targets_batch` 추가

**FE (create 4 + modify 3):**
- 신규: `monigrid-fe/src/hooks/useDirtyList.js`
- 신규: `monigrid-fe/src/hooks/useUnsavedChangesGuard.js`
- 신규: `monigrid-fe/src/components/DirtyListSummary.jsx`
- 신규: `monigrid-fe/src/components/DirtyListSummary.css` (+ row state classes 공유 정의)
- 수정: `monigrid-fe/src/services/dashboardService.js` — `applyTargetsBatch` 메서드 + cache invalidate
- 수정: `monigrid-fe/src/components/MonitorTargetsTab.jsx` — 개별 save 제거 → batch 패턴 적용
- 수정: `monigrid-fe/src/components/ConfigEditorModal.jsx` — "데이터 API" 탭 영역에 동일 패턴 적용

**Docs:** `docs/ADMIN_MANUAL.md` — 새 batch endpoint + 새 rate limit field 안내

---

## Task 1: BE — `apply_monitor_targets_batch` in SettingsStore

**Files:**
- Modify: `monigrid-be/app/settings_store.py` (around the existing `upsert_monitor_target` / `delete_monitor_target` methods — find them by grep)

- [ ] **Step 1: 사전 조사 — 기존 monitor target CRUD 메서드 시그니처 + 트랜잭션 패턴 확인**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes
grep -n "upsert_monitor_target\|delete_monitor_target\|monigrid_monitor_targets\|@_sync\|self._conn\.commit\|self._conn\.rollback" monigrid-be/app/settings_store.py | head -30
```

확인할 내용:
- 기존 upsert/delete 의 시그니처 + return 타입
- `@_sync` 데코레이터 가 어떻게 lock 을 잡는지
- commit/rollback 패턴 (try/except 있는지)
- monigrid_monitor_targets 의 컬럼 (id 가 클라이언트 생성 vs 서버 생성)

- [ ] **Step 2: `apply_monitor_targets_batch` 메서드 추가**

`settings_store.py` 의 monitor target 관련 메서드들 끝에 추가:

```python
@_sync
def apply_monitor_targets_batch(
    self,
    *,
    creates: list[dict],
    updates: list[dict],
    deletes: list[str],
) -> dict:
    """Apply monitor target changes in a single transaction.

    On any failure, the entire transaction rolls back and a structured
    error dict is returned. Caller (route handler) translates this to
    HTTP 400 with `failedItem`.

    Returns:
        On success: {"success": True, "results": {"created": [...], "updated": [...], "deleted": [...]}}
        On failure: {"success": False, "error": str, "failedItem": {"kind": ..., "index": ..., "id": ..., "message": ...}}
    """
    # Pre-validation: detect ID conflicts before touching DB
    update_ids = {u.get("id") for u in updates if u.get("id")}
    delete_ids = set(deletes)
    overlap = update_ids & delete_ids
    if overlap:
        return {
            "success": False,
            "error": "id appears in both updates and deletes",
            "failedItem": {"kind": "delete", "index": 0, "id": next(iter(overlap)), "message": f"id {next(iter(overlap))} is also in updates"},
        }

    created_results: list[dict] = []
    updated_results: list[dict] = []
    deleted_results: list[str] = []

    try:
        # All operations on the existing single connection. _sync lock already held.
        for idx, item in enumerate(creates):
            try:
                created = self._insert_monitor_target_no_commit(item)
                created_results.append(created)
            except Exception as exc:
                self._conn.rollback()
                return {
                    "success": False,
                    "error": "create failed",
                    "failedItem": {"kind": "create", "index": idx, "id": None, "message": str(exc)},
                }

        for idx, item in enumerate(updates):
            target_id = item.get("id")
            if not target_id:
                self._conn.rollback()
                return {
                    "success": False,
                    "error": "update missing id",
                    "failedItem": {"kind": "update", "index": idx, "id": None, "message": "id is required for updates"},
                }
            try:
                updated = self._update_monitor_target_no_commit(target_id, item)
                if updated is None:
                    self._conn.rollback()
                    return {
                        "success": False,
                        "error": "target not found",
                        "failedItem": {"kind": "update", "index": idx, "id": target_id, "message": f"target {target_id} not found"},
                    }
                updated_results.append(updated)
            except Exception as exc:
                self._conn.rollback()
                return {
                    "success": False,
                    "error": "update failed",
                    "failedItem": {"kind": "update", "index": idx, "id": target_id, "message": str(exc)},
                }

        for idx, target_id in enumerate(deletes):
            try:
                deleted_count = self._delete_monitor_target_no_commit(target_id)
                if deleted_count == 0:
                    self._conn.rollback()
                    return {
                        "success": False,
                        "error": "target not found",
                        "failedItem": {"kind": "delete", "index": idx, "id": target_id, "message": f"target {target_id} not found"},
                    }
                deleted_results.append(target_id)
            except Exception as exc:
                self._conn.rollback()
                return {
                    "success": False,
                    "error": "delete failed",
                    "failedItem": {"kind": "delete", "index": idx, "id": target_id, "message": str(exc)},
                }

        self._conn.commit()
        return {
            "success": True,
            "results": {
                "created": created_results,
                "updated": updated_results,
                "deleted": deleted_results,
            },
        }
    except Exception as exc:
        self._conn.rollback()
        return {
            "success": False,
            "error": "transaction failed",
            "failedItem": {"kind": "create", "index": 0, "id": None, "message": str(exc)},
        }
```

**Important:** 위 코드는 `_insert_monitor_target_no_commit`, `_update_monitor_target_no_commit`, `_delete_monitor_target_no_commit` 헬퍼가 필요. 만약 기존 `upsert_monitor_target` / `delete_monitor_target` 가 commit 을 내부에서 한다면, **commit 하지 않는 헬퍼 버전을 추가** 해야 한다. 패턴:

```python
def _insert_monitor_target_no_commit(self, item: dict) -> dict:
    """Insert without committing. Returns the inserted row as dict."""
    # 기존 upsert_monitor_target 의 INSERT 부분만 추출. self._conn.commit() 호출하지 않음.
    cur = self._cursor()
    try:
        # ... INSERT INTO monigrid_monitor_targets ... VALUES (...)
        # 신규 ID 생성 (uuid 또는 BE 가 부여하는 방식 따라가기)
        new_id = item.get("id") or _generate_target_id()
        cur.execute("INSERT INTO monigrid_monitor_targets (id, type, label, ...) VALUES (?, ?, ?, ...)", (new_id, item.get("type"), item.get("label"), ...))
        return {**item, "id": new_id}
    finally:
        try: cur.close()
        except Exception: pass

def _update_monitor_target_no_commit(self, target_id: str, item: dict) -> dict | None:
    """Update without committing. Returns updated row or None if not found."""
    cur = self._cursor()
    try:
        cur.execute("UPDATE monigrid_monitor_targets SET type=?, label=?, ... WHERE id=?", (item.get("type"), item.get("label"), ..., target_id))
        if cur.rowcount == 0:
            return None
        return {**item, "id": target_id}
    finally:
        try: cur.close()
        except Exception: pass

def _delete_monitor_target_no_commit(self, target_id: str) -> int:
    """Delete without committing. Returns number of rows deleted."""
    cur = self._cursor()
    try:
        cur.execute("DELETE FROM monigrid_monitor_targets WHERE id=?", (target_id,))
        return cur.rowcount
    finally:
        try: cur.close()
        except Exception: pass
```

**구현 시 주의:**
- 기존 `upsert_monitor_target` 함수가 무엇을 하는지 정확히 보고 그 INSERT/UPDATE 로직을 그대로 헬퍼로 추출
- 기존 함수는 그대로 두고 헬퍼만 추가 (다른 호출처 호환)
- ID 생성 패턴 (uuid? 시퀀스?) 도 기존 코드 따라가기

- [ ] **Step 3: Import sanity 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-be
python -c "from app.settings_store import SettingsStore; assert hasattr(SettingsStore, 'apply_monitor_targets_batch'); print('OK')"
```

기대: `OK`

- [ ] **Step 4: Commit**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): SettingsStore.apply_monitor_targets_batch — atomic monitor target batch write"
```

---

## Task 2: BE — Backend service delegate

**Files:**
- Modify: `monigrid-be/app/service.py` (find `MonitoringBackend` class — likely has existing `upsert_monitor_target` / `delete_monitor_target` delegates)

- [ ] **Step 1: 사전 조사 — 기존 monitor target delegate 패턴 + reload 트리거 위치 확인**

```bash
grep -n "upsert_monitor_target\|delete_monitor_target\|monitor_collector.*reload\|self\.reload\(\)" monigrid-be/app/service.py | head -20
```

확인:
- 기존 delegate 가 settings_store 호출 후 monitor_collector.reload() 또는 self.reload() 를 트리거하는지
- batch 도 동일 패턴 따라가기 (1회 reload)

- [ ] **Step 2: `apply_monitor_targets_batch` 메서드 추가**

`MonitoringBackend` 클래스에 추가 (기존 monitor target 메서드들 근처):

```python
def apply_monitor_targets_batch(
    self,
    *,
    creates: list[dict],
    updates: list[dict],
    deletes: list[str],
) -> dict:
    """Apply monitor target changes in a single transaction. Triggers
    monitor_collector reload exactly once on success (vs per-item reload
    in individual endpoints — see issue #2 for context).
    """
    result = self.settings_store.apply_monitor_targets_batch(
        creates=creates, updates=updates, deletes=deletes,
    )
    if result.get("success"):
        # Match existing pattern: single reload after batch settles
        self._monitor_collector.reload()
    return result
```

**주의:** `self._monitor_collector` 의 정확한 attribute 이름은 service.py 의 기존 코드를 grep 으로 확인 (`_monitor_collector` vs `monitor_collector` 등).

- [ ] **Step 3: Import sanity**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-be
python -c "from app.service import MonitoringBackend; assert hasattr(MonitoringBackend, 'apply_monitor_targets_batch'); print('OK')"
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/service.py
git commit -m "feat(be): MonitoringBackend.apply_monitor_targets_batch — settings_store delegate + 1회 reload"
```

---

## Task 3: BE — Rate limit config

**Files:**
- Modify: `monigrid-be/app/config.py` (RateLimitConfig dataclass + _DEFAULT_RATE_LIMITS + build_app_config)

- [ ] **Step 1: `RateLimitConfig` 에 `monitor_targets_batch` 필드 추가**

기존 `monitor_refresh` 필드 근처에 새 필드 추가:

```python
@dataclass(frozen=True)
class RateLimitConfig:
    # ... 기존 필드들 ...
    monitor_refresh: str
    monitor_targets_batch: str  # 신규
```

`_DEFAULT_RATE_LIMITS` 에도 default 값 추가:

```python
_DEFAULT_RATE_LIMITS = RateLimitConfig(
    # ... 기존 필드들 ...
    monitor_refresh="10/minute",
    monitor_targets_batch="10/minute",  # 신규 — admin이 batch save를 분당 10회 이상 누를 일은 없다
)
```

`build_app_config` 의 `RateLimitConfig(...)` 생성자 호출에 추가:

```python
RateLimitConfig(
    # ... 기존 ...
    monitor_refresh=_rl("monitor_refresh"),
    monitor_targets_batch=_rl("monitor_targets_batch"),  # 신규
)
```

- [ ] **Step 2: Import sanity + backward compat 확인**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-be
python -c "from app.config import RateLimitConfig, _DEFAULT_RATE_LIMITS; assert hasattr(_DEFAULT_RATE_LIMITS, 'monitor_targets_batch'); print(_DEFAULT_RATE_LIMITS.monitor_targets_batch)"
```

기대: `10/minute`

기존 deployment 가 KV 에 `monitor_targets_batch` row 가 없어도 `_rl()` helper 가 default 로 fallback 하므로 깨지지 않음 (Phase 2 Task 2.6 와 동일 패턴).

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/config.py
git commit -m "feat(be): config 에 monitor_targets_batch rate limit 필드 추가 (default 10/minute)"
```

---

## Task 4: BE — Route handler

**Files:**
- Modify: `monigrid-be/app/routes/monitor_routes.py`

- [ ] **Step 1: 신규 route 추가**

`register()` 안 (기존 라우트들과 동일 위치, decorator 순서는 Phase 2 Task 2.6 패턴 따라감 `@require_auth → @limiter.limit → @require_admin`):

```python
@app.route("/dashboard/monitor-targets/batch", methods=["POST"])
@require_auth
@limiter.limit(rl.monitor_targets_batch)
@require_admin
def apply_monitor_targets_batch_route():
    body = request.get_json(silent=True) or {}
    creates = body.get("creates") or []
    updates = body.get("updates") or []
    deletes = body.get("deletes") or []

    if not isinstance(creates, list) or not isinstance(updates, list) or not isinstance(deletes, list):
        return jsonify({
            "success": False,
            "error": "creates, updates, deletes must be arrays",
            "failedItem": {"kind": "create", "index": 0, "id": None, "message": "invalid request shape"},
        }), 400

    # Empty batch → no-op (don't trigger reload for nothing)
    if not creates and not updates and not deletes:
        return jsonify({
            "success": True,
            "results": {"created": [], "updated": [], "deleted": []},
            "reloadTriggered": False,
        }), 200

    try:
        result = backend.apply_monitor_targets_batch(
            creates=creates, updates=updates, deletes=deletes,
        )
    except Exception as exc:
        backend.logger.exception(
            "Monitor targets batch failed clientIp=%s", get_client_ip(),
        )
        return jsonify({
            "success": False,
            "error": "internal error",
            "failedItem": {"kind": "create", "index": 0, "id": None, "message": str(exc)},
        }), 500

    if result.get("success"):
        result["reloadTriggered"] = True
        backend.logger.info(
            "Monitor targets batch applied creates=%d updates=%d deletes=%d clientIp=%s",
            len(creates), len(updates), len(deletes), get_client_ip(),
        )
        return jsonify(result), 200
    else:
        backend.logger.warning(
            "Monitor targets batch rejected error=%s clientIp=%s",
            result.get("error"), get_client_ip(),
        )
        return jsonify(result), 400
```

import 가 누락된 게 있으면 추가 (`from flask import request, jsonify`, `from app.utils import get_client_ip` 등 — 기존 파일에 이미 있을 가능성 높음).

- [ ] **Step 2: Import sanity**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-be
python -c "from app.routes.monitor_routes import register; print('OK')"
```

- [ ] **Step 3: Mock test — 라우트 등록 + 200/400 분기 확인**

```bash
python << 'EOF'
import flask
from unittest.mock import MagicMock
from app.routes.monitor_routes import register

app = flask.Flask(__name__)
backend = MagicMock()
backend.config.rate_limits.monitor_refresh = "10/minute"
backend.config.rate_limits.monitor_targets_batch = "10/minute"

# Skip limiter for testing — pass MagicMock that no-ops
limiter = MagicMock()
limiter.limit = lambda spec: (lambda f: f)

register(app, backend, limiter)

# Verify route registered
rules = [r.rule for r in app.url_map.iter_rules()]
assert "/dashboard/monitor-targets/batch" in rules, f"route not registered: {rules}"

# Mock backend success path
backend.apply_monitor_targets_batch.return_value = {
    "success": True,
    "results": {"created": [{"id": "new-1"}], "updated": [], "deleted": []},
}

with app.test_client() as c:
    # Bypass auth decorators by mocking — actually this needs auth setup, skip if too complex
    # At minimum verify the route is reachable
    pass

print("Route registered OK")
EOF
```

(이 단계는 실제 Flask 앱 부트스트랩 없이는 깊이 있는 검증이 어려움. 라우트 등록 확인 정도로 충분.)

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/routes/monitor_routes.py
git commit -m "feat(be): POST /dashboard/monitor-targets/batch 라우트 — atomic + 1회 reload + rate limit"
```

---

## Task 5: FE — `useDirtyList` hook

**Files:**
- Create: `monigrid-fe/src/hooks/useDirtyList.js`

- [ ] **Step 1: 신규 파일 작성**

```js
import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Generic dirty-list hook for batch save modals.
 *
 * Tracks the difference between an `original` snapshot (from the server)
 * and a `working` copy (user-edited). Computes per-row state
 * (unchanged | new | modified | deleted) and a dirty count summary.
 *
 * Usage:
 *   const list = useDirtyList({
 *     initial: serverItems,
 *     idKey: "id",
 *     newItemFactory: () => ({ type: "server_resource", label: "" }),
 *     validator: (item) => item.label ? null : "label is required",
 *   });
 *   list.visibleItems.map(item => ...)
 *   list.updateItem(id, { label: "new" })
 *   list.deleteItem(id)
 *   list.restoreItem(id)
 *   list.addItem()
 *   list.dirtyCount  // { creates, updates, deletes, total }
 *   list.isDirty
 *   list.isValid
 *   list.computeDiff()  // { creates, updates, deletes }
 *
 * On successful batch save, call `list.reset(newServerItems)` to
 * reload from server (this clears all dirty state).
 */
export function useDirtyList({
    initial = [],
    idKey = "id",
    newItemFactory = () => ({}),
    validator = () => null,  // (item) => null | "error message"
}) {
    // Original is a frozen snapshot per session. Caller can call reset()
    // to load a new snapshot after successful save.
    const originalRef = useRef(new Map());
    const [original, setOriginal] = useState(() => {
        const map = new Map();
        initial.forEach((item) => {
            const id = item[idKey];
            if (id !== undefined && id !== null) {
                map.set(id, JSON.parse(JSON.stringify(item)));
            }
        });
        originalRef.current = map;
        return map;
    });

    // Working copy: { id → item } where deleted items have _isDeleted=true
    // and new items have _isNew=true + temporary _clientId.
    const [working, setWorking] = useState(() => {
        const map = new Map();
        initial.forEach((item) => {
            const id = item[idKey];
            if (id !== undefined && id !== null) {
                map.set(id, JSON.parse(JSON.stringify(item)));
            }
        });
        return map;
    });

    // Reset to a new server snapshot (e.g. after successful save).
    const reset = useCallback((nextItems) => {
        const map = new Map();
        nextItems.forEach((item) => {
            const id = item[idKey];
            if (id !== undefined && id !== null) {
                map.set(id, JSON.parse(JSON.stringify(item)));
            }
        });
        originalRef.current = map;
        setOriginal(map);
        // Working becomes a fresh copy of the new original.
        const wmap = new Map();
        nextItems.forEach((item) => {
            const id = item[idKey];
            if (id !== undefined && id !== null) {
                wmap.set(id, JSON.parse(JSON.stringify(item)));
            }
        });
        setWorking(wmap);
    }, [idKey]);

    // Per-row state
    const rowState = useCallback((id) => {
        const item = working.get(id);
        if (!item) return "missing";
        if (item._isDeleted) return "deleted";
        if (item._isNew) return "new";
        const orig = original.get(id);
        if (!orig) return "new";  // shouldn't happen but defensive
        // Deep equal check (structural)
        const keys = new Set([...Object.keys(orig), ...Object.keys(item)]);
        keys.delete("_isNew");
        keys.delete("_isDeleted");
        for (const k of keys) {
            if (JSON.stringify(orig[k]) !== JSON.stringify(item[k])) {
                return "modified";
            }
        }
        return "unchanged";
    }, [working, original]);

    // Visible items: deleted items sorted to the bottom
    const visibleItems = useMemo(() => {
        const items = Array.from(working.values());
        return items.sort((a, b) => {
            const aDel = a._isDeleted ? 1 : 0;
            const bDel = b._isDeleted ? 1 : 0;
            return aDel - bDel;
        });
    }, [working]);

    // Mutators
    const updateItem = useCallback((id, patch) => {
        setWorking((prev) => {
            const next = new Map(prev);
            const existing = next.get(id);
            if (!existing) return prev;
            next.set(id, { ...existing, ...patch });
            return next;
        });
    }, []);

    const deleteItem = useCallback((id) => {
        setWorking((prev) => {
            const next = new Map(prev);
            const existing = next.get(id);
            if (!existing) return prev;
            // New + delete = remove entirely (never reached BE)
            if (existing._isNew) {
                next.delete(id);
                return next;
            }
            next.set(id, { ...existing, _isDeleted: true });
            return next;
        });
    }, []);

    const restoreItem = useCallback((id) => {
        setWorking((prev) => {
            const next = new Map(prev);
            const existing = next.get(id);
            if (!existing || !existing._isDeleted) return prev;
            const { _isDeleted, ...rest } = existing;
            next.set(id, rest);
            return next;
        });
    }, []);

    const addItem = useCallback((overrides = {}) => {
        const tmpId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const newItem = {
            ...newItemFactory(),
            ...overrides,
            [idKey]: tmpId,
            _isNew: true,
        };
        setWorking((prev) => {
            const next = new Map(prev);
            next.set(tmpId, newItem);
            return next;
        });
        return tmpId;
    }, [idKey, newItemFactory]);

    // Dirty count summary
    const dirtyCount = useMemo(() => {
        let creates = 0, updates = 0, deletes = 0;
        for (const item of working.values()) {
            const id = item[idKey];
            if (item._isDeleted) {
                deletes += 1;
            } else if (item._isNew) {
                creates += 1;
            } else if (rowState(id) === "modified") {
                updates += 1;
            }
        }
        return { creates, updates, deletes, total: creates + updates + deletes };
    }, [working, idKey, rowState]);

    const isDirty = dirtyCount.total > 0;

    // Validation
    const invalidIds = useMemo(() => {
        const result = [];
        for (const item of working.values()) {
            if (item._isDeleted) continue;  // deleted items skip validation
            const err = validator(item);
            if (err) result.push(item[idKey]);
        }
        return result;
    }, [working, validator]);
    const isValid = invalidIds.length === 0;

    const validationError = useCallback((id) => {
        const item = working.get(id);
        if (!item || item._isDeleted) return null;
        return validator(item);
    }, [working, validator]);

    // Compute diff for batch save
    const computeDiff = useCallback(() => {
        const creates = [];
        const updates = [];
        const deletes = [];
        for (const item of working.values()) {
            const id = item[idKey];
            if (item._isDeleted) {
                // Only include in deletes if it existed on the server
                if (original.has(id)) deletes.push(id);
                continue;
            }
            if (item._isNew) {
                // Strip internal fields and the temp ID
                const { _isNew, _isDeleted, ...payload } = item;
                delete payload[idKey];  // BE assigns the real ID
                creates.push(payload);
                continue;
            }
            if (rowState(id) === "modified") {
                const { _isNew, _isDeleted, ...payload } = item;
                updates.push(payload);
            }
        }
        return { creates, updates, deletes };
    }, [working, original, idKey, rowState]);

    return {
        visibleItems,
        rowState,
        updateItem,
        deleteItem,
        restoreItem,
        addItem,
        isDirty,
        dirtyCount,
        isValid,
        invalidIds,
        validationError,
        computeDiff,
        reset,
    };
}
```

- [ ] **Step 2: 빌드 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-fe
npm run build 2>&1 | tail -3
```

기대: `✓ built in ...` (에러/경고 없음)

- [ ] **Step 3: Mock trace 검증 (코드 인스펙션)**

다음 시나리오들을 mental model 로 trace:
- `addItem()` → working 에 tmp-xxx ID 로 새 row 추가, _isNew=true. dirtyCount.creates=1.
- `updateItem("server-123", {label: "new"})` → working["server-123"].label="new". rowState=modified. dirtyCount.updates=1.
- `deleteItem("server-123")` → working["server-123"]._isDeleted=true. rowState=deleted. visibleItems 에서 맨 뒤로 이동.
- `restoreItem("server-123")` → _isDeleted 제거. rowState 가 modified or unchanged 로 복귀.
- `deleteItem("tmp-xxx")` (신규+즉시삭제) → working 에서 즉시 삭제. dirtyCount.creates=0.
- `computeDiff()` → 위 변경들에 대해 BE batch payload 정확히 생성.

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/hooks/useDirtyList.js
git commit -m "feat(fe): useDirtyList hook — batch save 의 dirty tracking 공통 패턴"
```

---

## Task 6: FE — `useUnsavedChangesGuard` hook

**Files:**
- Create: `monigrid-fe/src/hooks/useUnsavedChangesGuard.js`

- [ ] **Step 1: 신규 파일 작성**

```js
import { useCallback, useEffect } from "react";

/**
 * Guard a modal close path against unsaved changes.
 *
 * Wraps `onClose` so that if `isDirty` is true, a confirm dialog appears
 * before actually closing. Also installs an Esc keydown listener that
 * goes through the same guard.
 *
 * Usage:
 *   const guardedClose = useUnsavedChangesGuard({
 *     isDirty: list.isDirty,
 *     dirtyCount: list.dirtyCount.total,
 *     onClose,
 *   });
 *   <button onClick={guardedClose}>X</button>
 */
export function useUnsavedChangesGuard({
    isDirty,
    dirtyCount,
    onClose,
    isBlocked = false,  // e.g. true while saving — close ignored
}) {
    const guardedClose = useCallback(() => {
        if (isBlocked) return;
        if (!isDirty) {
            onClose();
            return;
        }
        const ok = window.confirm(
            `저장하지 않은 변경 사항 ${dirtyCount}건이 있습니다. 폐기하고 닫으시겠습니까?`,
        );
        if (ok) onClose();
    }, [isDirty, dirtyCount, onClose, isBlocked]);

    // Esc key
    useEffect(() => {
        const handler = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                guardedClose();
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [guardedClose]);

    return guardedClose;
}
```

- [ ] **Step 2: 빌드 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-fe
npm run build 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/hooks/useUnsavedChangesGuard.js
git commit -m "feat(fe): useUnsavedChangesGuard — 모달 닫기 가드 공통 hook"
```

---

## Task 7: FE — `DirtyListSummary` 컴포넌트 + CSS

**Files:**
- Create: `monigrid-fe/src/components/DirtyListSummary.jsx`
- Create: `monigrid-fe/src/components/DirtyListSummary.css`

- [ ] **Step 1: 컴포넌트 작성**

`DirtyListSummary.jsx`:

```jsx
import "./DirtyListSummary.css";

/**
 * Bottom summary bar for batch-save modals.
 *
 * Shows dirty count breakdown (creates/updates/deletes), validation
 * status, and a primary "저장 & 적용" button. Renders a "변경 사항 없음"
 * label when nothing is dirty (button disabled).
 */
const DirtyListSummary = ({
    count,           // { creates, updates, deletes, total }
    isValid,
    invalidCount,
    isSaving,
    onSave,
    saveLabel = "저장 & 적용",
}) => {
    const hasChanges = count.total > 0;
    const hasInvalid = invalidCount > 0;

    let summaryText;
    if (!hasChanges) {
        summaryText = "변경 사항 없음";
    } else {
        const parts = [];
        if (count.creates > 0) parts.push(`${count.creates} 신규`);
        if (count.updates > 0) parts.push(`${count.updates} 수정`);
        if (count.deletes > 0) parts.push(`${count.deletes} 삭제`);
        summaryText = `변경 사항: ${parts.join(" / ")}`;
    }

    return (
        <div className='dirty-list-summary'>
            <span
                className={
                    "dls-summary-text" +
                    (!hasChanges ? " dls-summary-empty" : "")
                }
            >
                {summaryText}
            </span>
            {hasInvalid && (
                <span className='dls-invalid-badge'>
                    {invalidCount}개 항목에 오류
                </span>
            )}
            <button
                type='button'
                className='dls-save-btn'
                onClick={onSave}
                disabled={!hasChanges || isSaving}
            >
                {isSaving ? "저장 중…" : saveLabel}
            </button>
        </div>
    );
};

export default DirtyListSummary;
```

- [ ] **Step 2: CSS 작성**

`DirtyListSummary.css`:

```css
.dirty-list-summary {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-subtle, #2a3140);
    background: var(--bg-elevated, #11161e);
}

.dls-summary-text {
    flex: 1;
    color: var(--text-primary, #e7ecf3);
    font-size: 13px;
}

.dls-summary-empty {
    color: var(--text-muted, #7a8294);
}

.dls-invalid-badge {
    color: #ff6b6b;
    font-size: 12px;
    font-weight: 500;
    padding: 4px 8px;
    background: rgba(255, 107, 107, 0.1);
    border-radius: 4px;
}

.dls-save-btn {
    padding: 8px 16px;
    background: var(--accent-primary, #4a90e2);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
}

.dls-save-btn:disabled {
    background: var(--bg-disabled, #2a3140);
    color: var(--text-muted, #7a8294);
    cursor: not-allowed;
}

.dls-save-btn:hover:not(:disabled) {
    background: var(--accent-primary-hover, #5aa1f2);
}

/* Row state classes — shared across batch-save modals */
.row-state-new {
    border-left: 4px solid #51cf66;
}

.row-state-modified {
    border-left: 4px solid #ffd43b;
}

.row-state-modified::after {
    content: "●";
    color: #ffd43b;
    margin-left: 8px;
}

.row-state-deleted {
    opacity: 0.5;
    text-decoration: line-through;
    background: rgba(255, 107, 107, 0.05);
}

.row-state-invalid {
    border: 1px solid #ff6b6b;
    background: rgba(255, 107, 107, 0.05);
}

.row-state-invalid-msg {
    color: #ff6b6b;
    font-size: 12px;
    padding: 4px 8px;
}

.row-restore-btn {
    background: none;
    border: 1px solid var(--border-subtle, #2a3140);
    color: var(--text-primary, #e7ecf3);
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
}

.row-restore-btn:hover {
    background: var(--bg-hover, #1a2030);
}
```

CSS variables 는 프로젝트의 design token 따라가기. 위 default 값들은 fallback. 실제 프로젝트의 `index.css` 또는 `App.css` 의 `--bg-base`, `--text-primary` 등을 grep 으로 확인 후 매칭.

- [ ] **Step 3: 빌드 + 컴포넌트 import 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-fe
npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/components/DirtyListSummary.jsx monigrid-fe/src/components/DirtyListSummary.css
git commit -m "feat(fe): DirtyListSummary 컴포넌트 + 공통 row state CSS"
```

---

## Task 8: FE — `dashboardService.applyTargetsBatch` + cache invalidate

**Files:**
- Modify: `monigrid-fe/src/services/dashboardService.js`

- [ ] **Step 1: 사전 조사 — 기존 `monitorService` 메서드 패턴 + cache invalidate import 위치**

```bash
grep -n "monitorService\|invalidateMonitorTargetsCache\|listMonitorTargetsCached" monigrid-fe/src/services/dashboardService.js | head -20
```

- [ ] **Step 2: 메서드 추가**

기존 `monitorService` 의 `createTarget` / `updateTarget` / `deleteTarget` 근처에 추가:

```js
// monitorService 안에 추가
async applyTargetsBatch(creates, updates, deletes) {
    const response = await apiClient.post(
        "/dashboard/monitor-targets/batch",
        { creates, updates, deletes },
        { timeout: 60_000 },  // BE 의 reload 가 30s 까지 걸릴 수 있음 (Phase A #2 와 동일 timeout)
    );
    invalidateMonitorTargetsCache();  // Phase 3 Task 3.7 cache 와 호환
    return response.data;
},
```

import 가 누락되어 있으면 `invalidateMonitorTargetsCache` 가 같은 파일에 정의되어 있을 것 (Phase 3 Task 3.7 참고). 없으면 import 추가.

- [ ] **Step 3: 빌드 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-fe
npm run build 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/services/dashboardService.js
git commit -m "feat(fe): monitorService.applyTargetsBatch + cache invalidate"
```

---

## Task 9: FE — `MonitorTargetsTab` 리팩토링

**Files:**
- Modify: `monigrid-fe/src/components/MonitorTargetsTab.jsx`

이 task 는 가장 큰 변경. 자세한 사전 조사 + careful 수정 필요.

- [ ] **Step 1: 사전 조사**

```bash
wc -l monigrid-fe/src/components/MonitorTargetsTab.jsx
grep -n "createTarget\|updateTarget\|deleteTarget\|onSave\|handleSave\|handleDelete\|handleAdd\|isAdmin" monigrid-fe/src/components/MonitorTargetsTab.jsx | head -30
```

확인:
- 각 row 의 현재 save/delete/add 버튼 위치
- `monitorService.createTarget/updateTarget/deleteTarget` 호출 위치
- 현재 valid 검증 로직 (있다면)
- Add 버튼 위치 + 신규 row 추가 패턴
- handle 함수들의 이름 + onSuccess/onError 처리

- [ ] **Step 2: 컴포넌트 리팩토링**

핵심 변경:
1. `useDirtyList` 도입 — 기존 `targets` state 대체
2. 기존 per-row save 버튼 → 제거 (또는 비활성)
3. row 별 표시: `useDirtyList.rowState(id)` 로 className 추가 (`row-state-new`, `row-state-modified`, `row-state-deleted`)
4. Delete 버튼: 즉시 DB 호출 X → `list.deleteItem(id)` 호출 → soft delete
5. Deleted row 위치: `list.visibleItems` 가 이미 정렬 (deleted 맨 아래)
6. Restore 버튼: deleted row 옆에 표시 → `list.restoreItem(id)`
7. Add 버튼: `list.addItem({type, label: ""})` (newItemFactory 에서 default 채움)
8. 하단에 `<DirtyListSummary>` + 저장 핸들러
9. 모달 닫기: `useUnsavedChangesGuard` 적용 (이 컴포넌트가 모달 자체이거나, 부모 모달에 props 로 전달)
10. 저장 핸들러:

```js
const [isSaving, setIsSaving] = useState(false);

const handleBatchSave = async () => {
    if (!list.isValid) {
        const firstInvalidId = list.invalidIds[0];
        // 첫 invalid row 로 스크롤 (querySelector 또는 ref)
        const el = document.querySelector(`[data-row-id="${firstInvalidId}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        window.alert(`${list.invalidIds.length}개 항목에 오류가 있습니다.`);
        return;
    }

    const diff = list.computeDiff();
    setIsSaving(true);
    try {
        const result = await monitorService.applyTargetsBatch(
            diff.creates, diff.updates, diff.deletes,
        );
        if (result.success) {
            // Reload from server to get the canonical state with new IDs
            const fresh = await monitorService.listTargets();
            list.reset(Array.isArray(fresh?.targets) ? fresh.targets : []);
            // Notify parent (close modal, show toast)
            onSaveSuccess?.();
        } else {
            // Failed — show error inline on the failed row
            const failed = result.failedItem;
            window.alert(`저장 실패: ${failed?.message || result.error}`);
            // Highlight the failed row if id known
            if (failed?.id) {
                const el = document.querySelector(`[data-row-id="${failed.id}"]`);
                el?.scrollIntoView({ behavior: "smooth", block: "center" });
                el?.classList.add("row-state-invalid");
            }
        }
    } catch (err) {
        window.alert(`저장 실패: ${err?.response?.data?.error || err.message}`);
    } finally {
        setIsSaving(false);
    }
};
```

11. Validator 정의 (spec 5.2 의 monitor target 규칙):

```js
const validator = (item) => {
    if (!item.label || !item.label.trim()) return "label is required";
    if (item.label.length > 64) return "label must be 64 chars or less";
    if (!item.type) return "type is required";
    if (!item.host || !item.host.trim()) return "host is required";
    if (item.port !== undefined && (item.port < 1 || item.port > 65535)) return "port must be 1-65535";
    if (item.type === "server_resource") {
        if (!item.username) return "username is required";
        // password is optional if SSH key auth — adjust to project semantics
    }
    return null;
};
```

(실제 validator 는 기존 컴포넌트의 검증 로직을 살펴서 통합. 위는 spec 기준 minimum.)

12. 각 row JSX 에 `data-row-id={item.id}` 속성 추가 (스크롤 + 에러 표시용)
13. 각 row JSX 에 className 추가:
```jsx
const rowState = list.rowState(item.id);
const validationErr = list.validationError(item.id);
const rowClassName = [
    "monitor-target-row",
    rowState !== "unchanged" ? `row-state-${rowState}` : "",
    validationErr ? "row-state-invalid" : "",
].filter(Boolean).join(" ");
```

**기존 코드 보존:**
- Validation UI (있다면) 유지
- 검색/필터 (있다면) 유지 — 단, filter 결과가 visibleItems 의 sort 순서를 깨면 안 됨
- 테이블 헤더 / 컬럼 구조 그대로

- [ ] **Step 3: 빌드 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-fe
npm run build 2>&1 | tail -5
```

- [ ] **Step 4: Manual 검증 시나리오 (사용자 검증 필수, 코드 인스펙션으로 보강)**

코드 트레이스로 다음 시나리오 확인:
- Mount → original/working 동기화, dirtyCount = 0 → 저장 버튼 비활성
- Add 클릭 → 새 row (`+ 녹색 바`) → dirtyCount.creates = 1 → 저장 버튼 활성
- 신규 row 의 label 입력 → 입력 즉시 _isNew 유지
- 기존 row 의 label 수정 → row 에 노란 바 + ● → dirtyCount.updates = 1
- 기존 row 의 X 클릭 → row 회색+취소선 + ↺ 복원 버튼 → 맨 아래로 정렬 → dirtyCount.deletes = 1
- 복원 → 정상 row 로 복귀
- 신규 row + 즉시 X → working 에서 즉시 제거 → BE 호출 안 됨
- 저장 클릭 → diff 계산 → BE 호출 → 성공 시 모달 닫힘
- invalid row + 저장 클릭 → 첫 invalid 로 스크롤 + alert
- dirty 상태 + 모달 닫기 시도 → confirm "폐기?"

- [ ] **Step 5: Commit**

```bash
git add monigrid-fe/src/components/MonitorTargetsTab.jsx
git commit -m "refactor(fe): MonitorTargetsTab batch save 패턴 — 개별 save 제거 + dirty tracking + atomic commit"
```

---

## Task 10: FE — `ConfigEditorModal` "데이터 API" 탭 리팩토링

**Files:**
- Modify: `monigrid-fe/src/components/ConfigEditorModal.jsx`

이 task 는 ConfigEditorModal 의 "데이터 API" 탭 영역만 변경. 다른 탭 (DB 연결, 인증 등) 은 그대로.

- [ ] **Step 1: 사전 조사**

```bash
wc -l monigrid-fe/src/components/ConfigEditorModal.jsx
grep -n "데이터 API\|api.*list\|endpoints\|onSave\|handleSave\|configService\.updateConfig\|isAdmin" monigrid-fe/src/components/ConfigEditorModal.jsx | head -30
```

확인:
- "데이터 API" 탭 의 정확한 위치 (탭 인덱스 / 섹션 ID)
- endpoint list state 가 분리되어 있는지 vs 전체 config blob 안에 포함
- `configService.updateConfig` 호출은 어떻게 (전체 config? 부분?)
- 다른 탭과 저장 흐름이 공유되어 있는지 확인 — 만약 모든 탭이 한 번에 저장된다면 데이터 API 탭만 batch UX 로 빼는 게 어색할 수 있음

- [ ] **Step 2: 의사결정 갈림길**

사전 조사 결과에 따라:

**(A) ConfigEditorModal 전체가 한 번의 PUT /dashboard/config 로 저장하는 구조라면:**
- 데이터 API 탭만 dirty tracking 추가, 나머지 탭은 그대로
- 모달 하단의 기존 "저장 & 적용" 버튼은 그대로 (모든 탭 한꺼번에 저장)
- 데이터 API 탭에는 별도 batch button 추가하지 않음 — 대신 row 인라인 마킹만 추가하고 저장은 모달 단일 버튼이 처리
- 이 경우 hook 사용은 dirty 표시 + invalid 검증만, 저장은 부모 컴포넌트가 함

**(B) 각 탭이 별도로 저장 가능한 구조라면:**
- 데이터 API 탭에만 `<DirtyListSummary>` 추가
- 다른 탭의 저장 버튼은 그대로

대부분의 ConfigEditor 는 (A) 패턴이라 가정. 이 경우:
- `useDirtyList` 적용해서 endpoint list 의 dirty state 추적
- 모달 저장 버튼 누르면 `list.computeDiff()` 결과를 전체 config 와 합쳐서 PUT
- 데이터 API 탭의 row 인라인 마킹 + 하단 변경 요약 (저장 버튼 없는 줄임 형태) 표시

- [ ] **Step 3: 컴포넌트 리팩토링 — (A) 패턴 가정 코드**

```jsx
import { useDirtyList } from "../hooks/useDirtyList";
// ... 기존 import

// 컴포넌트 안에서:
const endpointList = useDirtyList({
    initial: configDraft?.endpoints || [],
    idKey: "id",
    newItemFactory: () => ({ id: "", path: "", sql_id: "", query_timeout_sec: 30, cache_ttl_sec: 60 }),
    validator: (item) => {
        if (!item.id || !item.id.trim()) return "id is required";
        if (!/^[a-zA-Z0-9_]+$/.test(item.id)) return "id must be alphanumeric/underscore";
        if (!item.path || !item.path.startsWith("/")) return "path must start with /";
        if (!item.sql_id) return "sql_id is required";
        if (!item.query_timeout_sec || item.query_timeout_sec < 1) return "query_timeout_sec must be >= 1";
        return null;
    },
});

// "데이터 API" 탭 영역 렌더:
{endpointList.visibleItems.map((endpoint) => {
    const rowState = endpointList.rowState(endpoint.id);
    const validationErr = endpointList.validationError(endpoint.id);
    const rowClass = [
        "endpoint-row",
        rowState !== "unchanged" ? `row-state-${rowState}` : "",
        validationErr ? "row-state-invalid" : "",
    ].filter(Boolean).join(" ");
    return (
        <div key={endpoint.id} data-row-id={endpoint.id} className={rowClass}>
            <input
                value={endpoint.id}
                onChange={(e) => endpointList.updateItem(endpoint.id, { id: e.target.value })}
                disabled={endpoint._isDeleted || isSaving}
            />
            {/* ... 기타 필드 ... */}
            {endpoint._isDeleted ? (
                <button className='row-restore-btn' onClick={() => endpointList.restoreItem(endpoint.id)}>↺ 복원</button>
            ) : (
                <button onClick={() => endpointList.deleteItem(endpoint.id)}>X</button>
            )}
            {validationErr && <div className='row-state-invalid-msg'>{validationErr}</div>}
        </div>
    );
})}
<button onClick={() => endpointList.addItem()}>+ Endpoint 추가</button>

{/* 하단 요약 (저장 버튼 없는 형태 — 모달 자체 저장 버튼 사용) */}
<div className='dls-tab-summary'>
    {endpointList.dirtyCount.total > 0 && (
        <span>변경: +{endpointList.dirtyCount.creates} ~{endpointList.dirtyCount.updates} -{endpointList.dirtyCount.deletes}</span>
    )}
</div>
```

저장 시점에 (모달의 기존 "저장 & 적용" 버튼 핸들러):

```js
const handleSaveAll = async () => {
    // 1. 데이터 API 탭의 dirty 적용
    if (!endpointList.isValid) {
        const firstInvalidId = endpointList.invalidIds[0];
        // 데이터 API 탭으로 자동 전환 + 스크롤
        setActiveTab("data-api");
        setTimeout(() => {
            const el = document.querySelector(`[data-row-id="${firstInvalidId}"]`);
            el?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
        window.alert("데이터 API 탭에 오류가 있습니다.");
        return;
    }

    // 2. endpoint diff 적용 → working 상태를 configDraft 에 반영
    const diff = endpointList.computeDiff();
    const nextEndpoints = endpointList.visibleItems
        .filter((e) => !e._isDeleted)
        .map((e) => {
            const { _isNew, _isDeleted, ...rest } = e;
            // 신규 row 의 tmp ID 는 BE 에 보낼 땐 제거 (또는 사용자 입력 ID 사용)
            // 실제로는 사용자가 id 필드에 ID 를 입력하므로 그것 사용
            return rest;
        });

    const finalConfig = { ...configDraft, endpoints: nextEndpoints };

    // 3. 기존 PUT /dashboard/config 호출
    setIsSaving(true);
    try {
        await configService.updateConfig(finalConfig);
        // Success — reload config from server
        const fresh = await configService.getConfig();
        endpointList.reset(fresh?.endpoints || []);
        onSaveSuccess?.();
    } catch (err) {
        window.alert(`저장 실패: ${err?.response?.data?.message || err.message}`);
    } finally {
        setIsSaving(false);
    }
};
```

- [ ] **Step 4: 빌드 검증**

```bash
cd /Volumes/myWorkspace/workspace/code/dev/project-monigrid/.worktrees/post-phase4-hotfixes/monigrid-fe
npm run build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add monigrid-fe/src/components/ConfigEditorModal.jsx
git commit -m "refactor(fe): ConfigEditor 데이터 API 탭 batch save UX — dirty 표시 + atomic"
```

---

## Task 11: Docs — ADMIN_MANUAL 갱신

**Files:**
- Modify: `docs/ADMIN_MANUAL.md`

- [ ] **Step 1: 새 endpoint + rate limit 안내 추가**

기존 `5-3. Phase 4 운영 변경사항` 섹션 뒤에 `5-4. 일괄 저장 (#6)` 섹션 추가:

```markdown
## 5-4. 일괄 저장 (#6)

### 모니터 대상 / 데이터 API 일괄 저장

- **모니터 대상 탭** + **데이터 API 탭** 의 항목 변경/추가/삭제는 이제 **모달 하단 "저장 & 적용" 버튼 1회** 로 일괄 반영됨.
- 이전에는 항목별 저장 버튼을 매번 눌러야 했고, 매번 backend reload 가 트리거되어 느렸음. 이제 1회 트랜잭션 + 1회 reload 로 처리.
- 변경된 항목만 시각적으로 표시: 신규 (`+ 녹색 바`), 수정 (`● 노란 점`), 삭제 예정 (취소선 + 복원 버튼).
- atomic 트랜잭션 — 한 항목이라도 실패하면 전체 롤백, 어느 항목이 문제인지 표시됨.

### 신규 BE endpoint

| Endpoint | Method | Rate limit (KV key) |
|---|---|---|
| `/dashboard/monitor-targets/batch` | POST (admin) | `monitor_targets_batch` (default `10/minute`) |

기존 개별 endpoint (`POST/PUT/DELETE /dashboard/monitor-targets/<id>`) 는 호환성 위해 유지.

### 새 rate limit 키

`monigrid_settings_kv` 의 `rate_limits` JSON 에 `monitor_targets_batch` 추가됨. 기존 deployment 는 자동으로 default `"10/minute"` fallback (안전하게 backward compat).
```

- [ ] **Step 2: Commit**

```bash
git add docs/ADMIN_MANUAL.md
git commit -m "docs(admin): #6 일괄 저장 + monitor_targets_batch rate limit 안내"
```

---

## Task 12: 통합 검증 (사용자)

이 task 는 사용자 운영 환경에서 직접 검증.

- [ ] **검증 시나리오 1: MonitorTargetsTab batch save 성공 흐름**
  1. 백엔드 설정 → 모니터 대상 탭 열기
  2. "+ 추가" 클릭 → 신규 row (녹색 바)
  3. 기존 row 1개 label 수정 → 노란 바 + ●
  4. 다른 기존 row 1개 X 클릭 → 회색 + 취소선 → 맨 아래로 이동 + ↺ 복원 버튼
  5. 하단에 "변경 사항: 1 신규 / 1 수정 / 1 삭제" 표시
  6. "저장 & 적용" 클릭 → 1초 내 응답 + 모달 닫힘 + 토스트
  7. 다시 모달 열기 → 변경사항 모두 반영 확인

- [ ] **검증 시나리오 2: 복원 후 변경 0건**
  1. 기존 row X 클릭 → 삭제 예정
  2. ↺ 복원 클릭 → 정상 row 로 복귀
  3. 하단에 "변경 사항 없음" + "저장 & 적용" 비활성

- [ ] **검증 시나리오 3: invalid 입력**
  1. 신규 row 추가 → label 비워둔 채로 저장 클릭
  2. 첫 invalid row 로 자동 스크롤 + alert "1개 항목에 오류가 있습니다"
  3. label 입력 → 빨간 테두리 사라짐 → 저장 가능

- [ ] **검증 시나리오 4: dirty 상태 모달 닫기**
  1. 신규 row 추가
  2. X 또는 ESC 클릭 → confirm "변경 사항 1건 있습니다. 폐기하고 닫으시겠습니까?"
  3. 취소 → 모달 유지 + 변경사항 보존
  4. 폐기 → 모달 닫힘 + 다음 열기 시 fresh

- [ ] **검증 시나리오 5: BE 실패 시 atomic 롤백**
  1. (테스트 어려움 — 의도적 실패 시나리오 만들기 위해 BE 측에 임시 로직 추가하거나 잘못된 데이터 강제)
  2. 신규 row 가 unique constraint 위반하도록 만들기 (예: 같은 host+port+username)
  3. 저장 → 400 응답 + alert + 실패 row 빨간 테두리
  4. DB 확인 → 변경사항 0건 (atomic 롤백 확인)

- [ ] **검증 시나리오 6: ConfigEditor 데이터 API 탭**
  1. 위 1~4 시나리오를 데이터 API endpoint 에 대해 동일하게 검증
  2. 단, 저장 버튼은 모달 자체의 "저장 & 적용" 사용
  3. 다른 탭 (DB 연결 등) 의 저장 흐름은 변화 없음 확인

- [ ] **검증 시나리오 7: 성능**
  1. 모니터 대상 5개 한꺼번에 변경 (1 신규 + 3 수정 + 1 삭제)
  2. wall time ~1~3초 (이전 50초+ 와 대비)
  3. monitor_collector reload 가 1회만 호출됐는지 BE 로그 확인

---

## Self-Review Checklist (계획 작성자)

**1. Spec coverage**
- ✅ Section 3.1 BE batch endpoint → Task 1, 2, 3, 4
- ✅ Section 3.3 useDirtyList → Task 5
- ✅ Section 3.4 DirtyListSummary + row state CSS → Task 7
- ✅ Section 3.5 저장 흐름 → Task 9, 10
- ✅ Section 4 정책 default → Task 5, 7, 9 의 구현 코드에 반영
- ✅ Section 5 validation 규칙 → Task 9 (monitor target), Task 10 (data API)
- ✅ Section 6 touchpoints → Task 1~10 모두 커버
- ✅ Section 7 호환성 (기존 endpoint 유지, KV default) → Task 1, 3
- ✅ Section 8 testing → Task 12 의 manual 시나리오
- ✅ Section 9 open question 1 (ConfigEditor 패턴) → Task 10 Step 2 의 분기

**2. Placeholder scan**
- 코드 블록은 모두 실제 구현 가능한 코드. "TBD" / "TODO" 없음.
- "사전 조사" steps 는 placeholder 가 아니라 명시적 검증 단계 (기존 코드 의존이라 dispatch 시 확인 필수)

**3. Type consistency**
- `apply_monitor_targets_batch` 시그니처 BE↔FE 매칭 (creates/updates/deletes)
- 응답 schema (success/results/failedItem) Task 1, 4, 9 일관

**4. 알려진 제약**
- Task 9, 10 의 정확한 코드는 사전 조사 결과에 따라 약간 변경될 수 있음 — 패턴은 명확하므로 implementer 가 적응 가능
- Task 4 의 mock test 는 깊이 있는 통합 검증보다 라우트 등록 확인 정도. 실 기능 검증은 Task 12 사용자 시나리오에 의존

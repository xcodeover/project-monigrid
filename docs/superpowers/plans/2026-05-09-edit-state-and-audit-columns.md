# Edit-State Coloring + Audit Columns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4개 설정 그리드에서 "상태" 컬럼을 제거하고 row 배경색으로 신규/수정/삭제 예정 상태를 표현, 그 자리에 `수정 시각` + `편집자` audit 컬럼을 추가한다.

**Architecture:** BE 는 `monigrid_apis` / `monigrid_monitor_targets` 두 테이블에 `updated_at`/`updated_by` 컬럼을 더하고, 저장 라우트가 JWT 의 `current_username()` 을 actor 로 받아 stamp 한다. 데이터 API 의 DELETE+INSERT 흐름은 prior state 와 비교해 미변경 row 의 audit 필드를 보존하는 로직을 추가한다. FE 는 `AuditCells` 컴포넌트로 두 컬럼을 그리고, CSS 로 row 배경색만 갱신한다.

**Tech Stack:** Python 3.13 (Flask, JayDeBeApi, JPype), MariaDB/MSSQL/Oracle (JDBC), React 18 + Vite

**Spec:** [docs/superpowers/specs/2026-05-09-edit-state-and-audit-columns-design.md](../specs/2026-05-09-edit-state-and-audit-columns-design.md)

---

## File Structure

### BE — modified files
- [monigrid-be/app/settings_store.py](../../../monigrid-be/app/settings_store.py)
  - `_ddl_statements()` (3 dialects) — schema 추가
  - `replace_apis()` / `_insert_api()` / `load_apis()` — audit 컬럼 + 보존 로직
  - `list_monitor_targets()` / `get_monitor_target()` — SELECT 에 audit 컬럼 추가
  - `_insert_monitor_target_no_commit()` / `_update_monitor_target_no_commit()` / `_upsert(also_set_updated_at=True)` 경로 — actor 주입
  - `apply_monitor_targets_batch()` — `actor` keyword 인자 추가
  - `_row_to_monitor_target()` — audit 두 필드 dict 에 포함
  - `connect()` — mariadb 세션 timezone UTC 고정
- [monigrid-be/app/service.py](../../../monigrid-be/app/service.py)
  - `apply_partial_config_reload(new_config_dict, *, actor: str = "")` — 시그니처 + 전달
  - `apply_monitor_targets_batch(*, creates, updates, deletes, actor: str = "")` — 시그니처 + 전달
- [monigrid-be/app/routes/dashboard_routes.py](../../../monigrid-be/app/routes/dashboard_routes.py)
  - `update_config()` — `current_username()` 추출 후 service 로 전달
- [monigrid-be/app/routes/monitor_routes.py](../../../monigrid-be/app/routes/monitor_routes.py)
  - `apply_monitor_targets_batch_route()` — 동일
- [monigrid-be/migrate_settings_db.py](../../../monigrid-be/migrate_settings_db.py)
  - 3 dialect 별 idempotent ALTER 추가

### BE — new files
- `monigrid-be/scripts/test_audit_columns.py` (scenario 스타일 통합 테스트)

### FE — modified files
- [monigrid-fe/src/pages/ConfigEditorPage.jsx](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx) — `ApisGrid` header + `ApiRow`
- [monigrid-fe/src/components/MonitorTargetsTab.jsx](../../../monigrid-fe/src/components/MonitorTargetsTab.jsx) — 3 row variants + 3 headers
- [monigrid-fe/src/pages/ConfigEditorPage.css](../../../monigrid-fe/src/pages/ConfigEditorPage.css) — row tints + grid templates
- [monigrid-fe/src/components/ConfigEditorModal.css](../../../monigrid-fe/src/components/ConfigEditorModal.css) — 동일 톤 (legacy 카드)

### FE — new files
- `monigrid-fe/src/components/AuditCells.jsx` (수정 시각 + 편집자 셀 + 포맷 헬퍼)

---

## Phase A — BE: Schema & DDL

### Task A1: 신규 설치 DDL 에 audit 컬럼 추가

**Files:**
- Modify: `monigrid-be/app/settings_store.py:150-178` (mariadb), `:253-263` and `:274-283` (mssql), `:366-393` (oracle)

- [ ] **Step 1: mariadb DDL 수정**

[settings_store.py:150-160](../../../monigrid-be/app/settings_store.py#L150-L160) 에서 `monigrid_apis` 끝부분에 두 컬럼 추가:

```sql
CREATE TABLE IF NOT EXISTS monigrid_apis (
    id VARCHAR(128) PRIMARY KEY,
    title VARCHAR(255),
    rest_api_path VARCHAR(512) NOT NULL,
    connection_id VARCHAR(128) NOT NULL,
    sql_id VARCHAR(128) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    refresh_interval_sec INT NOT NULL DEFAULT 5,
    query_timeout_sec INT NOT NULL DEFAULT 30,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

`monigrid_monitor_targets` ([:169-178](../../../monigrid-be/app/settings_store.py#L169-L178)) — `updated_by` 만 추가 (`updated_at` 이미 있음):

```sql
CREATE TABLE IF NOT EXISTS monigrid_monitor_targets (
    id VARCHAR(128) PRIMARY KEY,
    type VARCHAR(32) NOT NULL,
    label VARCHAR(255),
    spec LONGTEXT NOT NULL,
    interval_sec INT NOT NULL DEFAULT 30,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
```

- [ ] **Step 2: mssql DDL 수정**

[:253-263](../../../monigrid-be/app/settings_store.py#L253-L263) `monigrid_apis`:
```sql
IF OBJECT_ID('monigrid_apis', 'U') IS NULL
CREATE TABLE monigrid_apis (
    id NVARCHAR(128) PRIMARY KEY,
    title NVARCHAR(255),
    rest_api_path NVARCHAR(512) NOT NULL,
    connection_id NVARCHAR(128) NOT NULL,
    sql_id NVARCHAR(128) NOT NULL,
    enabled BIT NOT NULL DEFAULT 1,
    refresh_interval_sec INT NOT NULL DEFAULT 5,
    query_timeout_sec INT NOT NULL DEFAULT 30,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by NVARCHAR(128) NULL
)
```

[:274-283](../../../monigrid-be/app/settings_store.py#L274-L283) `monigrid_monitor_targets` — `updated_by NVARCHAR(128) NULL` 한 줄 추가.

- [ ] **Step 3: oracle DDL 수정**

[:366-393](../../../monigrid-be/app/settings_store.py#L366-L393) — `monigrid_apis` 에:
```sql
updated_at TIMESTAMP DEFAULT SYS_EXTRACT_UTC(SYSTIMESTAMP) NOT NULL,
updated_by VARCHAR2(128) NULL
```

`monigrid_monitor_targets` 에 `updated_by VARCHAR2(128) NULL` 추가.

- [ ] **Step 4: 부팅으로 신규 설치 DDL 검증**

빈 DB 상대로 새로 부트스트랩하는 테스트는 실제 환경에서 어렵다. 대신 `_ddl_statements("mariadb")` 를 직접 호출해 SQL 문자열에 `updated_at` / `updated_by` 가 포함되는지 단위 검증:

```python
# scripts/test_audit_columns.py 의 첫 시나리오로 추가 (Task C 에서 작성)
def scenario_a1_ddl_includes_audit_columns():
    from app.settings_store import _ddl_statements
    for dialect in ("mariadb", "mssql", "oracle"):
        ddls = _ddl_statements(dialect)
        apis_ddl = next(d for d in ddls if "monigrid_apis" in d and "CREATE TABLE" in d)
        targets_ddl = next(d for d in ddls if "monigrid_monitor_targets" in d and "CREATE TABLE" in d)
        assert "updated_at" in apis_ddl, f"{dialect}: monigrid_apis missing updated_at"
        assert "updated_by" in apis_ddl, f"{dialect}: monigrid_apis missing updated_by"
        assert "updated_by" in targets_ddl, f"{dialect}: monigrid_monitor_targets missing updated_by"
```

(이 시나리오는 Task C1 와 함께 구현)

- [ ] **Step 5: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): monigrid_apis/monitor_targets DDL에 updated_at/updated_by 추가 (3 dialects)"
```

---

### Task A2: 기존 설치용 idempotent 마이그레이션

**Files:**
- Modify: `monigrid-be/migrate_settings_db.py`

- [ ] **Step 1: 현재 마이그레이션 구조 파악**

[migrate_settings_db.py](../../../monigrid-be/migrate_settings_db.py) 를 통째로 읽어 dialect 분기와 등록된 마이그레이션 단계가 어떻게 되어 있는지 확인. 새 단계를 어디에 끼울지 결정.

- [ ] **Step 2: mariadb 마이그레이션 추가**

(파일 전체 구조에 따라 위치 조정) — column 존재 가드 SQL:

```python
def _migrate_mariadb_audit_columns(cur, logger):
    """Add updated_at/updated_by to monigrid_apis (idempotent),
    add updated_by to monigrid_monitor_targets (idempotent)."""
    db = cur.connection.jconn.getCatalog()  # current schema name; or pass via init_cfg
    checks = [
        ("monigrid_apis", "updated_at",
         "ALTER TABLE monigrid_apis ADD COLUMN updated_at TIMESTAMP NOT NULL "
         "DEFAULT CURRENT_TIMESTAMP"),
        ("monigrid_apis", "updated_by",
         "ALTER TABLE monigrid_apis ADD COLUMN updated_by VARCHAR(128) NULL"),
        ("monigrid_monitor_targets", "updated_by",
         "ALTER TABLE monigrid_monitor_targets ADD COLUMN updated_by VARCHAR(128) NULL"),
    ]
    for table, col, alter_sql in checks:
        cur.execute(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS "
            "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
            [db, table, col],
        )
        exists = (cur.fetchone()[0] or 0) > 0
        if exists:
            logger.info("migration: %s.%s already present — skip", table, col)
            continue
        logger.info("migration: adding %s.%s ...", table, col)
        cur.execute(alter_sql)
```

- [ ] **Step 3: mssql 마이그레이션 추가**

```python
def _migrate_mssql_audit_columns(cur, logger):
    checks = [
        ("monigrid_apis", "updated_at",
         "ALTER TABLE monigrid_apis ADD updated_at DATETIME2 NOT NULL "
         "CONSTRAINT df_apis_updated_at DEFAULT SYSUTCDATETIME()"),
        ("monigrid_apis", "updated_by",
         "ALTER TABLE monigrid_apis ADD updated_by NVARCHAR(128) NULL"),
        ("monigrid_monitor_targets", "updated_by",
         "ALTER TABLE monigrid_monitor_targets ADD updated_by NVARCHAR(128) NULL"),
    ]
    for table, col, alter_sql in checks:
        cur.execute(
            "SELECT COUNT(*) FROM sys.columns "
            "WHERE Name = ? AND Object_ID = OBJECT_ID(?)",
            [col, table],
        )
        exists = (cur.fetchone()[0] or 0) > 0
        if exists:
            logger.info("migration: %s.%s already present — skip", table, col)
            continue
        logger.info("migration: adding %s.%s ...", table, col)
        cur.execute(alter_sql)
```

- [ ] **Step 4: oracle 마이그레이션 추가**

```python
def _migrate_oracle_audit_columns(cur, logger):
    checks = [
        ("MONIGRID_APIS", "UPDATED_AT",
         "ALTER TABLE monigrid_apis ADD (updated_at TIMESTAMP "
         "DEFAULT SYS_EXTRACT_UTC(SYSTIMESTAMP) NOT NULL)"),
        ("MONIGRID_APIS", "UPDATED_BY",
         "ALTER TABLE monigrid_apis ADD (updated_by VARCHAR2(128) NULL)"),
        ("MONIGRID_MONITOR_TARGETS", "UPDATED_BY",
         "ALTER TABLE monigrid_monitor_targets ADD (updated_by VARCHAR2(128) NULL)"),
    ]
    for table, col, alter_sql in checks:
        cur.execute(
            "SELECT COUNT(*) FROM USER_TAB_COLUMNS "
            "WHERE TABLE_NAME = :1 AND COLUMN_NAME = :2",
            [table, col],
        )
        exists = (cur.fetchone()[0] or 0) > 0
        if exists:
            logger.info("migration: %s.%s already present — skip", table, col)
            continue
        logger.info("migration: adding %s.%s ...", table, col)
        cur.execute(alter_sql)
```

- [ ] **Step 5: 마이그레이션 dispatcher 등록**

기존 dispatcher (db_type 별 함수 호출 지점) 에 새 함수 호출 추가. 정확한 위치는 Step 1 에서 파악한 구조에 따름.

- [ ] **Step 6: 실 운영 DB 에 dry-run 검증**

운영 mariadb (192.168.0.71:3336) 에 마이그레이션을 실행해 idempotency 와 컬럼 추가 확인:

```bash
cd monigrid-be && python3 migrate_settings_db.py
# 두 번 연속 실행 — 두 번째는 "already present — skip" 로그만 나와야 함
```

`SHOW COLUMNS FROM monigrid_apis;` 로 두 컬럼 존재 확인.

- [ ] **Step 7: Commit**

```bash
git add monigrid-be/migrate_settings_db.py
git commit -m "feat(be): idempotent migration for updated_at/updated_by columns"
```

---

## Phase B — BE: Store Layer (audit fields in SELECT/INSERT/UPDATE)

### Task B1: monitor_targets SELECT 에 audit 컬럼 추가

**Files:**
- Modify: `monigrid-be/app/settings_store.py:996-1026, 2242-2255`

- [ ] **Step 1: SELECT 문 수정**

[list_monitor_targets:996](../../../monigrid-be/app/settings_store.py#L996) 와 [get_monitor_target:1011](../../../monigrid-be/app/settings_store.py#L1011) 의 SELECT 두 군데에 `, updated_at, updated_by` 추가:

```python
cur.execute(
    "SELECT id, type, label, spec, interval_sec, enabled, "
    "updated_at, updated_by "
    "FROM monigrid_monitor_targets"
)
```

[get_monitor_target:1015](../../../monigrid-be/app/settings_store.py#L1015) 도 동일하게.

- [ ] **Step 2: `_row_to_monitor_target` 매핑 확장**

[settings_store.py:2242-2255](../../../monigrid-be/app/settings_store.py#L2242-L2255) `_row_to_monitor_target`:

```python
def _row_to_monitor_target(row: Any) -> dict[str, Any]:
    spec_text = _read_clob(row[3]) if row[3] is not None else ""
    try:
        spec = json.loads(spec_text) if spec_text else {}
    except json.JSONDecodeError:
        spec = {}
    return {
        "id":           str(row[0]),
        "type":         str(row[1]),
        "label":        row[2],
        "spec":         spec,
        "interval_sec": int(row[4]),
        "enabled":      bool(row[5]),
        "updated_at":   _to_utc_iso8601(row[6]),
        "updated_by":   row[7] if row[7] else None,
    }
```

- [ ] **Step 3: `_to_utc_iso8601` 헬퍼 추가**

[settings_store.py 파일 하단 헬퍼 섹션](../../../monigrid-be/app/settings_store.py) (예: `_extract_table_name` 근처) 에:

```python
def _to_utc_iso8601(value: Any) -> str | None:
    """Convert any datetime-ish value to a UTC ISO8601 string with 'Z'.

    Accepts: datetime, java.sql.Timestamp (via JayDeBeApi), str.
    Returns None on missing/falsy.
    """
    if value is None or value == "":
        return None
    from datetime import datetime, timezone
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    s = str(value).strip()
    if not s:
        return None
    # JayDeBeApi 가 string 으로 돌려주는 경우 — "YYYY-MM-DD HH:MM:SS[.fff]" 형식
    try:
        if "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError):
        return s  # 마지막 방어 — 원본 문자열 그대로
```

- [ ] **Step 4: scenario test — list_monitor_targets 가 audit 필드 포함**

`scripts/test_audit_columns.py` 에 시나리오 추가 (Task C1 에서 함께 작성):
```python
def scenario_b1_list_monitor_targets_returns_audit_fields():
    """기존 row 하나를 select — updated_at 은 ISO8601 Z, updated_by 는 None or str."""
    from app.settings_store import SettingsStore, load_init_settings
    cfg = load_init_settings("monigrid-be/initsetting.json")
    store = SettingsStore(settings_db=cfg, logger=__import__("logging").getLogger("test"))
    store.connect()
    targets = store.list_monitor_targets()
    assert targets, "DB 에 모니터 타깃이 최소 1건 있어야 함 (시드)"
    t = targets[0]
    assert "updated_at" in t and "updated_by" in t
    if t["updated_at"]:
        assert t["updated_at"].endswith("Z"), f"updated_at must end with Z: {t['updated_at']!r}"
    store.close()
```

- [ ] **Step 5: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): list/get_monitor_target 응답에 updated_at/updated_by ISO8601 포함"
```

---

### Task B2: monitor_targets INSERT/UPDATE 에 actor 주입

**Files:**
- Modify: `monigrid-be/app/settings_store.py:1029-1072` (`upsert_monitor_target`), `:1144-1232` (`_insert_/_update_no_commit`), `:1234` (`apply_monitor_targets_batch`)

- [ ] **Step 1: `_insert_monitor_target_no_commit(item, *, actor: str = "")` 시그니처 + INSERT SQL 확장**

[settings_store.py:1144](../../../monigrid-be/app/settings_store.py#L1144) — INSERT 컬럼 리스트에 `updated_at, updated_by` 추가, VALUES 에 `CURRENT_TIMESTAMP, ?`. actor 빈 문자열이면 `None` 으로 넘김:

```python
def _insert_monitor_target_no_commit(
    self, item: dict[str, Any], *, actor: str = "",
) -> dict[str, Any]:
    target_type, label, spec_json, interval_sec, enabled = (
        self._prepare_monitor_target_fields(item)
    )
    target_id = str(item["id"]).strip()
    actor_val = (actor or "").strip() or None
    cur = self._cursor()
    try:
        cur.execute(
            "INSERT INTO monigrid_monitor_targets "
            "(id, type, label, spec, interval_sec, enabled, updated_by) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [target_id, target_type, label, spec_json, interval_sec, enabled, actor_val],
        )
    finally:
        try: cur.close()
        except Exception: pass
    return self._get_monitor_target_no_commit(target_id)
```

(`updated_at` 은 DDL `DEFAULT CURRENT_TIMESTAMP` 가 채움)

- [ ] **Step 2: `_update_monitor_target_no_commit` 도 동일**

[settings_store.py:1176-1232](../../../monigrid-be/app/settings_store.py#L1176-L1232):

```python
def _update_monitor_target_no_commit(
    self, target_id: str, item: dict[str, Any], *, actor: str = "",
) -> dict[str, Any] | None:
    # ... 기존 검증 로직 ...
    actor_val = (actor or "").strip() or None
    cur = self._cursor()
    try:
        cur.execute(
            "UPDATE monigrid_monitor_targets "
            "SET type = ?, label = ?, spec = ?, interval_sec = ?, enabled = ?, "
            "    updated_at = CURRENT_TIMESTAMP, updated_by = ? "
            "WHERE id = ?",
            [target_type, label, spec_json, interval_sec, enabled, actor_val, target_id],
        )
        affected = cur.rowcount
    finally:
        try: cur.close()
        except Exception: pass
    if affected == 0:
        return None
    return self._get_monitor_target_no_commit(target_id)
```

- [ ] **Step 3: `apply_monitor_targets_batch` 시그니처 확장 + 전달**

[settings_store.py:1234-1240](../../../monigrid-be/app/settings_store.py#L1234-L1240):

```python
def apply_monitor_targets_batch(
    self,
    *,
    creates: list[dict],
    updates: list[dict],
    deletes: list[str],
    actor: str = "",
) -> dict:
    # 본문 안의 _insert_monitor_target_no_commit / _update_monitor_target_no_commit
    # 호출에 actor=actor 키워드 전달
```

[L1281](../../../monigrid-be/app/settings_store.py#L1281): `row = self._insert_monitor_target_no_commit(item, actor=actor)`
[L1305](../../../monigrid-be/app/settings_store.py#L1305): `row = self._update_monitor_target_no_commit(target_id, item, actor=actor)`

- [ ] **Step 4: `upsert_monitor_target` (단건 경로) 도 actor 지원**

[settings_store.py:1029](../../../monigrid-be/app/settings_store.py#L1029) — keyword `actor: str = ""` 추가하고 `_upsert(values=..., also_set_updated_at=True, actor=actor)` 패턴 또는 직접 SQL 확장. `_upsert` 내부도 함께 갱신.

(검색: `def _upsert(` — Task B3 에서 다룬다.)

- [ ] **Step 5: scenario test — actor 가 stamp 되는지 검증**

```python
def scenario_b2_actor_stamped_on_batch_update():
    """batch update 시 updated_by 가 actor 로 채워진다."""
    from app.settings_store import SettingsStore, load_init_settings
    store = _open_store()
    targets = store.list_monitor_targets()
    assert targets, "seed targets 필요"
    victim = targets[0]
    new_label = f"{victim['label']}_audited"

    result = store.apply_monitor_targets_batch(
        creates=[],
        updates=[{**victim, "label": new_label}],
        deletes=[],
        actor="test-actor",
    )
    assert result["success"], result
    refreshed = store.get_monitor_target(victim["id"])
    assert refreshed["updated_by"] == "test-actor"
    # 원복
    store.apply_monitor_targets_batch(
        creates=[], updates=[{**victim}], deletes=[], actor="cleanup",
    )
    store.close()
```

- [ ] **Step 6: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): monitor_targets INSERT/UPDATE에 actor 주입 + apply_monitor_targets_batch(actor=...)"
```

---

### Task B3: `_upsert` 헬퍼에 actor 지원 추가

**Files:**
- Modify: `monigrid-be/app/settings_store.py` — `_upsert` 정의 위치

- [ ] **Step 1: `_upsert` 시그니처 확인**

```bash
grep -n "def _upsert" monigrid-be/app/settings_store.py
```

- [ ] **Step 2: `_upsert(... actor: str = "")` 추가**

값 dict 안에 `updated_by` 가 들어가지 않은 경우, actor 가 비어있지 않으면 추가:

```python
def _upsert(
    self,
    *,
    table: str,
    key_col: str,
    key_value: Any,
    values: dict[str, Any],
    also_set_updated_at: bool = False,
    actor: str = "",
) -> None:
    final_values = dict(values)
    if actor and "updated_by" not in final_values:
        final_values["updated_by"] = actor.strip() or None
    # ... 기존 로직, INSERT/UPDATE 양쪽에서 final_values 사용 ...
```

(이미 `also_set_updated_at` 로직이 `updated_at = CURRENT_TIMESTAMP` 를 처리하면, `updated_by` 는 일반 값으로 처리 가능.)

- [ ] **Step 3: `upsert_monitor_target` 가 actor 를 _upsert 로 전달**

Task B2 Step 4 에서 미뤄둔 부분. 본문에서:

```python
self._upsert(
    table="monigrid_monitor_targets",
    key_col="id",
    key_value=target_id,
    values={...},
    also_set_updated_at=True,
    actor=actor,
)
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): _upsert helper accepts actor for updated_by stamping"
```

---

### Task B4: monigrid_apis SELECT 에 audit 컬럼 추가

**Files:**
- Modify: `monigrid-be/app/settings_store.py:856-882` (`load_apis`)

- [ ] **Step 1: SELECT 문 + dict 매핑 확장**

[settings_store.py:856-882](../../../monigrid-be/app/settings_store.py#L856-L882):

```python
@_sync
def load_apis(self) -> list[dict[str, Any]]:
    cur = self._cursor()
    try:
        cur.execute(
            "SELECT id, title, rest_api_path, connection_id, sql_id, enabled, "
            "refresh_interval_sec, query_timeout_sec, updated_at, updated_by "
            "FROM monigrid_apis"
        )
        rows = cur.fetchall()
    finally:
        try: cur.close()
        except Exception: pass
    return [
        {
            "id": row[0],
            "title": row[1],
            "rest_api_path": row[2],
            "connection_id": row[3],
            "sql_id": row[4],
            "enabled": bool(row[5]),
            "refresh_interval_sec": int(row[6]),
            "query_timeout_sec": int(row[7]),
            "updated_at": _to_utc_iso8601(row[8]),
            "updated_by": row[9] if row[9] else None,
        }
        for row in rows
    ]
```

- [ ] **Step 2: scenario test 추가**

```python
def scenario_b4_load_apis_returns_audit_fields():
    store = _open_store()
    apis = store.load_apis()
    assert apis, "seed apis 필요"
    a = apis[0]
    assert "updated_at" in a and "updated_by" in a
    if a["updated_at"]:
        assert a["updated_at"].endswith("Z")
    store.close()
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): load_apis 응답에 updated_at/updated_by 포함"
```

---

### Task B5: monigrid_apis INSERT — audit 보존 logic + actor 주입

**Files:**
- Modify: `monigrid-be/app/settings_store.py:823-854` (`replace_apis`, `_insert_api`)

설계 노트: `replace_apis` 는 DELETE+INSERT 패턴이라 그대로 두면 매 저장마다 모든 row 의 `updated_at` 이 갱신된다. 변경되지 않은 row 는 prior 값을 보존해야 한다.

- [ ] **Step 1: `replace_apis(apis, *, actor: str = "")` 시그니처 + diff-and-preserve**

```python
def replace_apis(
    self, apis: Iterable[dict[str, Any]], *, actor: str = "",
) -> None:
    """Replace all rows in monigrid_apis. Preserves audit fields (updated_at,
    updated_by) for rows whose business content hasn't changed; stamps fresh
    audit values on new or content-changed rows.

    actor: caller's username. Empty string → updated_by stays NULL on changed rows.
    """
    new_list = list(apis)
    prior_by_id = {a["id"]: a for a in self._load_apis_no_commit()}
    self._execute_simple("DELETE FROM monigrid_apis")
    actor_val = (actor or "").strip() or None
    for item in new_list:
        prior = prior_by_id.get(item["id"])
        if prior and _api_business_equal(prior, item):
            # 내용 미변경 — prior audit 보존
            self._insert_api_with_audit(
                item,
                updated_at_iso=prior.get("updated_at"),  # ISO8601 Z
                updated_by=prior.get("updated_by"),
            )
        else:
            # 신규 또는 변경 — 현재 시각 + actor 로 stamp
            self._insert_api_with_audit(
                item,
                updated_at_iso=None,  # None → DB DEFAULT CURRENT_TIMESTAMP
                updated_by=actor_val,
            )
    self._conn.commit()


def _load_apis_no_commit(self) -> list[dict[str, Any]]:
    """동일 SELECT, but without @_sync (호출자 이미 lock 보유)."""
    cur = self._cursor()
    try:
        cur.execute(
            "SELECT id, title, rest_api_path, connection_id, sql_id, enabled, "
            "refresh_interval_sec, query_timeout_sec, updated_at, updated_by "
            "FROM monigrid_apis"
        )
        rows = cur.fetchall()
    finally:
        try: cur.close()
        except Exception: pass
    return [
        {
            "id": row[0], "title": row[1], "rest_api_path": row[2],
            "connection_id": row[3], "sql_id": row[4], "enabled": bool(row[5]),
            "refresh_interval_sec": int(row[6]), "query_timeout_sec": int(row[7]),
            "updated_at": _to_utc_iso8601(row[8]),
            "updated_by": row[9] if row[9] else None,
        }
        for row in rows
    ]


def _insert_api_with_audit(
    self,
    item: dict[str, Any],
    *,
    updated_at_iso: str | None,
    updated_by: str | None,
) -> None:
    cur = self._cursor()
    try:
        if updated_at_iso:
            # ISO8601 'Z' → DB-native timestamp string. JayDeBeApi accepts
            # naive datetime; let Python convert.
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(updated_at_iso.replace("Z", "+00:00"))
            naive_utc = dt.astimezone(timezone.utc).replace(tzinfo=None)
            cur.execute(
                "INSERT INTO monigrid_apis "
                "(id, title, rest_api_path, connection_id, sql_id, enabled, "
                " refresh_interval_sec, query_timeout_sec, updated_at, updated_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    str(item["id"]),
                    item.get("title") or str(item["id"]),
                    str(item["rest_api_path"]),
                    str(item["connection_id"]),
                    str(item["sql_id"]),
                    1 if item.get("enabled", True) else 0,
                    int(item.get("refresh_interval_sec") or 5),
                    int(item.get("query_timeout_sec") or 30),
                    naive_utc,
                    updated_by,
                ],
            )
        else:
            # DB DEFAULT CURRENT_TIMESTAMP → updated_at 컬럼 생략
            cur.execute(
                "INSERT INTO monigrid_apis "
                "(id, title, rest_api_path, connection_id, sql_id, enabled, "
                " refresh_interval_sec, query_timeout_sec, updated_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    str(item["id"]),
                    item.get("title") or str(item["id"]),
                    str(item["rest_api_path"]),
                    str(item["connection_id"]),
                    str(item["sql_id"]),
                    1 if item.get("enabled", True) else 0,
                    int(item.get("refresh_interval_sec") or 5),
                    int(item.get("query_timeout_sec") or 30),
                    updated_by,
                ],
            )
    finally:
        try: cur.close()
        except Exception: pass
```

- [ ] **Step 2: `_api_business_equal` 헬퍼 추가**

비교 대상은 *비-audit 필드 전부* — `id`, `title`, `rest_api_path`, `connection_id`, `sql_id`, `enabled`, `refresh_interval_sec`, `query_timeout_sec`:

```python
def _api_business_equal(a: dict, b: dict) -> bool:
    keys = ("id", "title", "rest_api_path", "connection_id", "sql_id",
            "enabled", "refresh_interval_sec", "query_timeout_sec")
    def norm(d, k):
        v = d.get(k)
        if k == "enabled":
            return bool(v) if v is not None else True
        if k in ("refresh_interval_sec", "query_timeout_sec"):
            return int(v) if v is not None else (5 if "refresh" in k else 30)
        return None if v is None else str(v)
    return all(norm(a, k) == norm(b, k) for k in keys)
```

- [ ] **Step 3: 기존 `_insert_api` 호출자 정리**

`_insert_api` 가 `replace_apis` 외에 다른 곳에서 호출되는지:
```bash
grep -n "_insert_api\b" monigrid-be/app/settings_store.py
```
다른 호출자가 있으면 같은 audit 처리 적용. 없으면 `_insert_api` 를 제거하거나 `_insert_api_with_audit` 로 alias.

- [ ] **Step 4: scenario test — 미변경 row 의 audit 가 보존되는지**

```python
def scenario_b5_unchanged_api_preserves_audit():
    """replace_apis 에서 변경되지 않은 row 는 updated_at/updated_by 가 그대로 유지."""
    store = _open_store()
    apis_before = store.load_apis()
    assert len(apis_before) >= 1
    # 한 row 의 title 변경, 나머지 동일하게 다시 저장
    victim = apis_before[0]
    rest = apis_before[1:]
    if not rest:
        store.close()
        print("scenario_b5: skipped (need >= 2 apis)")
        return
    target = rest[0]
    target_audit_before = (target["updated_at"], target["updated_by"])

    new_list = [{**victim, "title": (victim["title"] or "") + "_x"}, *rest]
    store.replace_apis(new_list, actor="test-b5")

    apis_after = {a["id"]: a for a in store.load_apis()}
    # victim 은 actor 로 stamp
    assert apis_after[victim["id"]]["updated_by"] == "test-b5"
    # target 은 prior audit 보존
    assert apis_after[target["id"]]["updated_at"] == target_audit_before[0], \
        f"unchanged row's updated_at should be preserved, was: {apis_after[target['id']]['updated_at']!r} vs {target_audit_before[0]!r}"
    assert apis_after[target["id"]]["updated_by"] == target_audit_before[1]

    # 원복
    store.replace_apis(apis_before, actor="cleanup")
    store.close()
```

- [ ] **Step 5: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): replace_apis가 미변경 row의 audit 필드를 보존하고 변경분에만 actor stamp"
```

---

### Task B6: mariadb 세션 timezone 을 UTC 로 고정

**Files:**
- Modify: `monigrid-be/app/settings_store.py` — `connect()` 함수

- [ ] **Step 1: connect() 위치 확인**

```bash
grep -n "def connect" monigrid-be/app/settings_store.py
```

- [ ] **Step 2: mariadb 분기에서 timezone SET**

`connect()` 안에서 db_type 별 분기 발견 후, mariadb 인 경우 첫 statement 로:

```python
if self._cfg.db_type == "mariadb":
    cur = self._cursor()
    try:
        cur.execute("SET time_zone = '+00:00'")
    finally:
        try: cur.close()
        except Exception: pass
```

oracle 분기에 `ALTER SESSION SET TIME_ZONE = '+00:00'` 동일 패턴.
mssql 은 `DATETIME2` 가 timezone 없는 형식이고 모든 INSERT 가 `SYSUTCDATETIME()` 으로 통일되어 있으므로 별도 설정 불필요.

- [ ] **Step 3: scenario test — UTC 직렬화 확인**

```python
def scenario_b6_updated_at_serialized_as_utc():
    store = _open_store()
    if store.db_type != "mariadb":
        print("scenario_b6: only mariadb tested locally")
        store.close()
        return
    # 직접 simple SELECT — server-side now 와 비교
    cur = store._cursor()
    cur.execute("SELECT NOW()")
    server_now_naive = cur.fetchone()[0]
    cur.close()
    # session timezone 이 UTC 면 NOW() 도 UTC
    from datetime import datetime, timezone
    utc_now = datetime.now(timezone.utc).replace(tzinfo=None)
    delta = abs((utc_now - server_now_naive).total_seconds())
    assert delta < 60, f"server NOW() drift {delta}s — session not in UTC?"
    store.close()
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/settings_store.py
git commit -m "feat(be): mariadb/oracle 세션을 UTC timezone으로 고정해 timestamp 직렬화 일관성 확보"
```

---

## Phase C — BE: Service & Routes

### Task C1: Service 층 actor 시그니처 + 전달

**Files:**
- Modify: `monigrid-be/app/service.py:389-459, 461-477`

- [ ] **Step 1: `apply_partial_config_reload` 에 actor 추가**

[service.py:461](../../../monigrid-be/app/service.py#L461):

```python
def apply_partial_config_reload(
    self, new_config_dict: dict, *, actor: str = "",
) -> dict:
    from .config_diff import compute_config_diff
    with self._reload_lock:
        old_config = self.config
        self.settings_store.save_config_dict(new_config_dict, actor=actor)
        new_config = self._config_reloader()
        diff = compute_config_diff(old_config, new_config)
        result = self._apply_config_diff(diff, new_config)
        self.config = new_config
        self._check_classpath_for_reload(new_config)
        return result
```

- [ ] **Step 2: `save_config_dict(actor=...)` 시그니처도 확장**

[settings_store.py:1684](../../../monigrid-be/app/settings_store.py#L1684):

```python
def save_config_dict(
    self, config_dict: dict[str, Any], *, actor: str = "",
) -> None:
    self.save_scalar_sections(config_dict)
    self.replace_connections(config_dict.get("connections") or [])
    self.replace_apis(config_dict.get("apis") or [], actor=actor)
    self._conn.commit()
```

(connections 는 이번 범위 밖 — actor 전달 안 함)

- [ ] **Step 3: `apply_monitor_targets_batch` 도 동일**

[service.py:389](../../../monigrid-be/app/service.py#L389):

```python
def apply_monitor_targets_batch(
    self, *, creates, updates, deletes, actor: str = "",
) -> dict:
    with self._reload_lock:
        result = self.settings_store.apply_monitor_targets_batch(
            creates=creates, updates=updates, deletes=deletes, actor=actor,
        )
        # ... 기존 후속 로직 (config reload/notification) 유지
        return result
```

- [ ] **Step 4: 테스트 코드의 호출자 확인**

```bash
grep -rn "apply_partial_config_reload\|apply_monitor_targets_batch\|save_config_dict" monigrid-be/scripts monigrid-be/app
```

기존 호출자가 keyword 없이 호출하면 새 actor 파라미터의 default `""` 로 안전하게 통과 — 변경 불필요.

- [ ] **Step 5: Commit**

```bash
git add monigrid-be/app/service.py monigrid-be/app/settings_store.py
git commit -m "feat(be): service+store 계약에 actor keyword 전달 (default \"\" 호환)"
```

---

### Task C2: Routes — current_username() 추출 후 전달

**Files:**
- Modify: `monigrid-be/app/routes/dashboard_routes.py:184-225`, `monigrid-be/app/routes/monitor_routes.py:155-206`

- [ ] **Step 1: dashboard_routes.update_config()**

[dashboard_routes.py:184](../../../monigrid-be/app/routes/dashboard_routes.py#L184):

```python
from app.auth import current_username, require_admin, require_auth

@app.route("/dashboard/config", methods=["PUT"])
@require_auth
@require_admin
def update_config():
    client_ip = get_client_ip()
    username = current_username()  # JWT 에서 추출
    config_data = request.get_json(silent=True)
    if not config_data or not isinstance(config_data, dict):
        return jsonify({"message": "invalid config JSON"}), 400
    try:
        partial_result = backend.apply_partial_config_reload(
            config_data, actor=username,
        )
    except Exception:
        backend.logger.exception("Partial config reload failed clientIp=%s actor=%s",
                                 client_ip, username)
        # ...
```

- [ ] **Step 2: monitor_routes.apply_monitor_targets_batch_route()**

[monitor_routes.py:158](../../../monigrid-be/app/routes/monitor_routes.py#L158):

```python
def apply_monitor_targets_batch_route():
    body = request.get_json(silent=True) or {}
    username = current_username()
    # ... 기존 검증 ...
    try:
        result = backend.apply_monitor_targets_batch(
            creates=creates, updates=updates, deletes=deletes, actor=username,
        )
    # ...
```

`current_username` import 도 파일 상단에 추가.

- [ ] **Step 3: scenario test — 라이브 BE 로 PUT /dashboard/config 후 actor 검증**

```python
def scenario_c2_actor_propagated_through_route():
    """라이브 BE 가 5000 포트에서 떠 있어야 함. JWT 로 로그인 후
    /dashboard/config PUT — DB 의 updated_by 가 'admin' 으로 stamp 됨."""
    import requests, json
    BE = "http://127.0.0.1:5000"
    r = requests.post(f"{BE}/auth/login",
                      json={"username": "admin", "password": "admin"}, timeout=10)
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    H = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    cur = requests.get(f"{BE}/dashboard/config", headers=H, timeout=10).json()
    apis = list(cur.get("apis", []))
    if not apis:
        print("scenario_c2: skipped (no apis)")
        return
    victim = apis[0]
    new_title = (victim.get("title") or "x") + "_c2"
    new_apis = [{**victim, "title": new_title}, *apis[1:]]

    payload = {**cur, "apis": new_apis}
    r = requests.put(f"{BE}/dashboard/config", headers=H, data=json.dumps(payload), timeout=60)
    assert r.status_code == 200, r.text

    refreshed = requests.get(f"{BE}/dashboard/config", headers=H, timeout=10).json()
    found = next(a for a in refreshed["apis"] if a["id"] == victim["id"])
    assert found.get("updated_by") == "admin", f"expected updated_by=admin, got {found.get('updated_by')!r}"
    assert found.get("updated_at"), "updated_at must be present"

    # 원복
    payload2 = {**cur, "apis": [victim, *apis[1:]]}
    requests.put(f"{BE}/dashboard/config", headers=H, data=json.dumps(payload2), timeout=60)
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-be/app/routes/dashboard_routes.py monigrid-be/app/routes/monitor_routes.py
git commit -m "feat(be): routes에서 current_username()을 actor로 service에 전달"
```

---

## Phase D — BE: Tests

### Task D1: 통합 테스트 파일 작성 + 일괄 실행

**Files:**
- Create: `monigrid-be/scripts/test_audit_columns.py`

- [ ] **Step 1: 시나리오 묶음 파일 생성**

위 Task A/B/C 의 모든 scenario_* 함수를 한 파일에 모음. `_open_store()` 등 헬퍼 + main runner 패턴은 [test_partial_reload.py](../../../monigrid-be/scripts/test_partial_reload.py) 와 동일 구조:

```python
"""Audit columns (updated_at/updated_by) — integration scenarios.

Run with:
    python3 monigrid-be/scripts/test_audit_columns.py

Pure-state scenarios (a1, b1, b4, b5) work without BE.
Live-route scenario (c2) requires BE running on 127.0.0.1:5000.
"""
from __future__ import annotations
import sys, traceback

from monigrid_be_path_setup import setup
setup()

import logging
_logger = logging.getLogger("test_audit_columns")
logging.basicConfig(level=logging.WARNING)


def _open_store():
    from app.settings_store import SettingsStore, load_init_settings
    cfg = load_init_settings("monigrid-be/initsetting.json")
    store = SettingsStore(settings_db=cfg, logger=_logger)
    store.connect()
    return store


# ── scenario_a1_ddl_includes_audit_columns ──────────────────────────────────
# ... (Task A1 Step 4 에서 정의한 본문 그대로)

# ── scenario_b1_list_monitor_targets_returns_audit_fields ───────────────────
# ── scenario_b2_actor_stamped_on_batch_update ───────────────────────────────
# ── scenario_b4_load_apis_returns_audit_fields ──────────────────────────────
# ── scenario_b5_unchanged_api_preserves_audit ───────────────────────────────
# ── scenario_b6_updated_at_serialized_as_utc ────────────────────────────────
# ── scenario_c2_actor_propagated_through_route ──────────────────────────────


SCENARIOS = [
    scenario_a1_ddl_includes_audit_columns,
    scenario_b1_list_monitor_targets_returns_audit_fields,
    scenario_b2_actor_stamped_on_batch_update,
    scenario_b4_load_apis_returns_audit_fields,
    scenario_b5_unchanged_api_preserves_audit,
    scenario_b6_updated_at_serialized_as_utc,
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
```

- [ ] **Step 2: BE 가 떠 있는 상태에서 실행**

```bash
cd monigrid-be && python3 scripts/test_audit_columns.py
```

기대 출력:
```
[PASS] scenario_a1_ddl_includes_audit_columns
[PASS] scenario_b1_list_monitor_targets_returns_audit_fields
... (전부 PASS, 마지막 라인) "7/7 passed"
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-be/scripts/test_audit_columns.py
git commit -m "test(be): audit 컬럼 통합 시나리오 — DDL/SELECT/INSERT actor/route 전파/UTC"
```

---

## Phase E — FE: AuditCells & 포맷 헬퍼

### Task E1: 새 컴포넌트 + 헬퍼

**Files:**
- Create: `monigrid-fe/src/components/AuditCells.jsx`

- [ ] **Step 1: 파일 생성**

```jsx
/**
 * 백엔드 설정 그리드의 "수정 시각" / "편집자" 셀 렌더러.
 *
 * BE 응답: updated_at 은 UTC ISO8601 ('2026-05-09T05:23:14Z'), 또는 null.
 *          updated_by 는 string 또는 null.
 *
 * 표시 규칙:
 *   - null/missing → '—'
 *   - updated_at → 사용자 로컬 타임존으로 'YYYY-MM-DD HH:mm' 포맷
 *   - title 호버 → 원본 ISO 문자열 (정확한 초·타임존 확인용)
 */

const _DATE_FMT = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
});

export const formatLocalDateTime = (isoUtc) => {
    if (!isoUtc) return "—";
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return String(isoUtc);
    // 'YYYY/MM/DD, HH:mm' → 'YYYY-MM-DD HH:mm'
    return _DATE_FMT.format(d).replace(/[/.]/g, "-").replace(",", "");
};

const AuditCells = ({ updatedAt, updatedBy }) => (
    <>
        <span className="cfg-grid-audit-time" title={updatedAt || ""}>
            {formatLocalDateTime(updatedAt)}
        </span>
        <span className="cfg-grid-audit-user" title={updatedBy || ""}>
            {updatedBy || "—"}
        </span>
    </>
);

export default AuditCells;
```

- [ ] **Step 2: 브라우저 콘솔에서 헬퍼 자체 검증**

`npm run dev` 가 떠 있는 상태에서 브라우저 콘솔:
```js
// 임포트 어렵다면 컴포넌트 안에서 console.log 추가 후 한 row 만 확인
// 또는 unit-style smoke: import { formatLocalDateTime } from "/src/components/AuditCells.jsx";
// formatLocalDateTime("2026-05-09T05:23:14Z")  // → "2026-05-09 14:23" (KST)
// formatLocalDateTime(null)                     // → "—"
```

- [ ] **Step 3: Commit**

```bash
git add monigrid-fe/src/components/AuditCells.jsx
git commit -m "feat(fe): AuditCells 컴포넌트 + UTC→로컬 포맷 헬퍼"
```

---

## Phase F — FE: 그리드 변경

### Task F1: 데이터 API 그리드 — 헤더 + ApiRow 변경

**Files:**
- Modify: `monigrid-fe/src/pages/ConfigEditorPage.jsx:325-379` (`ApisGrid` header), `:173-322` (`ApiRow`)

- [ ] **Step 1: ApisGrid 헤더 수정**

[ConfigEditorPage.jsx:337-348](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx#L337-L348):

```jsx
<div className="cfg-grid cfg-grid-apis" role="grid">
    <div className="cfg-grid-row cfg-grid-head" role="row">
        <span>No</span>
        <span>활성</span>
        <span>API ID</span>
        <span>REST API Path</span>
        <span>Connection</span>
        <span>SQL ID</span>
        <span>주기(초)</span>
        <span>수정 시각</span>      {/* 신규 */}
        <span>편집자</span>          {/* 신규 */}
        <span></span>                {/* 액션 */}
    </div>
    {/* "상태" <span> 제거됨 */}
```

- [ ] **Step 2: ApiRow — RowFlags 셀을 AuditCells 로 교체**

[ConfigEditorPage.jsx:250-261](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx#L250-L261) 의 `<span className="cfg-grid-flags">...</span>` 블록 통째로 제거. 그 자리에:

```jsx
<AuditCells updatedAt={api.updated_at} updatedBy={api.updated_by} />
```

신규 row(`api._isNew`) 는 BE 응답에 audit 필드가 없으므로 자연스럽게 `"—"` 가 표시됨.

import 추가 (파일 상단):
```jsx
import AuditCells from "../components/AuditCells.jsx";
```

- [ ] **Step 3: 임계치 N 배지를 ⚠ 버튼 위로 이동**

[ConfigEditorPage.jsx:276-286](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx#L276-L286) 의 ⚠ 버튼:

```jsx
{!isDeleted && (
    <button
        type="button"
        className="cfg-row-action-btn cfg-thresholds-btn"
        onClick={() => onEditThresholds?.(api)}
        disabled={!isPersisted}
        title={isPersisted ? "알람 임계치 편집" : "신규 행은 저장 후 임계치 편집 가능"}
    >
        <span aria-hidden style={{ fontSize: 12, fontWeight: 700 }}>⚠</span>
        {!api._isNew && thresholdsCount > 0 && (
            <span
                className="cfg-thresholds-count-badge"
                aria-label={`임계치 ${thresholdsCount}개`}
            >
                {thresholdsCount}
            </span>
        )}
    </button>
)}
```

- [ ] **Step 4: 브라우저 검수**

`npm run dev` 가 떠 있는 상태에서 http://localhost:3000 → 로그인 → 백엔드 설정 → 데이터 API 탭 진입. 확인:
- "상태" 헤더 없어졌는가
- "수정 시각" / "편집자" 컬럼 보이는가
- 신규 row 추가 시 두 셀 모두 "—" 인가
- 기존 row 의 시각이 한국 시간으로 보이는가
- ⚠ 버튼 위에 임계치 카운트 배지가 보이는가 (있는 row 만)

- [ ] **Step 5: Commit**

```bash
git add monigrid-fe/src/pages/ConfigEditorPage.jsx
git commit -m "feat(fe): 데이터 API 그리드에서 상태 컬럼 제거 + 수정 시각/편집자 + 임계치 배지 이동"
```

---

### Task F2: MonitorTargetsTab 헤더 3종 + row 3종 변경

**Files:**
- Modify: `monigrid-fe/src/components/MonitorTargetsTab.jsx:431-483` (헤더), `:116-249` (`ServerResourceRow`), `:252-348` (`NetworkRow`), `:350-?` (`HttpStatusRow`)

- [ ] **Step 1: 3개 헤더에서 "상태" 제거 + audit 추가**

[MonitorTargetsTab.jsx:431-483](../../../monigrid-fe/src/components/MonitorTargetsTab.jsx#L431-L483):

```jsx
const TargetGridHeader = ({ targetType }) => {
    if (targetType === "server_resource") {
        return (
            <div className="cfg-grid-row cfg-grid-head" role="row">
                <span>No</span><span>활성</span><span>ID</span><span>이름</span>
                <span>주기(초)</span><span>호스트</span><span>OS 유형</span>
                <span>Username</span><span>Password</span>
                <span>CPU%</span><span>Mem%</span><span>Disk%</span>
                <span>수정 시각</span>      {/* 신규, 상태 자리 */}
                <span>편집자</span>          {/* 신규 */}
                <span></span>
            </div>
        );
    }
    if (targetType === "network") {
        return (
            <div className="cfg-grid-row cfg-grid-head" role="row">
                <span>No</span><span>활성</span><span>ID</span><span>이름</span>
                <span>주기(초)</span><span>유형</span><span>호스트</span>
                <span>Port</span><span>Timeout</span>
                <span>수정 시각</span>
                <span>편집자</span>
                <span></span>
            </div>
        );
    }
    return (
        <div className="cfg-grid-row cfg-grid-head" role="row">
            <span>No</span><span>활성</span><span>ID</span><span>이름</span>
            <span>주기(초)</span><span>URL</span><span>Timeout</span>
            <span>수정 시각</span>
            <span>편집자</span>
            <span></span>
        </div>
    );
};
```

- [ ] **Step 2: 3개 row 컴포넌트에서 RowFlags → AuditCells**

Import:
```jsx
import AuditCells from "./AuditCells.jsx";
```

`ServerResourceRow` ([L238](../../../monigrid-fe/src/components/MonitorTargetsTab.jsx#L238)) — `<RowFlags ... />` 한 줄을 다음으로 치환:

```jsx
<AuditCells updatedAt={target.updated_at} updatedBy={target.updated_by} />
```

`NetworkRow` ([L336](../../../monigrid-fe/src/components/MonitorTargetsTab.jsx#L336)) — 동일.
`HttpStatusRow` (350번 부근의 `<RowFlags ... />`) — 동일.

`RowFlags` 컴포넌트 자체는 더 이상 사용처가 없으면 삭제. (검색: `<RowFlags`)

- [ ] **Step 3: 브라우저 검수 — 3 탭 모두**

서버 리소스 / 네트워크 체크 / API 상태 각 탭에서:
- "상태" 헤더 없어졌는가
- 마지막 도메인 컬럼 다음에 수정 시각/편집자가 들어있는가
- 가로 스크롤이 잘 되는가
- 신규 row 추가 시 audit 셀 "—"

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/components/MonitorTargetsTab.jsx
git commit -m "feat(fe): 모니터 타깃 3 그리드에서 상태 컬럼 제거 + 수정 시각/편집자 추가"
```

---

## Phase G — FE: CSS

### Task G1: Row tint — 수정 row 를 노란색으로

**Files:**
- Modify: `monigrid-fe/src/pages/ConfigEditorPage.css:491-507`

- [ ] **Step 1: 색 톤 갱신**

```css
.cfg-grid-row.row-state-new {
    background: rgba(34, 197, 94, 0.10);   /* 연초록 — 알파 ↑ */
    box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.30);
}
.cfg-grid-row.row-state-modified {
    background: rgba(250, 204, 21, 0.12);  /* 노랑 (amber-400) */
    box-shadow: inset 0 0 0 1px rgba(250, 204, 21, 0.35);
}
.cfg-grid-row.row-state-deleted {
    background: rgba(239, 68, 68, 0.05);
    box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.20);
}
```

- [ ] **Step 2: ConfigEditorModal.css 도 동기화 (legacy 카드 view 가 살아 있다면)**

```bash
grep -n "row-state-new\|row-state-modified\|row-state-deleted" \
    monigrid-fe/src/components/ConfigEditorModal.css
```

같은 룰이 있으면 동일 톤으로 갱신.

- [ ] **Step 3: 브라우저 검수**

각 탭에서:
- 빈 row 추가 → 연초록 배경
- 기존 row 의 활성 토글 끄기 → 노랑 배경
- 기존 row 휴지통 → 빨강 + 흐림

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/pages/ConfigEditorPage.css monigrid-fe/src/components/ConfigEditorModal.css
git commit -m "style(fe): row state tint — 신규 연초록, 수정 노랑(파랑→노랑)"
```

---

### Task G2: grid-template-columns 갱신 (3 모니터 그리드)

**Files:**
- Modify: `monigrid-fe/src/pages/ConfigEditorPage.css:544-595`

- [ ] **Step 1: server_resource — 14 → 15 컬럼**

[ConfigEditorPage.css:544-561](../../../monigrid-fe/src/pages/ConfigEditorPage.css#L544-L561):

```css
.cfg-grid-monitor-server_resource .cfg-grid-row {
    grid-template-columns:
        46px                   /* No */
        46px                   /* 활성 */
        minmax(120px, 1fr)     /* ID */
        minmax(140px, 1.2fr)   /* 이름 */
        80px                   /* 주기 */
        minmax(140px, 1fr)     /* 호스트 */
        minmax(160px, 180px)   /* OS */
        minmax(120px, 1fr)     /* Username */
        minmax(150px, 1fr)     /* Password */
        70px                   /* CPU% */
        70px                   /* Mem% */
        70px                   /* Disk% */
        140px                  /* 수정 시각 */
        110px                  /* 편집자 */
        76px;                  /* 액션 */
    min-width: 1620px;
}
```

- [ ] **Step 2: network — 11 → 12 컬럼**

```css
.cfg-grid-monitor-network .cfg-grid-row {
    grid-template-columns:
        46px 46px
        minmax(120px, 1fr)
        minmax(140px, 1.2fr)
        80px
        minmax(120px, 140px)
        minmax(140px, 1.2fr)
        90px
        90px
        140px         /* 수정 시각 */
        110px         /* 편집자 */
        76px;
    min-width: 1320px;
}
```

- [ ] **Step 3: http_status — 9 → 10 컬럼**

```css
.cfg-grid-monitor-http_status .cfg-grid-row {
    grid-template-columns:
        46px 46px
        minmax(120px, 1fr)
        minmax(140px, 1.2fr)
        80px
        minmax(220px, 2fr)
        90px
        140px         /* 수정 시각 */
        110px         /* 편집자 */
        76px;
    min-width: 1240px;
}
```

- [ ] **Step 4: 데이터 API 그리드 — `cfg-grid-apis` 컬럼 정의 확인**

```bash
grep -n "cfg-grid-apis" monigrid-fe/src/pages/ConfigEditorPage.css \
    monigrid-fe/src/components/ConfigEditorModal.css
```

명시적 grid-template-columns 가 있으면 동일 패턴으로 audit 두 컬럼 추가. 없으면 (auto) 기본 동작 — 시각 검수에서 좁아지면 그때 정의.

- [ ] **Step 5: 브라우저 시각 검수**

3 탭 각각에서 가로 스크롤 시 컬럼이 잘리지 않고, 수정 시각/편집자가 정확히 보이는지.

- [ ] **Step 6: Commit**

```bash
git add monigrid-fe/src/pages/ConfigEditorPage.css
git commit -m "style(fe): 모니터 그리드 컬럼 정의 갱신 — 상태 제거 + audit 두 컬럼 추가"
```

---

### Task G3: 임계치 카운트 배지 CSS

**Files:**
- Modify: `monigrid-fe/src/pages/ConfigEditorPage.css` (또는 적절한 .css 파일)

- [ ] **Step 1: 배지 스타일 추가**

```css
/* 임계치 N 배지 — ⚠ 버튼 우상단에 absolute */
.cfg-thresholds-btn {
    position: relative;
}
.cfg-thresholds-count-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: #f59e0b;       /* amber-500 */
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85);
    pointer-events: none;
}
```

- [ ] **Step 2: 브라우저 검수**

데이터 API 탭에서 임계치가 정의된 row (예: scenario_b5 후의 row) 를 찾아 ⚠ 버튼 위에 작은 노랑 배지가 떠 있는지.

- [ ] **Step 3: 컬럼 audit cell 폰트/줄 정렬 보정**

```css
.cfg-grid-audit-time,
.cfg-grid-audit-user {
    color: var(--text-secondary, #475569);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    align-self: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
```

- [ ] **Step 4: Commit**

```bash
git add monigrid-fe/src/pages/ConfigEditorPage.css
git commit -m "style(fe): 임계치 카운트 배지(⚠ 버튼 우상단) + audit 셀 폰트"
```

---

## Phase H — End-to-End 검증

### Task H1: 라이브 서버 + 브라우저 통합 검증

- [ ] **Step 1: BE/FE 동시 가동**

```bash
# 별도 터미널 1
cd monigrid-be && FLASK_ENV=development USE_WAITRESS=0 python3 monigrid_be.py

# 별도 터미널 2
cd monigrid-fe && npm run dev
```

- [ ] **Step 2: BE 통합 테스트 통과**

```bash
cd monigrid-be && python3 scripts/test_audit_columns.py
# 7/7 passed
```

- [ ] **Step 3: 4 탭 골든패스 시나리오 (브라우저)**

http://localhost:3000 → admin/admin 로그인 → 백엔드 설정 → 위젯별 설정.

각 탭 (데이터 API / 서버 리소스 / 네트워크 체크 / API 상태) 에서:

A. **신규 row 추가** → 연초록 배경 + audit "—" → 저장 → 노란색 → 새 시각 + admin → 색 평상으로 복귀
B. **기존 row 수정** (활성 토글 또는 임의 필드) → 노랑 배경 → 저장 → 평상 + 새 audit 값
C. **row 삭제** → 빨강 흐림 → 저장 → 사라짐
D. **여러 탭 동시 dirty** → 각 탭의 색이 정확하게 표시
E. **데이터 API 탭의 ⚠ 버튼** → 임계치 등록된 row 만 카운트 배지

- [ ] **Step 4: 다른 사용자로 검증 (선택)**

`admin_user_routes` 로 두 번째 admin 계정 생성 후 그 계정으로 로그인해 row 수정 → audit 의 `편집자` 가 그 계정명으로 stamp 되는지.

- [ ] **Step 5: Audit 회귀 검증 — 미변경 row 의 audit 보존**

데이터 API 탭에서 1 row 만 수정해 저장 후, 다른 row 들의 "수정 시각" 이 변하지 않았는지 (저장 전후 한국 시간 비교).

이게 가장 중요한 회귀 체크 — `replace_apis` 의 audit-preserve 로직이 제대로 동작하는지 확인.

- [ ] **Step 6: 마지막 점검 — 콘솔/네트워크 패널**

브라우저 DevTools:
- 콘솔에 새 에러/경고 없는지
- Network 탭에서 `GET /dashboard/config` 응답에 `apis[].updated_at` / `apis[].updated_by` 가 들어 있는지
- `GET /monitor/targets` 응답도 동일

---

## Self-Review

### Spec coverage
- ✅ DDL 컬럼 추가 (apis: at+by, monitor_targets: by) — Task A1
- ✅ 마이그레이션 (3 dialects, idempotent) — Task A2
- ✅ SELECT 응답에 audit 포함 — Task B1, B4
- ✅ INSERT/UPDATE 에 actor 주입 — Task B2, B5
- ✅ 미변경 row 의 audit 보존 (replace_apis) — Task B5
- ✅ Timezone 통일 (mariadb/oracle UTC 세션) — Task B6
- ✅ Service/route 시그니처 — Task C1, C2
- ✅ AuditCells + UTC→로컬 포맷 — Task E1
- ✅ 4 그리드 헤더/row 변경 — Task F1, F2
- ✅ Row tint (수정 노랑) — Task G1
- ✅ Grid template + 임계치 배지 — Task G2, G3
- ✅ 통합 테스트 — Task D1
- ✅ E2E 골든패스 — Task H1

### Placeholder scan
- "구현 시 결정" 으로 미뤄둔 spec 항목은 plan 안에서 모두 구체화 (배지 색 #f59e0b, 데이터 API 가로 스크롤은 검수 후 결정 — 명시 됨, mariadb timezone 은 connect() 의 `SET time_zone='+00:00'` 으로 확정)
- 필요한 모든 SQL/JSX/CSS 코드가 인라인으로 들어가 있음

### Type consistency
- `actor: str = ""` 시그니처가 store/service/route 모두 일관 (default 빈 문자열 → DB NULL)
- `updated_at` 직렬화 형식: `YYYY-MM-DDTHH:MM:SS.sssZ` (또는 마이크로초 없는 형식) — `_to_utc_iso8601` 헬퍼가 일관 처리
- FE 의 `formatLocalDateTime` 입력은 `string | null | undefined`, 출력은 항상 string (`"—"` fallback)
- AuditCells props: `updatedAt`, `updatedBy` (camelCase) — 모든 호출자에서 동일

---

## Execution Plan 핸드오프

이 plan 은 18 task, 약 60 step. 각 task 끝에 commit 이 들어 있어서 단계별 review 에 적합.

권장 실행 모드는 **subagent-driven-development** — Phase 단위로 fresh subagent 가 task 를 실행하고, 사이에서 사용자가 결과를 리뷰. 또는 **executing-plans** 로 inline 실행하며 phase 끝에서 checkpoint.

추가 고려:
- BE 변경 시 dev BE 를 멈추고 재기동 필요 — 매 commit 마다 재기동하지 말고 Phase 단위로
- DB 마이그레이션 (Task A2) 은 idempotent 하지만 운영 DB 에 직접 영향 — 한 번 실행 후 두 번째 실행으로 idempotency 확인 필수
- FE HMR 은 자동 — CSS/JSX 변경은 즉시 반영

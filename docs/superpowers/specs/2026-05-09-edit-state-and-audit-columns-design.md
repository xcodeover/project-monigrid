# 편집 상태 시각화 변경 + Audit 컬럼 추가

- **대상 화면**: 백엔드 설정 → 위젯별 설정의 4개 탭
  - 데이터 API (`ApisGrid` in [ConfigEditorPage.jsx](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx))
  - 서버 리소스 / 네트워크 체크 / API 상태 ([MonitorTargetsTab.jsx](../../../monigrid-fe/src/components/MonitorTargetsTab.jsx))
- **작성일**: 2026-05-09
- **상태**: Draft → 사용자 리뷰 대기

## 배경 및 동기

현재 4개 그리드의 "상태" 컬럼은 *편집 중인 row의 dirty 상태*(신규 / 삭제 예정 / 임계치 N개) 를 배지로 보여준다. 같은 정보가 row 배경색(`row-state-new` / `row-state-modified` / `row-state-deleted`)으로도 이미 노출되고 있어 시각적으로 중복이며, 정작 운영자가 그리드에서 알고 싶어 하는 "이 row를 누가 언제 마지막으로 만졌는지" 는 어디에서도 보이지 않는다.

이 변경의 목표:

1. 편집 상태는 row 배경색만으로 표현 (신규=연초록, 수정=노랑, 삭제 예정=빨강 유지)
2. "상태" 컬럼 제거
3. 그 자리에 **수정 시각 / 편집자** 두 컬럼 추가 (audit 정보)
4. 데이터 API 탭의 "임계치 N" 배지는 ⚠(임계치 편집) 버튼 위 카운트 배지로 이동

## 비목표 (Out of scope)

- 전체 변경 이력(audit log) 추적 — 마지막 수정만 기록
- DB 연결(`monigrid_connections`), SQL 쿼리(`monigrid_sql_queries`) 등 다른 설정 테이블의 audit 화 — 이번 PR 범위 밖
- 로그인 액티비티 / 세션 추적 — 이미 알람 이력에 일부 노출됨, 별도 작업

## 데이터 모델 변경

### `monigrid_apis` (현재 `updated_at` 도 없음)

```sql
ALTER TABLE monigrid_apis ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE monigrid_apis ADD COLUMN updated_by VARCHAR(128) NULL;
```

### `monigrid_monitor_targets` (이미 `updated_at` 있음)

```sql
ALTER TABLE monigrid_monitor_targets ADD COLUMN updated_by VARCHAR(128) NULL;
```

### Dialect 별 적용 위치

- 신규 설치 DDL: [_ddl_statements()](../../../monigrid-be/app/settings_store.py#L117) 의 mariadb / mssql / oracle 세 분기
- 기존 설치 마이그레이션: [migrate_settings_db.py](../../../monigrid-be/migrate_settings_db.py) 에 idempotent ALTER 추가
  - mariadb: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` (10.5+) 또는 `INFORMATION_SCHEMA` 가드
  - mssql: `IF COL_LENGTH(...) IS NULL ALTER TABLE ...`
  - oracle: `EXECUTE IMMEDIATE` + 예외 무시

### 레거시 row 처리

- `updated_at`: ALTER 시점의 `CURRENT_TIMESTAMP` 로 자동 채워짐 (마이그레이션 시점이 사실상 "마지막 수정 시점")
- `updated_by`: NULL — FE 에서 `"—"` 로 표시

### 갱신 트리거

| 행위 | `updated_at` / `updated_by` 갱신? |
|---|---|
| `POST /dashboard/config` partial-reload 가 그 row를 변경분으로 분류해 UPSERT | ✅ |
| `POST /monitor/targets:batch` 의 `creates` / `updates` 에 포함 | ✅ |
| enabled 토글만 켜고/끄는 경우 (FE 가 modified 로 분류) | ✅ |
| GET / 부팅 / cache refresh / 알람 이벤트 기록 | ❌ |
| 백엔드 자체 헬스 수집 결과 저장 | ❌ |

## BE API 변경

### 응답 스키마 추가

`GET /dashboard/config` → `apis[].updated_at`, `apis[].updated_by` 추가
`GET /monitor/targets` → `targets[].updated_at`, `targets[].updated_by` 추가

값 형식: **항상 UTC ISO8601 with `Z`** (`"2026-05-09T05:23:14Z"`).
NULL/미설정 시 `null` (FE 가 `"—"` 로 렌더).

### 저장 경로 — actor 주입

[auth.py:91 current_username()](../../../monigrid-be/app/auth.py#L91) 가 이미 JWT에서 username 을 꺼낸다. 두 라우트에서 그대로 활용:

- [dashboard_routes.py update_config()](../../../monigrid-be/app/routes/dashboard_routes.py#L184): `apply_partial_config_reload(config_data, actor=current_username())`
- [monitor_routes.py apply_monitor_targets_batch_route()](../../../monigrid-be/app/routes/monitor_routes.py#L158): `apply_monitor_targets_batch(creates, updates, deletes, actor=current_username())`

서비스 → 스토어 시그니처에 `actor: str` 파라미터 일관 추가.
빈 문자열이면 DB 에는 NULL 저장 (인증 통과 후 username 누락은 비정상이지만 방어적 처리).

### Store SQL 변경

- `monigrid_apis` 의 INSERT/UPDATE 문에 `updated_at = CURRENT_TIMESTAMP, updated_by = ?` 추가
- `monigrid_monitor_targets` INSERT/UPDATE 도 동일
- SELECT 쿼리에 두 컬럼 추가하여 dict 직렬화에 포함

### 타임존 통일

- mariadb 연결 시 세션 timezone 을 UTC 로 고정: `SET time_zone = '+00:00'`
- mssql 의 `DATETIME2` 는 timezone 없음 — UTC 로 저장하도록 INSERT 시 `SYSUTCDATETIME()` 명시 (현재 DDL 이미 그렇게 되어 있음)
- oracle: `ALTER SESSION SET TIME_ZONE = 'UTC'` 또는 `SYS_EXTRACT_UTC` 캐스팅
- 직렬화 시점: Python 의 `datetime` 객체에 `tzinfo=timezone.utc` 강제 후 `isoformat().replace("+00:00", "Z")`

## FE 변경

### CSS — row 배경색 톤

[ConfigEditorPage.css:491-507](../../../monigrid-fe/src/pages/ConfigEditorPage.css#L491-L507):

```css
.cfg-grid-row.row-state-new {
    background: rgba(34, 197, 94, 0.10);   /* 연초록 — 알파 0.06 → 0.10 */
    box-shadow: inset 0 0 0 1px rgba(34, 197, 94, 0.30);
}
.cfg-grid-row.row-state-modified {
    background: rgba(250, 204, 21, 0.12);  /* 노랑 — 기존 파랑(25,160,255)에서 변경 */
    box-shadow: inset 0 0 0 1px rgba(250, 204, 21, 0.35);
}
.cfg-grid-row.row-state-deleted {
    /* 그대로 유지 — rgba(239, 68, 68, ...) */
}
```

[ConfigEditorModal.css](../../../monigrid-fe/src/components/ConfigEditorModal.css) 의 카드형 스타일이 별도로 있다면 동일 톤으로 동기화.

### 그리드 컬럼 변경

#### ApisGrid (데이터 API) — [ConfigEditorPage.jsx:337-348](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx#L337-L348)

```jsx
// 헤더
<span>No</span>
<span>활성</span>
<span>API ID</span>
<span>REST API Path</span>
<span>Connection</span>
<span>SQL ID</span>
<span>주기(초)</span>
<span>수정 시각</span>      {/* NEW */}
<span>편집자</span>          {/* NEW */}
<span></span>                {/* 액션 */}
// "상태" 컬럼 제거됨
```

[ApiRow](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx#L173) 의 셀:
- `<span className="cfg-grid-flags">` 블록 제거
- 그 자리에 `<AuditCells updatedAt={api.updated_at} updatedBy={api.updated_by} />`
- 임계치 N 배지는 ⚠ 버튼 안쪽 카운트 배지로 이동

#### MonitorTargetsTab — [TargetGridHeader](../../../monigrid-fe/src/components/MonitorTargetsTab.jsx#L431) 3분기 동일 패턴

마지막 도메인 컬럼(Disk% / Timeout / Timeout) 다음에 **수정 시각 + 편집자** 추가, "상태" 헤더 제거. 각 row 컴포넌트(`ServerResourceRow` / `NetworkRow` / `HttpStatusRow`) 에서 `<RowFlags>` 제거 후 `<AuditCells>` 삽입.

### 새 컴포넌트: `AuditCells`

```jsx
// src/components/AuditCells.jsx (신규) 또는 ConfigEditorPage.jsx 내부 헬퍼
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
```

`formatLocalDateTime(isoUtc)`:
- `null`/`""` → `"—"`
- `Intl.DateTimeFormat` 으로 사용자 로컬 타임존 변환, `YYYY-MM-DD HH:mm` 형식
- 파싱 실패 → 원본 문자열 그대로 (방어적)

신규 row(`_isNew`)는 DB 에 아직 없으므로 두 셀 모두 `"—"`. 저장 후 응답으로 받은 신규 row 의 audit 필드가 grid 에 그대로 반영됨.

### "임계치 N" 배지 이동

[ApiRow의 ⚠ 버튼](../../../monigrid-fe/src/pages/ConfigEditorPage.jsx#L276-L286) 위에 카운트 배지:

```jsx
<button className="cfg-row-action-btn cfg-thresholds-btn" onClick={...}>
    <span aria-hidden>⚠</span>
    {thresholdsCount > 0 && (
        <span className="cfg-thresholds-count-badge" aria-label={`임계치 ${thresholdsCount}개`}>
            {thresholdsCount}
        </span>
    )}
</button>
```

CSS: 작은 원형 배지를 버튼 우상단에 absolute 로 띄움 (~14px 직경, 노랑/주황 배경).

### `grid-template-columns` 컬럼 폭 — [ConfigEditorPage.css:520-594](../../../monigrid-fe/src/pages/ConfigEditorPage.css#L520-L594)

각 그리드의 컬럼 정의 갱신. 패턴:

```
... (기존 도메인 컬럼들) ...
minmax(140px, 150px)  /* 수정 시각 */
minmax(96px, 120px)   /* 편집자 */
76px                  /* 액션 */
```

`min-width` 도 +180px 정도 증가:

| 탭 | 기존 min-width | 신규 min-width |
|---|---|---|
| 서버 리소스 | 1480px | 약 1620px (상태 100px 제거 + audit 240px 추가) |
| 네트워크 | 1180px | 약 1320px |
| API 상태 | 1100px | 약 1240px |
| 데이터 API | (모달, 명시적 min-width 없음) | 컬럼 정의에서 자동 |

데이터 API 탭은 모달 안이라 가로 스크롤 활성화 여부 확인. 필요하면 `.cfg-grid-apis` 에 `overflow-x: auto`.

### 저장 후 갱신

저장 버튼 → 응답으로 새 audit 값 포함 → 기존 reload 흐름이 grid 상태를 갱신. 별도 변경 없음.

## 보안/권한

- audit 데이터 노출 = admin 만 그리드 진입 가능 (`require_admin`) → 이미 권한 분리됨
- `updated_by` 는 admin 사용자명만 들어가므로 PII 위험 낮음
- 로그 INFO 레벨에 actor 정보 추가 가능 (이미 일부 라우트에서 `clientIp` 와 함께 출력 중) — 별도 메모리/감사 채널 필요 없음

## 테스트 전략

### BE 단위 테스트

- `monigrid-be/scripts/test_partial_reload.py` 스타일로:
  - actor=`"admin"` 으로 데이터 API 변경 → DB 컬럼 검증
  - actor=`""` (빈 문자열) → DB 에 NULL 저장 검증
  - 같은 row 를 다른 actor 로 두 번 수정 → 마지막 actor 만 남는지 검증
  - 모니터 타깃 batch 의 `creates` / `updates` / `deletes` 각각 actor 가 정확히 채워지는지

### BE E2E

- 기존 `monigrid-be/scripts/test_partial_reload.py` 의 partial-reload 시나리오에 audit 검증 케이스 추가
- 마이그레이션 idempotency: 같은 마이그레이션을 두 번 돌려도 에러 없이 통과

### FE 시각 회귀

- 4개 탭 각각 신규 row / 수정 row / 삭제 예정 row 가 새 색으로 보이는지
- 레거시 row(`updated_by` NULL) 가 `"—"` 로 표시되는지
- 저장 후 새 audit 값이 row 에 반영되는지

## 마이그레이션 / 배포 순서

1. BE PR 머지 → 신규 인스턴스 부팅 시 DDL 자동 적용 (idempotent)
2. 기존 운영 인스턴스: 첫 부팅 시 [migrate_settings_db.py](../../../monigrid-be/migrate_settings_db.py) 가 ALTER 실행
3. FE PR 머지 → 빌드 배포
4. **BE 가 먼저 배포되어야 함** (FE 가 audit 필드 없는 응답을 받으면 빈 셀이 뜨지만 동작은 정상). 역순 배포는 FE 가 audit 필드를 못 받아 항상 `"—"` 만 보임 — 일시적이라 허용 가능.

## 마이그레이션 롤백

- ALTER 만 추가했으므로 롤백은 `DROP COLUMN updated_by` (모니터 타깃) / `DROP COLUMN updated_at, updated_by` (데이터 API)
- 롤백 스크립트는 별도 작성하지 않음 (필요 시 수동 SQL)

## 결정한 것 / 결정 안 한 것

### 결정

- ✅ "최종 수정만" 기록 (audit log 아님)
- ✅ 컬럼 2개 분리 (수정 시각 / 편집자)
- ✅ UTC ISO8601 직렬화, FE 가 로컬 변환
- ✅ 신규 row 의 audit = `"—"`
- ✅ enabled 토글만 변경해도 audit 갱신
- ✅ 임계치 N 배지는 ⚠ 버튼 위 카운트 배지로 이동
- ✅ 삭제 예정 row 색상 그대로 유지

### 미결정 (구현 시 결정)

- 임계치 카운트 배지의 정확한 색/크기 — 디자인 일관성 검토 후 구현 시 확정
- `cfg-grid-apis` 가로 스크롤 활성화 여부 — 실제 폭 측정 후 결정
- mariadb 세션 timezone 설정 위치 — connection 풀 init hook vs 매 쿼리 — JayDeBeApi 동작 확인 후 결정

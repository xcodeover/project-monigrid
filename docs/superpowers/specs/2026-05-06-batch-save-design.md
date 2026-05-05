# Batch Save (Issue #6) — Design Spec

**Date:** 2026-05-06
**Status:** Approved for implementation planning
**Scope:** ConfigEditorModal "데이터 API" 탭 + MonitorTargetsTab

---

## 1. Goal

각 항목마다 별도 "저장" 버튼을 누르는 현재 UX 를 제거하고, 모달 하단 단일 "저장&적용" 버튼으로 변경/추가/삭제를 일괄 반영한다. **변경된 항목만** DB 에 반영하며, 모니터 타깃의 경우 backend.reload() 가 1회만 트리거되도록 한다 (이슈 #2 의 동기 reload 부담도 동시 완화).

---

## 2. In-scope / Out-of-scope

**In-scope:**
- ConfigEditorModal 의 "데이터 API" 탭 (data API endpoint 리스트)
- MonitorTargetsTab (monitor target 리스트 — server_resource / network 타입)
- 새 BE batch endpoint (monitor targets 한정)
- 공통 dirty-tracking FE 패턴 (재사용 hook)

**Out-of-scope:**
- 다른 모달 (SQL Editor, BackendConfigPasswordPrompt, AlertHistory 등)
- ConfigEditorModal 의 다른 탭 (DB 연결, 인증, 로깅 등) — 이미 한 번에 저장하는 구조
- backend.reload() 자체의 비동기화 (별도 Phase 5 작업으로 분리)
- 세션 간 dirty 상태 보존 (localStorage)

---

## 3. Architecture

### 3.1 BE — Monitor target batch endpoint (신규)

**Endpoint:**
```
POST /dashboard/monitor-targets/batch
@require_auth
@require_admin
```

**Request body:**
```json
{
  "creates": [
    { "type": "server_resource", "label": "...", "host": "...", ... },
    ...
  ],
  "updates": [
    { "id": "target-abc", "label": "...", ... },
    ...
  ],
  "deletes": [ "target-xyz", "target-def", ... ]
}
```

**Behavior:**
- 단일 트랜잭션. SettingsStore 에 새 메서드 `apply_monitor_targets_batch(creates, updates, deletes) -> dict` 추가
- 모든 변경 적용 후 `backend.reload()` 1회 호출 (현재 개별 endpoint 마다 reload 하는 것과 대비 — N개 변경 시 N회가 1회로 감소)
- 성공 응답 (200):
  ```json
  {
    "success": true,
    "results": {
      "created": [{ "id": "target-new-1", "label": "..." }, ...],
      "updated": [{ "id": "target-abc", "label": "..." }, ...],
      "deleted": ["target-xyz", "target-def"]
    },
    "reloadTriggered": true
  }
  ```
- 실패 응답 (400, atomic 롤백 후):
  ```json
  {
    "success": false,
    "error": "validation failed",
    "failedItem": {
      "kind": "create" | "update" | "delete",
      "index": 0,                  // creates/updates/deletes 배열 내 인덱스
      "id": "target-abc" | null,   // updates/deletes 면 ID
      "message": "label is required"
    }
  }
  ```
- ID 충돌 (creates 가 기존 ID 와 동일, updates/deletes 의 ID 가 없는 row 참조) 시 atomic 실패
- 동일 ID 가 updates 와 deletes 양쪽에 등장하면 atomic 실패 (FE 가 미리 검증해야 하는 케이스이지만 BE 도 방어)

**기존 개별 endpoint (POST/PUT/DELETE /dashboard/monitor-targets) 는 유지** — 외부 스크립트 / 다른 future 호출처 호환.

**Rate limit:** 새 batch endpoint 도 `monitor_refresh` 와 동일 limit 적용 권장 (분당 10회 — Phase 2 Task 2.6 패턴 따라감).

### 3.2 BE — 데이터 API 탭

**변경 없음.** 기존 `PUT /dashboard/config` 가 이미 전체 config blob 을 받는 atomic 구조. FE 가 변경된 endpoint 만 골라 보내는 게 아니라 전체 endpoint 리스트를 보내면 됨 (BE 가 알아서 diff).

단, 한 가지 BE 측 확인 필요: `PUT /dashboard/config` 가 endpoint 리스트의 변경/추가/삭제를 정확히 처리하는지 검증. 만약 SettingsStore 가 endpoint upsert 만 하고 deleted endpoint 는 무시한다면, batch save UX 를 위한 minor 보강 필요할 수 있음 (구현 단계에서 확인).

### 3.3 FE — 공통 dirty-tracking 패턴

**신규 hook:** `monigrid-fe/src/hooks/useDirtyList.js`

```typescript
useDirtyList<T>({
  initial: T[],                    // 서버에서 받은 원본
  idKey: keyof T = "id",           // ID 필드 이름 (default "id")
  newItemFactory: () => Partial<T>, // "+ 추가" 클릭 시 빈 row 생성
}) → {
  // 표시용
  visibleItems: T[],               // working 사본 (삭제 예정은 맨 뒤로 정렬)

  // 편집 액션
  updateItem: (id, patch) => void,
  addItem: () => string,           // 신규 _clientId 반환
  deleteItem: (id) => void,        // soft delete
  restoreItem: (id) => void,       // 복원

  // 상태 조회
  isDirty: boolean,
  dirtyCount: { creates: number, updates: number, deletes: number, total: number },
  rowState: (id) => "unchanged" | "new" | "modified" | "deleted",
  isValid: boolean,
  invalidIds: string[],
  
  // 저장
  computeDiff: () => { creates: T[], updates: T[], deletes: string[] },
  
  // 검증 hook (선택)
  setValidator: (fn: (item: T) => string | null) => void,
}
```

**Internal state:**
- `original: Map<id, T>` — 서버에서 받은 snapshot (불변)
- `working: Map<id, T>` — 현재 편집 중 (deletion mark 포함)
- `newIds: Set<id>` — 신규 row 의 임시 _clientId 들

**Dirty 계산:**
- `unchanged`: working[id] === original[id] (deep equal)
- `modified`: original 에 있고 working 과 다름 (단 _isDeleted ≠ true)
- `new`: original 에 없고 newIds 에 있음
- `deleted`: working[id]._isDeleted === true (original 에 있었던 것만; new + delete 는 그냥 삭제)

**ID 임시값:** 신규 row 는 `_clientId = "tmp-{uuid}"` 사용. BE 에 보낼 땐 ID 필드 제거 (BE 가 새 ID 부여).

### 3.4 FE — UI components

**신규 component:** `monigrid-fe/src/components/DirtyListSummary.jsx`
```jsx
<DirtyListSummary
  count={{ creates, updates, deletes, total }}
  isValid={isValid}
  invalidCount={invalidIds.length}
  isSaving={isSaving}
  onSave={handleSave}
  saveLabel="저장 & 적용"
/>
```
하단 요약 + 저장 버튼. 변경 없으면 "변경 사항 없음" 라벨 + 비활성. invalid 있으면 "1 항목 오류" 라벨 + 빨간색 (저장 시도 시 첫 invalid 로 스크롤).

**Row 인라인 마킹** (CSS class):
- `.row-state-new` — 좌측 4px 녹색 바
- `.row-state-modified` — 좌측 4px 노란 바 + 우측 `●` 아이콘
- `.row-state-deleted` — opacity 0.5 + 텍스트 취소선 + 액션 버튼 자리에 `↺ 복원` 버튼
- `.row-state-invalid` — 빨간 테두리 + 에러 메시지 row

**모달 닫기 가드:**
신규 hook `useUnsavedChangesGuard(isDirty, message)`:
- X 버튼 onClick → `if (isDirty) { confirm(message) ? onClose() : void } else onClose()`
- ESC 키 keydown → 동일
- Confirm 메시지: `"저장하지 않은 변경 사항 N건이 있습니다. 폐기하고 닫으시겠습니까?"`

### 3.5 FE — 저장 흐름

```
사용자가 "저장 & 적용" 클릭
  ↓
FE: validate all rows → invalid 있으면 첫 invalid 로 스크롤 + alert("N개 항목에 오류가 있습니다") → 저장 안 함
  ↓ (모두 valid)
FE: computeDiff() → { creates, updates, deletes }
  ↓
FE: 변경 0건이면 (이론상 도달 불가, 버튼 비활성) → no-op
  ↓
FE: setSaving(true), 모든 입력 disabled
  ↓
FE → BE batch endpoint POST
  ↓
BE: 트랜잭션 → 성공 → reload() → 200 응답
  OR
BE: 트랜잭션 실패 → 400 + failedItem 응답
  ↓
FE 성공 응답:
  - results.created 의 새 ID 들로 working 의 _clientId 매핑
  - original ← working (snapshot 갱신)
  - 모달 닫음 + toast "저장 완료"
  - 부모에게 reload 시그널
FE 실패 응답:
  - failedItem.kind/index/id 로 실패한 row 찾아 빨간 테두리 + 에러 메시지
  - dirty 상태 유지 (사용자가 수정 후 재시도)
  - alert("저장 실패: <message>")
  - setSaving(false)
```

---

## 4. 정책 default (사용자 review 단계에서 변경 가능)

| 항목 | Default |
|------|---------|
| 저장 성공 후 모달 거동 | 자동 닫힘 + 성공 토스트 |
| 변경 0건 시 저장 버튼 | 비활성 + "변경 없음" 라벨 |
| 저장 진행 중 입력 | disabled |
| 저장 진행 중 모달 닫기 | confirm 무시 (저장 끝날 때까지 대기) |
| 신규 row 추가 UX | 기존 패턴 따라감 (인라인 빈 row) |
| 세션 간 dirty 보존 | X (모달 닫으면 잃음) |
| 신규 row + 즉시 삭제 | working/newIds 에서 즉시 제거 (BE 호출 안 함) |
| 같은 row 의 modify + delete | delete 우선 (modify 무시) |
| 저장 실패 시 reload 트리거 | X (BE 가 atomic 롤백했으므로 변화 없음) |

---

## 5. Validation 규칙

**ConfigEditorModal "데이터 API" 탭 — endpoint 검증:**
- `id`: 필수, 알파벳/숫자/언더스코어만, 기존 ID 와 중복 X (단 자기 자신 제외)
- `path`: 필수, `/` 로 시작, ASCII 만
- `sql_id`: SQL Editor 에 존재하는 SQL 파일 ID 여야 함 (드롭다운 선택)
- `query_timeout_sec`: 1 이상 정수
- `cache_ttl_sec`: 0 이상 정수
- 기타 필드는 기존 ConfigEditorModal 의 검증 패턴 그대로 따라감

**MonitorTargetsTab — target 검증:**
- `label`: 필수, 1~64 chars
- `type`: server_resource | network — 드롭다운 선택
- `host`: 필수, 빈 문자열 X
- `port`: 1~65535 정수 (server_resource 의 SSH 포트 등)
- `username` / `password`: server_resource 면 필수
- 같은 host+port+username 조합은 1개만 (clientId 기반 중복 검사)

검증 함수는 `useDirtyList` 의 `setValidator` 로 주입. 각 모달이 자기 도메인 검증을 정의.

---

## 6. Touchpoints (구현 단계 예상 파일 목록)

**BE:**
- `monigrid-be/app/settings_store.py` — `apply_monitor_targets_batch(creates, updates, deletes)` 메서드 추가
- `monigrid-be/app/service.py` — backend 에 동급 메서드 추가 (settings_store delegate + reload trigger)
- `monigrid-be/app/routes/monitor_routes.py` — 새 `POST /dashboard/monitor-targets/batch` route 추가
- `monigrid-be/app/config.py` — `RateLimitConfig` 에 `monitor_targets_batch` 추가 (기본 "10/minute") + `_DEFAULT_RATE_LIMITS` 업데이트
- (선택) `monigrid-be/app/routes/dashboard_routes.py` — `PUT /dashboard/config` 가 endpoint 리스트의 deletion 도 처리하는지 검증, 안 되어 있으면 보강

**FE:**
- 신규: `monigrid-fe/src/hooks/useDirtyList.js`
- 신규: `monigrid-fe/src/hooks/useUnsavedChangesGuard.js`
- 신규: `monigrid-fe/src/components/DirtyListSummary.jsx` + `.css`
- `monigrid-fe/src/components/MonitorTargetsTab.jsx` — 개별 save 제거 → useDirtyList 적용 → DirtyListSummary 추가 → batch endpoint 호출
- `monigrid-fe/src/components/ConfigEditorModal.jsx` — "데이터 API" 탭 영역에 동일 패턴 적용 (저장 시 PUT /dashboard/config 한 번)
- `monigrid-fe/src/services/dashboardService.js` — 신규 `monitorService.applyTargetsBatch(creates, updates, deletes)` 메서드 + `invalidateMonitorTargetsCache()` 호출 (Phase 3 Task 3.7 cache 와 호환)
- 공통 CSS: `.row-state-{new|modified|deleted|invalid}` 클래스 정의 (모달들이 공유)

---

## 7. Migration / 호환성

- 기존 개별 endpoint (POST/PUT/DELETE /dashboard/monitor-targets) 는 그대로 유지 — 외부 호환
- 기존 사용자 데이터 / DB 스키마 변경 없음
- 기존 monigrid_settings_kv / monigrid_monitor_targets 테이블 그대로
- IIS web.config: `/dashboard/*` 룰이 새 batch path 를 자동 커버 (이슈 #1 의 패턴이라 추가 룰 불필요)
- Phase 3 Task 3.7 의 `invalidateMonitorTargetsCache` 가 batch save 후에도 한 번 호출되어야 함 (cache stale 방지)

---

## 8. Testing approach

수동 (프로젝트에 자동 테스트 없음):

**BE:**
- batch 성공: 2 신규 + 1 수정 + 1 삭제 → 200, reload 1회, DB 반영 정확
- batch 실패: 잘못된 데이터 (id 중복 등) → 400, 응답에 failedItem 정확, DB 변경 없음 (atomic 롤백)
- ID 충돌: updates+deletes 같은 ID → 400
- 빈 batch (`{creates: [], updates: [], deletes: []}`) → 200 + reload 안 함 (의미 없는 호출)

**FE:**
- 모달 열기 → 신규 row 추가 → 입력 → 저장&적용 → 새 ID 받아 표시 + 모달 닫힘
- 기존 row 수정 → 노란 점 표시 → 저장 → modify diff 만 BE 전송
- row 삭제 → 회색 + 취소선 → 복원 → 다시 정상 → 변경 0건 → 버튼 비활성
- invalid 입력 → 빨간 테두리 → 저장 시도 → 첫 invalid 로 스크롤 + alert
- dirty 상태 + ESC → confirm "폐기하시겠습니까?" → 폐기 OR 취소
- 저장 진행 중 → spinner + 입력 disabled
- BE 실패 응답 → 실패한 row 빨간 테두리 + 에러 + dirty 유지

---

## 9. Open questions / 알려진 제약

1. **ConfigEditorModal 의 데이터 API 탭이 이미 다른 탭 (DB 연결, 인증 등) 과 함께 PUT /dashboard/config 한 번에 저장하는 구조라면**, 데이터 API 만 batch save 로 빼는 게 자연스러운가? 아니면 모든 탭이 같은 패턴 (탭마다 dirty + 전체 저장 시 한 번에) 으로 가야 하는가?
   - **현재 default 결정:** 데이터 API 탭에만 dirty-tracking UI 적용. 다른 탭은 기존 form 패턴 유지. PUT /dashboard/config 호출은 동일.
   - 구현 단계에서 ConfigEditorModal 코드 읽고 다른 탭과의 일관성 결정.

2. **Phase 3 Task 3.7 의 monitor target list 30s 캐시** — batch save 후 invalidate 호출 시점:
   - **결정:** FE 가 batch endpoint 성공 응답 받자마자 `invalidateMonitorTargetsCache()` 호출. 다른 위젯 (MonitorTargetPicker) 이 다음 모달 열 때 fresh 데이터 받음.

3. **신규 row 의 임시 _clientId 가 BE 응답의 새 ID 와 매핑** — BE 가 응답 results.created 를 어떤 순서로 반환할지 보장하는가?
   - **결정:** BE 가 batch 입력의 `creates` 배열 순서 그대로 응답 `results.created` 반환 (위치 매칭). FE 가 인덱스로 매핑.

4. **저장 진행 중 (saving) 모달 닫기 시도** — BE 응답 도착 전에 사용자가 X 누르면?
   - **결정:** confirm 무시. spinner 만 표시. 사용자에게는 "저장 중" 메시지. saving 풀린 후 X 활성화.

---

## 10. 다음 단계

이 spec 이 사용자 승인 후, `superpowers:writing-plans` 스킬로 단계별 구현 plan 작성 → `superpowers:subagent-driven-development` 로 실행.

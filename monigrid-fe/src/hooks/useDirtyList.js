/**
 * useDirtyList — batch-save 모달의 dirty tracking 공통 패턴.
 *
 * MonitorTargetsTab 과 ConfigEditorModal "데이터 API" 탭에서
 * 공유하는 아이템 목록의 dirty 상태 관리 프리미티브.
 *
 * 내부적으로 두 개의 Map을 유지한다:
 *   - `original`: 서버 스냅샷 (deep clone)
 *   - `working`:  현재 편집 중인 복사본
 *
 * 각 working 아이템은 _isNew / _isDeleted 플래그를 가질 수 있다.
 * 신규 아이템의 id 는 tmp-{timestamp}-{random} 형식의 클라이언트 임시 id.
 */
import { useCallback, useMemo, useReducer } from "react";

// ── helpers ──────────────────────────────────────────────────────────────────

/** JSON round-trip deep clone (plain objects/arrays only — no Date etc.) */
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** shallow-equal excluding internal _* fields */
function isUnchanged(orig, work) {
    const origKeys = Object.keys(orig).filter((k) => !k.startsWith("_"));
    const workKeys = Object.keys(work).filter((k) => !k.startsWith("_"));
    if (origKeys.length !== workKeys.length) return false;
    for (const k of origKeys) {
        // Use JSON stringify for nested object comparison
        if (JSON.stringify(orig[k]) !== JSON.stringify(work[k])) return false;
    }
    return true;
}

/** Build a Map from an array, keyed by idKey */
function buildMap(items, idKey) {
    const map = new Map();
    for (const item of items) {
        map.set(item[idKey], deepClone(item));
    }
    return map;
}

/** Generate a temporary client-side id */
function genTmpId() {
    return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Strip internal _* fields from an item copy */
function stripInternals(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
        if (!k.startsWith("_")) out[k] = v;
    }
    return out;
}

// ── reducer ───────────────────────────────────────────────────────────────────

const ACTIONS = {
    UPDATE_ITEM: "UPDATE_ITEM",
    ADD_ITEM: "ADD_ITEM",
    DELETE_ITEM: "DELETE_ITEM",
    RESTORE_ITEM: "RESTORE_ITEM",
    RESET: "RESET",
};

function reducer(state, action) {
    const { original, working, idKey } = state;

    switch (action.type) {
        case ACTIONS.UPDATE_ITEM: {
            const { id, patch } = action;
            if (!working.has(id)) return state;
            const updated = new Map(working);
            updated.set(id, { ...working.get(id), ...patch });
            return { ...state, working: updated };
        }

        case ACTIONS.ADD_ITEM: {
            const { item, tmpId } = action;
            const added = new Map(working);
            added.set(tmpId, item);
            return { ...state, working: added };
        }

        case ACTIONS.DELETE_ITEM: {
            const { id } = action;
            if (!working.has(id)) return state;
            const item = working.get(id);
            if (item._isNew) {
                // New item: remove entirely (new+delete = as if never added)
                const removed = new Map(working);
                removed.delete(id);
                return { ...state, working: removed };
            }
            // Existing item: soft delete
            const softDeleted = new Map(working);
            softDeleted.set(id, { ...item, _isDeleted: true });
            return { ...state, working: softDeleted };
        }

        case ACTIONS.RESTORE_ITEM: {
            const { id } = action;
            if (!working.has(id)) return state; // no-op (was new+deleted, already removed)
            const item = working.get(id);
            if (!item._isDeleted) return state; // nothing to restore
            const restored = new Map(working);
            const { _isDeleted: _removed, ...rest } = item;
            restored.set(id, rest);
            return { ...state, working: restored };
        }

        case ACTIONS.RESET: {
            const { newItems } = action;
            const newOriginal = buildMap(newItems, idKey);
            const newWorking = buildMap(newItems, idKey);
            return { ...state, original: newOriginal, working: newWorking };
        }

        default:
            return state;
    }
}

// ── hook ──────────────────────────────────────────────────────────────────────

/**
 * useDirtyList
 *
 * @param {object} params
 * @param {Array}    params.initial           - 서버에서 받은 초기 아이템 배열
 * @param {string}   [params.idKey="id"]      - 아이템의 ID 필드명
 * @param {Function} params.newItemFactory    - 빈 신규 아이템을 반환하는 팩토리 함수 `() => Partial<T>`
 * @param {Function} params.validator         - 아이템 유효성 검사 `(item) => string | null`
 *
 * @returns {{
 *   visibleItems:    Array,
 *   rowState:        (id: string) => "unchanged"|"new"|"modified"|"deleted",
 *   updateItem:      (id: string, patch: object) => void,
 *   addItem:         (overrides?: object) => string,
 *   deleteItem:      (id: string) => void,
 *   restoreItem:     (id: string) => void,
 *   isDirty:         boolean,
 *   dirtyCount:      { creates: number, updates: number, deletes: number, total: number },
 *   isValid:         boolean,
 *   invalidIds:      string[],
 *   validationError: (id: string) => string | null,
 *   computeDiff:     () => { creates: Array, updates: Array, deletes: string[] },
 *   reset:           (newServerItems: Array) => void,
 * }}
 */
export function useDirtyList({
    initial = [],
    idKey = "id",
    newItemFactory,
    validator,
}) {
    const [state, dispatch] = useReducer(reducer, null, () => ({
        idKey,
        original: buildMap(initial, idKey),
        working: buildMap(initial, idKey),
    }));

    const { original, working } = state;

    // ── rowState ─────────────────────────────────────────────────────────────

    const rowState = useCallback(
        (id) => {
            const item = working.get(id);
            if (!item) return "unchanged"; // not present at all
            if (item._isDeleted) return "deleted";
            if (item._isNew) return "new";
            const orig = original.get(id);
            if (!orig) return "new"; // shouldn't happen but safe fallback
            return isUnchanged(orig, item) ? "unchanged" : "modified";
        },
        [working, original],
    );

    // ── visibleItems ─────────────────────────────────────────────────────────

    const visibleItems = useMemo(() => {
        // Each visibleItem 에 working Map 의 key 를 _key 로 노출.
        // 사용 이유: 신규 row 의 id 필드를 사용자가 편집하는 동안 item.id 는
        // 매 키 입력마다 변하지만, working Map 의 key 는 addItem 시점에 부여된
        // tmp-id 로 안정적으로 유지된다. 소비자가 React key / 이벤트 핸들러 /
        // rowState lookup 에 _key 를 쓰면 input remount → focus loss 가 사라진다.
        const all = Array.from(working.entries()).map(
            ([key, item]) => ({ ...item, _key: key }),
        );
        const active = all.filter((it) => !it._isDeleted);
        const deleted = all.filter((it) => it._isDeleted);
        return [...active, ...deleted];
    }, [working]);

    // ── mutators ─────────────────────────────────────────────────────────────

    const updateItem = useCallback((id, patch) => {
        dispatch({ type: ACTIONS.UPDATE_ITEM, id, patch });
    }, []);

    const addItem = useCallback(
        (overrides = {}) => {
            const tmpId = genTmpId();
            const base = newItemFactory ? newItemFactory() : {};
            // 신규 row 의 id 필드는 빈 문자열로 시작 — 사용자가 직접 입력해야 한다.
            // tmpId 는 working Map 의 key (= visibleItem._key) 로만 쓰이고 BE 에는
            // 노출되지 않는다. validator 가 비어있는 id 를 잡아 저장을 막는다.
            const item = {
                ...base,
                ...overrides,
                [idKey]: overrides[idKey] != null && overrides[idKey] !== ""
                    ? overrides[idKey]
                    : "",
                _isNew: true,
            };
            dispatch({ type: ACTIONS.ADD_ITEM, item, tmpId });
            return tmpId;
        },
        [idKey, newItemFactory],
    );

    const deleteItem = useCallback((id) => {
        dispatch({ type: ACTIONS.DELETE_ITEM, id });
    }, []);

    const restoreItem = useCallback((id) => {
        dispatch({ type: ACTIONS.RESTORE_ITEM, id });
    }, []);

    const reset = useCallback(
        (newServerItems = []) => {
            dispatch({ type: ACTIONS.RESET, newItems: newServerItems });
        },
        [],
    );

    // ── dirtyCount ────────────────────────────────────────────────────────────

    const dirtyCount = useMemo(() => {
        let creates = 0;
        let updates = 0;
        let deletes = 0;

        for (const [id, item] of working.entries()) {
            if (item._isNew && !item._isDeleted) {
                creates += 1;
            } else if (item._isDeleted && original.has(id)) {
                deletes += 1;
            } else if (!item._isNew && !item._isDeleted && original.has(id)) {
                const orig = original.get(id);
                if (!isUnchanged(orig, item)) updates += 1;
            }
        }

        return { creates, updates, deletes, total: creates + updates + deletes };
    }, [working, original]);

    const isDirty = dirtyCount.total > 0;

    // ── validation ────────────────────────────────────────────────────────────

    const invalidIds = useMemo(() => {
        if (!validator) return [];
        const ids = [];
        for (const [id, item] of working.entries()) {
            if (item._isDeleted) continue; // deleted items skip validation
            const err = validator(item);
            if (err != null) ids.push(id);
        }
        return ids;
    }, [working, validator]);

    const isValid = invalidIds.length === 0;

    const validationError = useCallback(
        (id) => {
            if (!validator) return null;
            const item = working.get(id);
            if (!item || item._isDeleted) return null;
            return validator(item);
        },
        [working, validator],
    );

    // ── computeDiff ───────────────────────────────────────────────────────────

    const computeDiff = useCallback(() => {
        const creates = [];
        const updates = [];
        const deletes = [];

        for (const [id, item] of working.entries()) {
            if (item._isNew && !item._isDeleted) {
                // 사용자가 입력한 id 를 그대로 BE 로 전달한다.
                // (이전엔 idKey 를 strip 했지만 monigrid_apis / monigrid_monitor_targets
                //  는 user-supplied PRIMARY KEY 라 strip 하면 BE 가 거부한다.)
                creates.push(stripInternals(item));
            } else if (item._isDeleted && original.has(id)) {
                deletes.push(id);
            } else if (!item._isNew && !item._isDeleted && original.has(id)) {
                const orig = original.get(id);
                if (!isUnchanged(orig, item)) {
                    // Keep idKey so BE knows which row to update
                    updates.push(stripInternals(item));
                }
            }
        }

        return { creates, updates, deletes };
    }, [working, original, idKey]);

    // ── return ────────────────────────────────────────────────────────────────

    return {
        visibleItems,
        rowState,
        updateItem,
        addItem,
        deleteItem,
        restoreItem,
        isDirty,
        dirtyCount,
        isValid,
        invalidIds,
        validationError,
        computeDiff,
        reset,
    };
}

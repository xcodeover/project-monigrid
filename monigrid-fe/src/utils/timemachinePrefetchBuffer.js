import { buildSnapshotMap } from "./snapshotKey";

/**
 * key=atMs (number, frame-aligned), value=snapshotByKey (Map<sourceKey, item>)
 * LRU: 추가 시 max 초과 시 가장 오래된 entry 제거.
 *
 * 사용 패턴:
 *   const buf = createPrefetchBuffer(200);
 *   buf.add(atMs, snapshotMap);
 *   const m = buf.get(atMs);  // Map | undefined
 */
export function createPrefetchBuffer(max = 200) {
    const map = new Map();   // 삽입 순서 == LRU 순서
    return {
        size: () => map.size,
        has: (atMs) => map.has(atMs),
        get: (atMs) => map.get(atMs),
        add: (atMs, snapshotMap) => {
            map.delete(atMs);
            map.set(atMs, snapshotMap);
            while (map.size > max) {
                const first = map.keys().next().value;
                map.delete(first);
            }
        },
        addAll: (windowItems) => {
            // [{atMs, snapshot:[items]}, ...] from BE
            for (const it of windowItems || []) {
                const m = buildSnapshotMap(it.snapshot);
                map.delete(it.atMs);
                map.set(it.atMs, m);
            }
            while (map.size > max) {
                const first = map.keys().next().value;
                map.delete(first);
            }
        },
        clear: () => map.clear(),
        keys: () => Array.from(map.keys()),
    };
}

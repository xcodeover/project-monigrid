/**
 * widget object → BE timemachine 의 (sourceType, sourceId) key.
 * BE collector 가 INSERT 하는 source_type/source_id 와 정확히 일치해야 함.
 *
 * sourceType 매핑 (확인된 값):
 *   - "data_api"                  : 데이터 API endpoint (table/line-chart/bar-chart/health-check 위젯)
 *   - "monitor:server_resource"   : ServerResourceCard (BE: f"monitor:{snapshot.type}" where type="server_resource")
 *   - "monitor:network"           : NetworkTestCard (type="network")
 *   - "monitor:http_status"       : http_status 모니터 타깃
 *
 * BE 검증 (service.py):
 *   write_sample(source_type=f"monitor:{snapshot.type}", source_id=snapshot.target_id)
 *   write_sample(source_type="data_api", source_id=endpoint.api_id)
 *
 * NOTE: ServerResourceCard / NetworkTestCard 는 다중 targetIds 를 가질 수 있어
 * 단일 key 를 반환할 수 없다. 그 경우 null 을 반환하며, 각 카드가 직접
 * 해당 targetId 로 snapshotMap 에서 조회해야 한다.
 */
export function snapshotKeyForWidget(widget) {
    if (!widget) return null;
    const t = widget.type;
    if (t === "server-resource") {
        // 다중 targetIds 가능 — 단일 key 제공 불가, 카드 레벨에서 처리
        return null;
    }
    if (t === "network-test") {
        // 다중 targetIds 가능 — 단일 key 제공 불가, 카드 레벨에서 처리
        return null;
    }
    if (t === "status-list") {
        // 다중 http_status 타깃 합성 — Phase 1 에서 단일 source 불가
        return null;
    }
    if (t === "table" || t === "line-chart" || t === "bar-chart" || t === "health-check") {
        const apiId = widget.apiId || widget.endpointId;
        return apiId ? `data_api|${apiId}` : null;
    }
    return null;
}

/** snapshot array → Map<key, snapshotItem> */
export function buildSnapshotMap(items) {
    const map = new Map();
    if (!Array.isArray(items)) return map;
    for (const it of items) {
        const k = `${it.sourceType}|${it.sourceId}`;
        map.set(k, it);
    }
    return map;
}

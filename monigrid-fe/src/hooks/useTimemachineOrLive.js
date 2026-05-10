import { useTimemachine } from "../contexts/TimemachineContext";

/**
 * 위젯의 데이터 hook 에서 timemachine 모드 분기를 단일 라인으로 처리.
 *
 * 사용 패턴:
 *     const tmResult = useTimemachineOrLive(snapshotKey);
 *     if (tmResult.timemachineActive) return tmResult;  // live polling 스킵
 *     // 기존 라이브 polling 로직
 *
 * 반환값:
 *   - timemachineActive: false → live mode, 호출자가 자기 fetch 수행
 *   - timemachineActive: true  → snapshot data 그대로 반환,
 *                                호출자는 즉시 그것을 자기 결과로 사용
 */
export function useTimemachineOrLive(snapshotKey) {
    const tm = useTimemachine();
    if (!tm.enabled) return { timemachineActive: false };
    const snap = snapshotKey ? tm.snapshotByKey.get(snapshotKey) : null;
    return {
        timemachineActive: true,
        data: snap?.payload ?? null,
        loading: tm.loading && !snap,
        error: tm.error || (snap ? null : "이 시점에 데이터 없음"),
        tsMs: snap?.tsMs ?? null,
        atMs: tm.atMs,
    };
}

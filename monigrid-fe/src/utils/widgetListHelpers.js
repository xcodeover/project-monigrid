import { useEffect, useRef } from "react";

/**
 * NG(알람) 행을 앞으로 끌어올리는 stable sort.
 * 같은 그룹 내에서는 원래 순서를 유지한다.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T, index: number) => boolean} isAlert
 * @returns {T[]} 새 배열 (입력 배열은 변경하지 않음)
 */
export const sortAlertsFirst = (items, isAlert) => {
    if (!Array.isArray(items) || items.length <= 1) {
        return Array.isArray(items) ? [...items] : [];
    }
    return items
        .map((item, index) => ({
            item,
            index,
            alert: Boolean(isAlert(item, index)),
        }))
        .sort((a, b) => {
            if (a.alert !== b.alert) return a.alert ? -1 : 1;
            return a.index - b.index; // stable: 원래 순서 유지
        })
        .map((t) => t.item);
};

/**
 * `trigger` 가 바뀔 때마다 ref 로 지정한 스크롤 컨테이너를
 * 최상단(scrollTop = 0)으로 되돌린다.
 *
 * 위젯 데이터 갱신 주기마다 스크롤을 리셋하기 위한 용도.
 *
 * @param {React.RefObject<HTMLElement>} ref
 * @param {unknown} trigger  데이터 refresh 타이밍을 대표하는 값 (보통 data prop 자체)
 */
export const useAutoScrollTopOnDataChange = (ref, trigger) => {
    // 첫 마운트 시엔 불필요한 호출을 피한다.
    const mountedRef = useRef(false);
    useEffect(() => {
        if (!mountedRef.current) {
            mountedRef.current = true;
            return;
        }
        const el = ref.current;
        if (el && typeof el.scrollTo === "function") {
            el.scrollTo({ top: 0, left: 0, behavior: "auto" });
        } else if (el) {
            el.scrollTop = 0;
        }
    }, [ref, trigger]);
};

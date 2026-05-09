/**
 * Phase: ConfigEditorPage 의 우측 최하단(페이지 footer) 저장 버튼을 단일
 * 출처로 통일하기 위한 작은 컨텍스트.
 *
 * 자식 탭(MonitorTargetsTab / WidgetConfigsTab / TimemachineSettingsTab) 은
 * 자체 footer 를 두지 않고, 마운트 시 ``register({save, isDirty, dirtyCount,
 * isSaving, saveLabel})`` 을 호출해 자기 저장 핸들러를 등록한다. 페이지
 * footer 의 "저장 & 적용" 버튼은 활성 탭의 binding 을 호출.
 *
 * 디자인 결정:
 *   - 객체 단위로 등록(여러 필드 한 번에)해 useEffect 한 번으로 스냅샷 + 정리.
 *   - register 함수는 ConfigEditorPage 가 useCallback 으로 안정화 → 자식이
 *     의존성 배열에 그대로 넣어도 무한 루프 안 남.
 *   - 자식이 unmount 시 register(null) 로 binding 해제 — 다른 탭으로 전환
 *     했을 때 이전 탭의 save 가 활성 binding 으로 남지 않도록.
 */
import { createContext, useContext } from "react";

export const ConfigFooterContext = createContext({
    register: () => {},
    unregister: () => {},
});

export function useConfigFooterRegister() {
    return useContext(ConfigFooterContext).register;
}

export function useConfigFooterUnregister() {
    return useContext(ConfigFooterContext).unregister;
}

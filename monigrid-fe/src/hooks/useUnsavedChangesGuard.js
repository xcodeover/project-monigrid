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

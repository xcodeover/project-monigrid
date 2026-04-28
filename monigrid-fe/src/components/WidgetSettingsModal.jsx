import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./icons";

/**
 * Shared chrome for every widget's settings modal.
 *
 * Why this exists: Bar / Line / Health / Network / StatusList Card all
 * had a copy of the same overlay → popup → header → body → footer scaffold,
 * minus the content. The duplicates drifted apart over time (different
 * close-button sizes, no Esc handler in some, footer class names diverged)
 * and accessibility was uniformly weak. This component owns:
 *
 *   - portal mounting (parent doesn't have to wrap in createPortal)
 *   - Esc-to-close
 *   - background scroll lock while open
 *   - first-input autofocus (keyboard users land somewhere useful)
 *   - role / aria-modal / aria-labelledby
 *
 * Style hooks remain unchanged: the parent passes the existing footer
 * class (`bc-settings-footer`, `lc-settings-footer`, …) so Phase 1 doesn't
 * have to refactor the per-card CSS. Phase 1-C will unify those.
 */
const WidgetSettingsModal = ({
    open,
    onClose,
    onApply,
    title = "위젯 설정",
    subtitle,
    footerClassName,
    children,
    applyLabel = "적용",
    cancelLabel = "취소",
    // Some widgets (NetworkTestCard) rely on a draft buffer the user is
    // editing inside the modal — clicking the dim backdrop and losing those
    // edits is hostile, so they opt out. Default stays true to match the
    // old chart-card behaviour.
    closeOnBackdropClick = true,
}) => {
    const popupRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;

        // Esc closes the modal. Stop the event so other Esc handlers further
        // up (e.g. dashboard-wide hotkeys) don't fire after we close.
        const handleKeyDown = (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                onClose?.();
            }
        };
        document.addEventListener("keydown", handleKeyDown);

        // Lock background scroll while open. Save the previous value rather
        // than clearing to "" so we don't override an explicit overflow set
        // by a parent layout.
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = previousOverflow;
        };
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return;
        // Defer focus until after the portal renders. Try the first focusable
        // input/select/textarea inside the popup; fall back to the popup
        // itself so Tab works from a sane starting point.
        const node = popupRef.current;
        if (!node) return;
        const focusable = node.querySelector(
            "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
        );
        (focusable ?? node).focus({ preventScroll: true });
    }, [open]);

    if (!open) return null;

    const titleId = "widget-settings-title";

    const modal = (
        <div
            className='settings-overlay'
            onClick={(e) => {
                // Click on the dim background = close, click on the popup =
                // do nothing. The popup itself stops propagation below.
                if (!closeOnBackdropClick) return;
                if (e.target === e.currentTarget) onClose?.();
            }}
        >
            <div
                ref={popupRef}
                className='settings-popup'
                role='dialog'
                aria-modal='true'
                aria-labelledby={titleId}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
            >
                <div className='settings-popup-header'>
                    <div>
                        <h5 id={titleId}>{title}</h5>
                        {subtitle && <p>{subtitle}</p>}
                    </div>
                    <button
                        type='button'
                        className='close-settings-btn'
                        onClick={onClose}
                        aria-label='설정 닫기'
                    >
                        <IconClose size={14} />
                    </button>
                </div>
                <div className='settings-popup-body'>
                    {children}
                    {onApply && (
                        <div className={footerClassName}>
                            <button
                                type='button'
                                className='secondary-btn'
                                onClick={onClose}
                            >
                                {cancelLabel}
                            </button>
                            <button
                                type='button'
                                className='primary-btn'
                                onClick={onApply}
                            >
                                {applyLabel}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    return createPortal(modal, document.body);
};

export default WidgetSettingsModal;

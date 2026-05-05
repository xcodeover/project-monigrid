/**
 * useDocumentVisible: returns true when the document is visible (foreground tab),
 * false when hidden (background tab, minimised window, etc.).
 *
 * Uses the Page Visibility API (document.visibilityState / document.hidden).
 * Safe for Vite SPA — no SSR path exists, so `document` is always available.
 */
import { useEffect, useState } from "react";

export function useDocumentVisible() {
    const [visible, setVisible] = useState(() => !document.hidden);
    useEffect(() => {
        const handler = () => setVisible(!document.hidden);
        document.addEventListener("visibilitychange", handler);
        return () => document.removeEventListener("visibilitychange", handler);
    }, []);
    return visible;
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    base: "./",
    plugins: [react()],
    server: {
        port: 3000,
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    // Only split node_modules
                    if (!id.includes("node_modules")) return undefined;

                    // Heavy charting library — only loaded by chart widgets
                    if (id.includes("recharts") || id.includes("d3-")) return "recharts";

                    // Editor + syntax highlighter — only loaded by SQL/Config modals
                    if (id.includes("prismjs") || id.includes("react-simple-code-editor")) return "editor";

                    // Grid layout — loaded with dashboard
                    if (id.includes("react-grid-layout") || id.includes("react-resizable")) return "grid";

                    // Virtualized list — only loaded by LogViewerPage
                    if (id.includes("react-window")) return "react-window";

                    // Everything else from node_modules → single vendor chunk
                    // (includes react, react-dom, react-router-dom, zustand, axios,
                    //  jsx-runtime, use-sync-external-store, etc.)
                    return "vendor";
                },
            },
        },
    },
});

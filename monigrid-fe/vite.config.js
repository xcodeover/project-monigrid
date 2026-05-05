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
                manualChunks: {
                    // Charting library — only loaded when dashboard is visited
                    recharts: ["recharts"],
                    // Code editor + syntax highlighting — only loaded when
                    // SqlEditorModal / ConfigEditorModal is opened
                    editor: ["prismjs", "react-simple-code-editor"],
                    // Grid drag-and-resize — only loaded with dashboard
                    grid: ["react-grid-layout", "react-resizable"],
                    // Core React runtime — always needed, cache-friendly
                    react: ["react", "react-dom", "react-router-dom"],
                },
            },
        },
    },
});

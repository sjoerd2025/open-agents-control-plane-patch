import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite builds the React/Kumo frontend into ./public, which is served by the
// Worker via static assets. The /api/* and /webhooks paths are intercepted by
// the Worker (see wrangler.jsonc → assets.run_worker_first).
export default defineConfig({
  root: path.resolve(__dirname, "frontend"),
  publicDir: path.resolve(__dirname, "frontend/static"),
  build: {
    outDir: path.resolve(__dirname, "public"),
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [react()],
  server: {
    port: 5173,
    // Markdown docs live at <repo-root>/docs/*.md and are imported into the
    // dashboard via ?raw. Vite's dev server otherwise sandboxes file reads
    // to the project root (frontend/), so explicitly allow the parent.
    fs: {
      allow: [path.resolve(__dirname)],
    },
    proxy: {
      "/api": "http://localhost:8787",
      "/webhooks": "http://localhost:8787",
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "frontend/src"),
    },
  },
});

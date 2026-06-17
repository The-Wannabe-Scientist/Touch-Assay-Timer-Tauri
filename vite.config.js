import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
  root: "src-frontend",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Watch src-frontend directory
      ignored: ["**/src-tauri/**"],
    },
  },
  // Worker support — timer-worker.js uses MessageChannel self-post pattern
  worker: {
    format: "es",
  },
});

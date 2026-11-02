import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Browser evidence is generated output, not a source for hot reload.
    watch: { ignored: ["**/output/**"] },
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:8000",
      },
      "/ws": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:8000",
        ws: true,
      },
    },
  },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  worker: { format: 'es' },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});

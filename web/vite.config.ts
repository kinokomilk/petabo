import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web/dist を Worker(env.ASSETS) が配信する。dev では /api を Worker(wrangler dev:8787) へプロキシ。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

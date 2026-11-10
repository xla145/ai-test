import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  // 桌面端本地加载，单包约 1.3 MB（含 antd）可以接受
  build: { outDir: "../../dist/renderer", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
});

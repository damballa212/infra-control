import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: "ui",
  plugins: [react()],
  resolve: {
    alias: { "@assets": fileURLToPath(new URL("./assets", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5176,
    strictPort: true,
    fs: { allow: [".."] },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});

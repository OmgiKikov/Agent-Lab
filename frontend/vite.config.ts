import react from "@vitejs/plugin-react-swc";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5900,
    strictPort: true,
    // The backend accepts a command only from its own origin (backend/lab/app.py): the proxy keeps the page's Host,
    // which the shorthand string form would rewrite to :5901 (changeOrigin: true).
    proxy: { "/api": { target: process.env.LAB_BACKEND_URL ?? "http://127.0.0.1:5901", changeOrigin: false } },
  },
});

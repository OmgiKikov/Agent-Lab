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
    proxy: { "/api": process.env.LAB_BACKEND_URL ?? "http://127.0.0.1:5901" },
  },
});

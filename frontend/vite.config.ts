import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
const apiTarget = process.env.WORKFLOW_API_TARGET || "http://127.0.0.1:18080";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": apiTarget,
      "/v3": apiTarget,
      "/swagger-ui": apiTarget,
    },
  },
});

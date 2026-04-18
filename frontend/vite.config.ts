import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the Capacitor WebView can load the bundle from file://
  base: "./",
  server: {
    port: 5173,
    host: true, // bind 0.0.0.0 so LAN / tunnels can reach us
    allowedHosts: true, // accept any Host header (ngrok generates a fresh one each session)
    proxy: {
      "/api": {
        target: BACKEND_URL,
        changeOrigin: true,
      },
      "/health": {
        target: BACKEND_URL,
        changeOrigin: true,
      },
    },
  },
});

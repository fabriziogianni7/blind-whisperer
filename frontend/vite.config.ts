import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the Capacitor WebView can load the bundle from file://
  base: "./",
  server: {
    port: 5173,
  },
});

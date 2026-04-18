import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.blindwhisperer.app",
  appName: "Blind Whisperer",
  webDir: "dist",
  // Allow HTTP API calls to a LAN backend during development (use HTTPS in production).
  server: {
    cleartext: true,
  },
};

export default config;

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    server: {
      proxy: {
        // Forwards /v1/... → https://api.anthropic.com/v1/...
        // API key is injected server-side; never exposed to the browser.
        "/v1": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              // Strip browser headers so Anthropic treats this as a server-to-server request
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
              proxyReq.setHeader("x-api-key", env.ANTHROPIC_API_KEY || "");
              proxyReq.setHeader("anthropic-version", "2023-06-01");
              proxyReq.setHeader("anthropic-beta", "web-search-2025-03-05");
            });
          },
        },
      },
    },
  };
});

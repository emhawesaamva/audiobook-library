import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-only middleware that serves the same /api handlers Vercel runs in prod.
function devApi(env) {
  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use("/api/metadata", async (req, res) => {
        const { handleMetadataRequest } = await server.ssrLoadModule("/api/_lib/metadata-core.js");
        // Vercel mounts handlers at the full path; connect strips the prefix.
        req.url = `/api/metadata${req.url === "/" ? "" : req.url}`;
        await handleMetadataRequest(req, res);
      });
      server.middlewares.use("/api/admin/users", async (req, res) => {
        const { handleAdminUsers } = await server.ssrLoadModule("/api/_lib/admin-core.js");
        await handleAdminUsers(req, res, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          secretKey: env.SUPABASE_SECRET_KEY,
        });
      });
      server.middlewares.use("/api/admin/delete-user", async (req, res) => {
        const { handleDeleteUser } = await server.ssrLoadModule("/api/_lib/admin-core.js");
        await handleDeleteUser(req, res, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          secretKey: env.SUPABASE_SECRET_KEY,
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss(), devApi(env)],
    server: {
      proxy: {
        // Forwards /v1/... -> https://api.anthropic.com/v1/...
        // API key injected server-side; never exposed to the browser.
        "/v1": {
          target: "https://api.anthropic.com",
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.removeHeader("origin");
              proxyReq.removeHeader("referer");
              proxyReq.setHeader("x-api-key", env.ANTHROPIC_API_KEY || "");
              proxyReq.setHeader("anthropic-version", "2023-06-01");
            });
          },
        },
      },
    },
  };
});

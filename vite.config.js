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
      // MCP endpoint. Same handler Vercel runs; needs the service key, which is
      // why it reads from env here rather than the publishable key the SPA uses.
      server.middlewares.use("/api/mcp", async (req, res) => {
        const { handleMcpRequest } = await server.ssrLoadModule("/api/_lib/mcp-core.js");
        await handleMcpRequest(req, res, {
          supabaseUrl: env.SUPABASE_URL || env.VITE_SUPABASE_URL,
          secretKey: env.SUPABASE_SECRET_KEY,
        });
      });
      // Same Anthropic proxy + Gemini fallback the Vercel function runs in prod.
      server.middlewares.use("/v1/messages", async (req, res) => {
        const { handleMessages } = await server.ssrLoadModule("/api/_lib/messages-core.js");
        await handleMessages(req, res, {
          anthropicKey: env.ANTHROPIC_API_KEY,
          geminiKey: env.GEMINI_API_KEY,
          supabaseUrl: env.SUPABASE_URL || env.VITE_SUPABASE_URL,
          supabaseSecret: env.SUPABASE_SECRET_KEY,
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss(), devApi(env)],
  };
});

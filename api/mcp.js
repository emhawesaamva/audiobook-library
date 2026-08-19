// Vercel Serverless Function — MCP (Model Context Protocol) endpoint.
//
// POST /api/mcp with `Authorization: Bearer <personal access token>`, minted in
// the app's Settings. Each token is bound to one library and every tool call is
// hard-scoped to it. No model is ever called from here: the connecting client
// does all the reasoning, and this server just stores and looks things up.
import { handleMcpRequest } from "./_lib/mcp-core.js";

// Catalogue and series lookups batch-fetch volume details and can exceed the
// default 10s, same as /api/metadata.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  await handleMcpRequest(req, res, {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  });
}

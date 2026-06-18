// Vercel Serverless Function — proxies /v1/messages to Anthropic via the shared
// core, which also falls back to Gemini Flash and flags app_settings when the
// Anthropic credit balance is exhausted. Node.js runtime with maxDuration: 60 to
// accommodate web-search calls that can take 20-40 seconds.
import { handleMessages } from "../_lib/messages-core.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  await handleMessages(req, res, {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    supabaseSecret: process.env.SUPABASE_SECRET_KEY,
  });
}

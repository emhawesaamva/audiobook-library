// Vercel Serverless Function — admin-only user listing.
// GET /api/admin/users with the caller's Supabase JWT as a Bearer token.
import { handleAdminUsers } from "../_lib/admin-core.js";

export default function handler(req, res) {
  return handleAdminUsers(req, res, {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  });
}

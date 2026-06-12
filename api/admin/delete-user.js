import { handleDeleteUser } from "../_lib/admin-core.js";

export default function handler(req, res) {
  return handleDeleteUser(req, res, {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
  });
}

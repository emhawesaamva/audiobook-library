// Executes a .sql file (or inline SQL) against the Supabase project via the
// Management API. Auth: SUPABASE_ACCESS_TOKEN in .env/environment, or the
// token stored by `supabase login` (%APPDATA%/supabase/access-token).
//
// Usage: node scripts/run-sql.js supabase/schema.sql
//        node scripts/run-sql.js --query "select count(*) from books"
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  try {
    for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* optional */ }
}
loadEnv();

function getToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try {
    const p = resolve(process.env.APPDATA, "supabase", "access-token");
    return readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

const token = getToken();
if (!token) {
  console.error("No SUPABASE_ACCESS_TOKEN in .env and no CLI login token found.");
  process.exit(1);
}

const ref = new URL(process.env.VITE_SUPABASE_URL).hostname.split(".")[0];

const [, , arg, inline] = process.argv;
const sql = arg === "--query" ? inline : readFileSync(resolve(root, arg), "utf8");

const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const text = await r.text();
if (!r.ok) {
  console.error(`FAILED (${r.status}): ${text.slice(0, 2000)}`);
  process.exit(1);
}
try {
  const data = JSON.parse(text);
  console.log(JSON.stringify(data, null, 2).slice(0, 5000));
} catch {
  console.log(text.slice(0, 2000) || "OK (no output)");
}
console.log(`\nDone: ${arg === "--query" ? "inline query" : arg}`);

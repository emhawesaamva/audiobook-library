// Dumps every row of the legacy audiobook_library table to backups/audiobook_library-<ISO>.json.
// Requires VITE_SUPABASE_URL and SUPABASE_SECRET_KEY in .env (or the environment).
// The secret key only works server-side with a non-browser User-Agent.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  try {
    for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* .env optional if vars already set */ }
}
loadEnv();

const URL_BASE = process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL_BASE || !KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "User-Agent": "library-migration/1.0",
};

async function fetchAll() {
  const rows = [];
  const page = 500;
  for (let offset = 0; ; offset += page) {
    const r = await fetch(
      `${URL_BASE}/rest/v1/audiobook_library?select=*&order=id&limit=${page}&offset=${offset}`,
      { headers }
    );
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < page) return rows;
  }
}

const rows = await fetchAll();

// Independent count check via Prefer: count=exact
const countResp = await fetch(`${URL_BASE}/rest/v1/audiobook_library?select=id`, {
  method: "HEAD",
  headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
});
const total = Number(countResp.headers.get("content-range")?.split("/")[1] ?? NaN);

if (!Number.isFinite(total) || total !== rows.length) {
  console.error(`COUNT MISMATCH: fetched ${rows.length}, table reports ${total}`);
  process.exit(1);
}

mkdirSync(resolve(root, "backups"), { recursive: true });
const file = resolve(root, "backups", `audiobook_library-${new Date().toISOString().replace(/[:]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(rows, null, 2));
console.log(`Backed up ${rows.length} rows (table count: ${total}) -> ${file}`);

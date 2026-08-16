// Shared helpers for server-side scripts. Loads .env and exposes a minimal
// PostgREST/auth-admin client using the secret key (service role).
// Supabase rejects secret keys sent with a browser-like User-Agent, so every
// request sets a custom one.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refFromUrl, assertNotProductionUrl } from "./production-refs.js";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv() {
  try {
    for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* .env optional if vars already set */ }
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    console.error("Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY");
    process.exit(1);
  }
  return { url, key };
}

const { url: BASE, key: KEY } = loadEnv();

const baseHeaders = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "User-Agent": "library-migration/1.0",
  "Content-Type": "application/json",
};

// Re-exported from production-refs.js so scripts that already import common.js
// keep working; that module is side-effect-free and is the single source of
// truth for which refs are production.
export { PRODUCTION_REFS, refFromUrl, isProductionUrl } from "./production-refs.js";

export function projectRef() {
  return refFromUrl(BASE);
}

// Call at the top of any script that creates or destroys accounts.
export function assertNotProduction(scriptName = "this script") {
  return assertNotProductionUrl(BASE, scriptName);
}

export async function rest(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: { ...baseHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function authAdmin(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}/auth/v1/admin/${path}`, {
    method,
    headers: baseHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`auth ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function findUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const data = await authAdmin(`users?page=${page}&per_page=100`);
    const users = data.users ?? data;
    if (!users.length) break;
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (users.length < 100) break;
  }
  return null;
}

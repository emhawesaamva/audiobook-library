// Shared helpers for server-side scripts. Loads .env and exposes a minimal
// PostgREST/auth-admin client using the secret key (service role).
// Supabase rejects secret keys sent with a browser-like User-Agent, so every
// request sets a custom one.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// Production project refs. The E2E and integration suites sign up and delete
// throwaway accounts through the admin API; pointed at production that deletes
// real accounts and cascades their whole library away. `.env` legitimately
// points at production for `npm run dev`, so the guard lives here rather than
// relying on whoever edits the file to remember.
const PRODUCTION_REFS = new Set(["lschyxipktswvmicodij"]);

export function projectRef() {
  return new URL(BASE).hostname.split(".")[0];
}

// Call at the top of any script that creates or destroys accounts.
export function assertNotProduction(scriptName = "this script") {
  const ref = projectRef();
  if (!PRODUCTION_REFS.has(ref)) return ref;
  if (process.env.ALLOW_PRODUCTION_WRITES === "1") {
    console.warn(`WARNING: ${scriptName} running against PRODUCTION (${ref}) — ALLOW_PRODUCTION_WRITES=1 was set.`);
    return ref;
  }
  console.error(
    `Refusing to run ${scriptName} against the production project (${ref}).\n` +
    `It creates and deletes real auth users, which cascades away real libraries.\n\n` +
    `Point VITE_SUPABASE_URL and SUPABASE_SECRET_KEY at the dedicated test project\n` +
    `("Library Test"), e.g.:\n` +
    `  VITE_SUPABASE_URL=https://<test-ref>.supabase.co SUPABASE_SECRET_KEY=<test-secret> npm run test:e2e\n\n` +
    `Set ALLOW_PRODUCTION_WRITES=1 only if you genuinely mean to touch production.`
  );
  process.exit(1);
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

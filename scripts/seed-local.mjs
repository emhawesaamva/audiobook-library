// Seeds the LOCAL Supabase stack with a ready-to-use library, so a freshly reset
// database is something you can actually sign into and look at.
//
// `npm run db:reset` runs this automatically after the migrations. Run it by hand
// with `npm run db:seed`.
//
// The data lives in supabase/seed-data.json, captured from whatever is currently
// in the local database with `npm run db:capture`. That round trip is the point:
// arrange the books you want in the UI, capture, and every later reset restores
// exactly that.
//
// Guards: this script creates and deletes auth users and wipes a library, so it
// refuses to run against the production project (via the shared PRODUCTION_REFS
// check) and, beyond that, against anything that is not a loopback URL. There is
// no override flag — point it somewhere local or it does nothing.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isProductionUrl, refFromUrl } from "./production-refs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(root, "supabase/seed-data.json");
const capture = process.argv.includes("--capture");

// ---- env ----
function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* fall through to process.env */ }
  const url = process.env.VITE_SUPABASE_URL || out.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || out.SUPABASE_SECRET_KEY;
  if (!url || !key) die("Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY — run `npm run db:use-local` first.");
  return { url, key };
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const { url: BASE, key: KEY } = loadEnv();

// ---- guards ----
if (isProductionUrl(BASE)) {
  die(
    `Refusing to seed the production project (${refFromUrl(BASE)}).\n` +
    `This script deletes libraries and rewrites an auth user's password.\n` +
    `Run \`npm run db:use-local\` to point .env at the local stack first.`
  );
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)) {
  die(`Refusing to seed a non-local target (${BASE}). This script only runs against the local Supabase stack.`);
}

// ---- tiny REST/auth client ----
const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "User-Agent": "library-seed/1.0",
  "Content-Type": "application/json",
};
async function api(path, { method = "GET", body, auth = false, prefer } = {}) {
  const r = await fetch(`${BASE}/${auth ? "auth/v1" : "rest/v1"}/${path}`, {
    method,
    headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// The local database can lag the migration files (a column added straight to the
// hosted project, or a migration edited after the local stack already ran it).
// Rather than fail the whole seed on one unknown column, drop what the target
// does not have and say so.
async function columnsOf(table) {
  const spec = await api("");
  return Object.keys(spec.definitions?.[table]?.properties ?? {});
}
function project(rows, cols, table) {
  const dropped = new Set();
  const out = rows.map((row) => {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      if (cols.includes(k)) o[k] = v;
      else dropped.add(k);
    }
    return o;
  });
  if (dropped.size) {
    console.warn(`  note: ${table} column(s) not present in this database, skipped: ${[...dropped].join(", ")}`);
    console.warn(`        the local schema is behind the migrations — \`npm run db:reset\` should fix it.`);
  }
  return out;
}

async function findUser(email) {
  const res = await api("admin/users?per_page=1000", { auth: true });
  return (res.users ?? res).find((u) => u.email === email) ?? null;
}

// ---------------- capture ----------------
if (capture) {
  const email = process.env.SEED_EMAIL || readSeed()?.user?.email;
  if (!email) die("No account to capture. Pass SEED_EMAIL=<address>, or seed once so seed-data.json names one.");
  const user = await findUser(email);
  if (!user) die(`No local auth user for ${email} — nothing to capture.`);

  const profiles = await api(`profiles?account_id=eq.${user.id}&select=*&order=sort_order`);
  const books = [];
  for (const p of profiles) books.push(...await api(`books?profile_id=eq.${p.id}&select=*`));

  const existing = readSeed();
  const seed = {
    _comment: "Captured from the local Supabase stack by `npm run db:capture`. Applied by `npm run db:seed` and by `npm run db:reset`.",
    capturedAt: new Date().toISOString(),
    user: {
      email,
      // Kept in the clear on purpose: this is a throwaway local login, and a seed
      // you cannot sign into is useless. Never reuse it anywhere real.
      password: process.env.SEED_PASSWORD || existing?.user?.password || "test-audiolib-1234",
    },
    profiles,
    books,
  };
  writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2) + "\n");
  console.log(`captured ${profiles.length} profile(s) and ${books.length} books for ${email}`);
  console.log(`wrote ${SEED_PATH}`);
  process.exit(0);
}

// ---------------- apply ----------------
function readSeed() {
  if (!existsSync(SEED_PATH)) return null;
  return JSON.parse(readFileSync(SEED_PATH, "utf8"));
}

const seed = readSeed();
if (!seed) {
  console.log(`No ${SEED_PATH} — nothing to seed. (Create one with \`npm run db:capture\`.)`);
  process.exit(0);
}

const { email, password } = seed.user;
console.log(`seeding ${BASE} from supabase/seed-data.json`);

let user = await findUser(email);
if (user) {
  // Reset the password so the seed file stays the source of truth even if the
  // account was created by hand or by an earlier seed with a different one.
  await api(`admin/users/${user.id}`, { auth: true, method: "PUT", body: { password, email_confirm: true } });
} else {
  user = await api("admin/users", { auth: true, method: "POST", body: { email, password, email_confirm: true } });
}

// public.accounts is written by the on_auth_user_created trigger; wait for it.
let account;
for (let i = 0; i < 20 && !account; i++) {
  [account] = await api(`accounts?id=eq.${user.id}&select=id`);
  if (!account) await new Promise((r) => setTimeout(r, 150));
}
if (!account) die("The accounts row was never created — is the on_auth_user_created trigger present?");

// Replace rather than merge: a seed should be idempotent, and books cascade from
// profiles, so this clears the previous copy in one delete.
const previous = await api(`profiles?account_id=eq.${user.id}&select=id`);
for (const p of previous) await api(`profiles?id=eq.${p.id}`, { method: "DELETE" });

const profileCols = await columnsOf("profiles");
const bookCols = await columnsOf("books");
const profiles = project(seed.profiles.map((p) => ({ ...p, account_id: user.id })), profileCols, "profiles");
if (profiles.length) await api("profiles", { method: "POST", body: profiles });

// Series headers and standalone books first: members carry a parent_id FK.
const books = project(seed.books, bookCols, "books");
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
for (const group of [books.filter((b) => b.parent_id == null), books.filter((b) => b.parent_id != null)]) {
  for (const c of chunk(group, 100)) await api("books", { method: "POST", body: c });
}

console.log(`seeded ${profiles.length} profile(s) and ${books.length} books`);
// Printed as a banner because it is the one thing you need after a reset and the
// one thing that is easy to miss scrolling past migration output.
const rows = [`email:    ${email}`, `password: ${password}`];
const w = Math.max(20, ...rows.map((r) => r.length)) + 4;
console.log("");
console.log(`  ┌${"─".repeat(w)}┐`);
console.log(`  │${"  Local dev sign-in".padEnd(w)}│`);
for (const r of rows) console.log(`  │${("    " + r).padEnd(w)}│`);
console.log(`  └${"─".repeat(w)}┘`);
console.log("");
console.log("  This is the LOCAL stack — your real account will not work here.");

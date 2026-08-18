// Rebuilds the local seed from the hosted project: reads a real library out of
// production and writes it to supabase/seed-data.json, which `npm run db:seed`
// then applies to the local stack (and regenerates seed.sql from).
//
//   npm run db:clone-prod                 # the sole account, or $OWNER_EMAIL
//   npm run db:clone-prod -- a@b.com      # a specific account
//
// This exists because the seed files are gitignored — they are somebody's real
// library and the repo is public — so a fresh clone, or a laptop that lost its
// local stack, has no way back to a usable database. Capture only goes local →
// files; this is the missing files ← production leg.
//
// Production is opened through a client that physically refuses any method other
// than GET, so this cannot write to the hosted project however it is invoked.
// Nothing here touches the local database either; it only writes the JSON.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isProductionUrl, refFromUrl } from "./production-refs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(root, "supabase/seed-data.json");
// db:use-local moves the hosted config aside; that copy is the source here.
const PROD_ENV = resolve(root, process.env.PROD_ENV_FILE || ".env.hosted-backup");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function envOf(file) {
  if (!existsSync(file)) {
    die(`No ${file}. That file is written by \`npm run db:use-local\` when it points .env at\n` +
        `the local stack; set PROD_ENV_FILE to wherever your hosted credentials live.`);
  }
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const prod = envOf(PROD_ENV);
const url = prod.VITE_SUPABASE_URL;
const key = prod.SUPABASE_SECRET_KEY;
if (!url || !key) die(`${PROD_ENV} is missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY.`);
if (/127\.0\.0\.1|localhost/.test(url)) {
  die(`${PROD_ENV} points at a local stack (${url}) — there is nothing to clone from.\n` +
      `It should hold the hosted credentials.`);
}

// Read-only by construction rather than by discipline: the only verb this client
// can issue is GET, so no argument, flag or later edit can make it write.
async function get(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method: "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "User-Agent": "library-clone/1.0" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const ref = refFromUrl(url);
console.log(`source: ${ref}${isProductionUrl(url) ? " (production)" : ""} — read-only`);

// ---- pick the account ----
const wanted = process.argv.slice(2).find((a) => !a.startsWith("-")) || process.env.OWNER_EMAIL;
const accounts = await get("accounts?select=id,email&order=created_at");
if (!accounts.length) die("That project has no accounts.");
let account;
if (wanted) {
  account = accounts.find((a) => a.email.toLowerCase() === wanted.toLowerCase());
  if (!account) die(`No account for ${wanted}. Found: ${accounts.map((a) => a.email).join(", ")}`);
} else if (accounts.length === 1) {
  account = accounts[0];
} else {
  die(`That project has ${accounts.length} accounts — name one:\n` +
      accounts.map((a) => `  npm run db:clone-prod -- ${a.email}`).join("\n"));
}

// ---- pull ----
const profiles = await get(`profiles?account_id=eq.${account.id}&select=*&order=sort_order`);
const books = [];
for (const p of profiles) books.push(...await get(`books?profile_id=eq.${p.id}&select=*`));
console.log(`pulled ${profiles.length} profile(s) and ${books.length} books`);

// ---- write the seed ----
// Keep whatever login the existing seed already used, so re-cloning does not
// silently change the password someone has in a browser.
const existing = existsSync(SEED_PATH) ? JSON.parse(readFileSync(SEED_PATH, "utf8")) : null;
const seed = {
  _comment: "Written by `npm run db:clone-prod` from the hosted project. Applied by `npm run db:seed`, which also regenerates seed.sql.",
  capturedAt: new Date().toISOString(),
  clonedFrom: ref,
  user: {
    // Provisional: seed-local.mjs records the id GoTrue actually assigns.
    id: existing?.user?.id || randomUUID(),
    email: process.env.SEED_EMAIL || existing?.user?.email || "test@audiolib.io",
    password: process.env.SEED_PASSWORD || existing?.user?.password || "test-audiolib-1234",
  },
  profiles,
  books,
};
writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2) + "\n");
console.log(`wrote ${SEED_PATH}`);
console.log("");
console.log("  Next:  npm run db:seed     (applies it locally and regenerates seed.sql)");
console.log(`  Login: ${seed.user.email} / ${seed.user.password}`);

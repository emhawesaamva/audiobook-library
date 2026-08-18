// Seeds the LOCAL Supabase stack with a ready-to-use library, so a freshly reset
// database is something you can actually sign into and look at.
//
// Two paths reach the same state. `supabase db reset` (however it is invoked)
// seeds from the generated supabase/seed.sql via the CLI's [db.seed] hook; this
// script applies supabase/seed-data.json over the REST API for an
// already-running database, as `npm run db:seed`. Both files come from
// `npm run db:capture`.
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
// The CLI's [db.seed] hook in config.toml already points here.
const SQL_PATH = resolve(root, "supabase/seed.sql");
const capture = process.argv.includes("--capture");
// seed.sql raises the same details as a NOTICE, which the CLI does print — but
// buried mid-run, above "Restarting containers...". db:reset chases the reset
// with --print so the credentials are also the last thing on screen.
const printOnly = process.argv.includes("--print");

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

// ---- SQL generation ----
// The Supabase CLI's own seed hook ([db.seed] in config.toml) runs .sql files,
// not scripts, so a plain `npx supabase db reset` cannot call this file. Capture
// therefore also emits supabase/seed.sql, which reproduces the same state in SQL
// and makes both reset paths equivalent.
function lit(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (Array.isArray(v)) return v.length ? `array[${v.map(lit).join(", ")}]::text[]` : `'{}'::text[]`;
  if (typeof v === "object") return `${lit(JSON.stringify(v))}::jsonb`;
  // standard_conforming_strings is on by default, so backslashes are literal and
  // doubling the quote is the whole of the escaping.
  return `'${String(v).replace(/'/g, "''")}'`;
}

function insertStatements(table, rows, cols, chunkSize = 100) {
  if (!rows.length) return "";
  const out = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const values = rows.slice(i, i + chunkSize)
      .map((r) => `  (${cols.map((c) => lit(r[c])).join(", ")})`)
      .join(",\n");
    out.push(`insert into ${table} (${cols.join(", ")}) values\n${values};`);
  }
  return out.join("\n\n");
}

function buildSeedSql(seed, { profileCols, bookCols }) {
  const { id: uid, email, password } = seed.user;
  const profiles = seed.profiles.map((p) => ({ ...p, account_id: uid }));
  const parents = seed.books.filter((b) => b.parent_id == null);
  const members = seed.books.filter((b) => b.parent_id != null);
  const banner = `Local dev sign-in:  ${email}  /  ${password}`;

  return `-- Generated by \`npm run db:capture\` — do not edit by hand.
--
-- Runs automatically during \`supabase db reset\` via [db.seed] in config.toml,
-- so a bare \`npx supabase db reset\` seeds exactly like \`npm run db:reset\`.
-- The equivalent path for an already-running database is \`npm run db:seed\`,
-- which applies supabase/seed-data.json over the REST API instead.
--
-- Gitignored: a capture is somebody's real library, and this repo is public.

begin;

-- Safety net. \`supabase db reset --linked\` would run this against the linked
-- (production) project, so refuse anywhere that already holds real accounts. A
-- freshly reset local stack has none, and re-seeding over a previous run has
-- only this one.
do $$
begin
  if exists (select 1 from public.accounts where email <> ${lit(email)}) then
    raise exception 'refusing to seed: this database holds other accounts, so it is not a scratch local stack';
  end if;
end $$;

-- Replace any previous copy. public.accounts, profiles and books all cascade
-- from auth.users, so this one delete clears the lot.
delete from auth.users where email = ${lit(email)};

-- public.accounts is written by the on_auth_user_created trigger on this insert.
-- pgcrypto lives in the extensions schema on Supabase, hence the qualification.
--
-- The empty-string token columns are not decoration. They are nullable in the
-- schema, but GoTrue scans them into non-nullable Go strings, so leaving them
-- NULL makes every sign-in fail with a 500 "Database error querying schema"
-- while the rows themselves look perfectly fine. phone stays NULL — it carries a
-- unique index, so '' would collide across users.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values (
  '00000000-0000-0000-0000-000000000000', ${lit(uid)}, 'authenticated', 'authenticated',
  ${lit(email)}, extensions.crypt(${lit(password)}, extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
  '', '', '', '', '', '', '', ''
);

-- Without a matching identity row GoTrue rejects the password grant.
-- auth.identities.email is GENERATED ALWAYS, so it is deliberately not listed.
insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  ${lit(uid)}, ${lit(uid)},
  jsonb_build_object('sub', ${lit(uid)}, 'email', ${lit(email)}, 'email_verified', true, 'phone_verified', false),
  'email', now(), now(), now()
);

${insertStatements("public.profiles", profiles, profileCols)}

-- Series headers and standalone books first: members carry a parent_id FK.
${insertStatements("public.books", parents, bookCols)}

${insertStatements("public.books", members, bookCols)}

do $$
begin
  raise notice '%', repeat('-', ${banner.length + 4});
  raise notice '  %', ${lit(banner)};
  raise notice '  This is the LOCAL stack — your real account will not work here.';
  raise notice '%', repeat('-', ${banner.length + 4});
end $$;

commit;
`;
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
    _comment: "Captured from the local Supabase stack by `npm run db:capture`. Applied by `npm run db:seed`, and by `supabase db reset` via the generated seed.sql.",
    capturedAt: new Date().toISOString(),
    user: {
      // Pinned so the JSON and SQL paths create the same account row.
      id: user.id,
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

  // Emit the SQL twin so `npx supabase db reset` seeds too. Columns are filtered
  // against the live schema for the same reason the REST path filters them.
  const liveProfileCols = await columnsOf("profiles");
  const liveBookCols = await columnsOf("books");
  const sql = buildSeedSql(seed, {
    profileCols: Object.keys(profiles[0] ?? {}).filter((c) => liveProfileCols.includes(c)),
    bookCols: Object.keys(books[0] ?? {}).filter((c) => liveBookCols.includes(c)),
  });
  writeFileSync(SQL_PATH, sql);
  console.log(`wrote ${SQL_PATH} (${(sql.length / 1024).toFixed(0)}K)`);
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

function printCredentials() {
  const rows = [`email:    ${email}`, `password: ${password}`];
  const w = Math.max(20, ...rows.map((r) => r.length)) + 4;
  console.log("");
  console.log(`  ┌${"─".repeat(w)}┐`);
  console.log(`  │${"  Local dev sign-in".padEnd(w)}│`);
  for (const r of rows) console.log(`  │${("    " + r).padEnd(w)}│`);
  console.log(`  └${"─".repeat(w)}┘`);
  console.log("");
  console.log("  This is the LOCAL stack — your real account will not work here.");
}

if (printOnly) {
  printCredentials();
  process.exit(0);
}

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

// Keep the seed files describing reality. GoTrue assigns the auth id, so a JSON
// written by another tool (scripts/clone-prod-to-local.mjs) will not know it
// until now; record it and regenerate the SQL twin so the CLI reset path lands
// on the same rows this run just created.
if (seed.user.id !== user.id) {
  seed.user.id = user.id;
  writeFileSync(SEED_PATH, JSON.stringify(seed, null, 2) + "\n");
}
writeFileSync(SQL_PATH, buildSeedSql(seed, {
  profileCols: Object.keys(profiles[0] ?? {}),
  bookCols: Object.keys(books[0] ?? {}),
}));
console.log(`regenerated ${SQL_PATH}`);

// The one thing you need after a reset, and the easiest thing to miss scrolling
// past migration output.
printCredentials();

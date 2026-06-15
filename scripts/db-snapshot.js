// One-shot DB snapshot script — reads .env, never hardcodes credentials.
// Usage: node scripts/db-snapshot.js [email]
import { readFileSync } from "fs";
import { resolve } from "path";

const env = Object.fromEntries(
  readFileSync(resolve(process.cwd(), ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const url = env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SECRET_KEY;
const h = { apikey: key, Authorization: `Bearer ${key}` };
const get = (path) => fetch(`${url}/rest/v1/${path}`, { headers: h }).then((r) => r.json());

const email = process.argv[2] ?? "mobile-test@library-integration.test";

// Auth user list to find the user's auth ID
const authResp = await fetch(`${url}/auth/v1/admin/users?per_page=200`, { headers: h });
const authData = await authResp.json();
const authUser = (authData.users ?? authData).find((u) => u.email === email);

const accts = await get(`accounts?email=eq.${encodeURIComponent(email)}&select=*`);
const acct = accts[0];

if (!acct) { console.log("User not found:", email); process.exit(1); }

const profiles = await get(`profiles?account_id=eq.${acct.id}&select=*`);
const profileIds = profiles.map((p) => p.id);

let books = [], goals = [], snapshots = [], rejected = [], settings = [];
if (profileIds.length) {
  const pIn = `(${profileIds.join(",")})`;
  [books, goals, snapshots, rejected] = await Promise.all([
    get(`books?profile_id=in.${pIn}&select=id,title,is_series,parent_id`),
    get(`reading_goals?profile_id=in.${pIn}&select=*`),
    get(`library_snapshots?profile_id=in.${pIn}&select=id,created_at`),
    get(`rejected_recommendations?profile_id=in.${pIn}&select=*`),
  ]);
}
settings = await get(`user_settings?account_id=eq.${acct.id}&select=*`);

const bookReads = books.length
  ? await get(`book_reads?book_id=in.(${books.map((b) => b.id).join(",")})&select=*`)
  : [];

console.log("\n═══ BEFORE-DELETE SNAPSHOT ═══");
console.log(`Email:         ${acct.email}`);
console.log(`Account ID:    ${acct.id}`);
console.log(`Auth user ID:  ${authUser?.id ?? "(not found in auth.users)"}`);
console.log(`Is admin:      ${acct.is_admin}`);
console.log(`Joined:        ${acct.created_at?.slice(0, 10)}`);
console.log(`\nProfiles:      ${profiles.length}`);
profiles.forEach((p) => console.log(`  • ${p.id}  "${p.name}"`));
console.log(`Books:         ${books.length}`);
console.log(`Book reads:    ${bookReads.length}`);
console.log(`Goals:         ${goals.length}`);
console.log(`Snapshots:     ${snapshots.length}`);
console.log(`Rejected:      ${rejected.length}`);
console.log(`User settings: ${settings.length}`);
console.log("\nAll IDs to verify gone after delete:");
console.log("  accounts:", acct.id);
profiles.forEach((p) => console.log("  profile: ", p.id));
books.forEach((b) => console.log("  book:    ", b.id, `"${b.title ?? "(series)"}"`));
console.log("══════════════════════════════\n");

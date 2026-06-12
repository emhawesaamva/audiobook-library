// Integration test against the live Supabase project using throwaway accounts.
// Verifies: signup trigger, profile/book CRUD through user JWTs, RLS isolation
// between accounts, admin self-promotion prevention, app_settings access.
// Cleans up its test users afterwards (cascade removes all their data).
//
// Usage: node scripts/test-integration.js
import { authAdmin, findUserByEmail, loadEnv } from "./common.js";

const { url: BASE } = loadEnv();
const ANON = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const TEST_A = "test-a@library-integration.test";
const TEST_B = "test-b@library-integration.test";
const PASSWORD = "test-password-1234";

async function deleteIfExists(email) {
  const u = await findUserByEmail(email);
  if (u) await authAdmin(`users/${u.id}`, { method: "DELETE" });
}

// Sign in as a user via the password grant; returns an authed REST helper.
async function signIn(email) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`sign-in ${email}: ${JSON.stringify(data).slice(0, 200)}`);
  const jwt = data.access_token;
  const rest = async (path, { method = "GET", body, headers = {} } = {}) => {
    const resp = await fetch(`${BASE}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: ANON, Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json", Prefer: "return=representation", ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await resp.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status: resp.status, data: parsed };
  };
  return { jwt, rest, userId: data.user.id };
}

// ---- setup: fresh test users (admin API auto-confirms email) ----
await deleteIfExists(TEST_A);
await deleteIfExists(TEST_B);
await authAdmin("users", { method: "POST", body: { email: TEST_A, password: PASSWORD, email_confirm: true } });
await authAdmin("users", { method: "POST", body: { email: TEST_B, password: PASSWORD, email_confirm: true } });
console.log("Created test users A and B\n");

const a = await signIn(TEST_A);
const b = await signIn(TEST_B);

// 1. Signup trigger created accounts rows
const acctA = await a.rest(`accounts?select=*&id=eq.${a.userId}`);
check("signup trigger created account row", acctA.data?.[0]?.email === TEST_A);
check("new account is not admin", acctA.data?.[0]?.is_admin === false);

// 2. A cannot read B's account
const acctCross = await a.rest(`accounts?select=*&id=eq.${b.userId}`);
check("A cannot see B's account row", acctCross.data?.length === 0);

// 3. A cannot self-promote to admin
const promote = await a.rest(`accounts?id=eq.${a.userId}`, { method: "PATCH", body: { is_admin: true } });
const acctAfter = await a.rest(`accounts?select=is_admin&id=eq.${a.userId}`);
check("A cannot self-promote to admin", acctAfter.data?.[0]?.is_admin === false, `patch status ${promote.status}`);

// 4. Profile creation (account_id defaults to auth.uid())
const profA = await a.rest("profiles", { method: "POST", body: { name: "Test Library" } });
check("A creates a profile", profA.status === 201 && profA.data?.[0]?.account_id === a.userId);
const profileId = profA.data?.[0]?.id;

// 5. Book CRUD through the profile
const bookA = await a.rest("books", {
  method: "POST",
  body: { profile_id: profileId, title: "Test Book", author: "Tester", status: "read", rating: 4.5 },
});
check("A creates a book (half-star rating)", bookA.status === 201 && Number(bookA.data?.[0]?.rating) === 4.5);
const bookId = bookA.data?.[0]?.id;

const upd = await a.rest(`books?id=eq.${bookId}`, { method: "PATCH", body: { status: "dnf", dnf_reason: "test" } });
check("A updates own book", upd.status === 200 && upd.data?.[0]?.status === "dnf");

// 6. RLS isolation: B sees nothing of A's
const crossProfiles = await b.rest("profiles?select=*");
check("B sees zero profiles", crossProfiles.data?.length === 0);
const crossBooks = await b.rest("books?select=*");
check("B sees zero books", crossBooks.data?.length === 0);
const crossPatch = await b.rest(`books?id=eq.${bookId}`, { method: "PATCH", body: { title: "hacked" } });
check("B cannot modify A's book", (crossPatch.data?.length ?? 0) === 0);
const crossInsert = await b.rest("books", {
  method: "POST", body: { profile_id: profileId, title: "intruder" },
});
check("B cannot insert into A's profile", crossInsert.status === 403 || crossInsert.status === 401 || crossInsert.status === 400, `status ${crossInsert.status}`);

// 7. Legacy table: check exposure through anon/user keys
const legacy = await a.rest("audiobook_library?select=id&limit=1");
check("legacy table NOT readable by users (pending lock)", legacy.data?.length === 0 || legacy.status >= 400,
  legacy.data?.length ? "STILL EXPOSED — public_access policy needs dropping" : "");

// 8. app_settings readable, not writable by non-admin
const settings = await a.rest("app_settings?select=*");
check("app_settings readable", settings.status === 200 && settings.data?.length >= 2);
const settingsWrite = await a.rest("app_settings", { method: "POST", body: { key: "hack", value: true } });
check("app_settings not writable by non-admin", settingsWrite.status === 403 || settingsWrite.status === 401, `status ${settingsWrite.status}`);

// 9. rejected_recommendations + snapshots + goals + book_reads round-trip
const rej = await a.rest("rejected_recommendations", { method: "POST", body: { profile_id: profileId, title: "Bad Book" } });
check("rejected insert", rej.status === 201);
const goal = await a.rest("reading_goals", { method: "POST", body: { profile_id: profileId, year: 2026, goal_type: "books", target: 12 } });
check("goal insert", goal.status === 201);
const read = await a.rest("book_reads", { method: "POST", body: { book_id: bookId, date_finished: "2026-01-15" } });
check("book_reads insert", read.status === 201);
const snap = await a.rest("library_snapshots", { method: "POST", body: { profile_id: profileId, data: [] } });
check("snapshot insert", snap.status === 201);

// 10. user_settings upsert
const us = await a.rest("user_settings", {
  method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  body: { account_id: a.userId, theme: "light" },
});
check("user_settings upsert", us.status === 201 || us.status === 200);

// ---- cleanup ----
await deleteIfExists(TEST_A);
await deleteIfExists(TEST_B);
const gone = await findUserByEmail(TEST_A);
check("\ncleanup: test users deleted", gone === null);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll integration checks passed.");
process.exit(failures ? 1 : 0);

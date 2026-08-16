// Diagnostic for the local Supabase stack: walks the exact path the E2E suite
// takes (admin-create a user, sign in, insert a profile) and prints the real
// status and body at each hop. Run after `npm run db:use-local`.
//
// Exists because a PostgREST 403 in a browser console says only "Forbidden" —
// the useful detail is in the response body, which the app never surfaces.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const URL_ = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const SECRET = env.SUPABASE_SECRET_KEY;
const EMAIL = `diag-${Date.now()}@library-integration.test`;
const PASSWORD = "diag-password-1234";

const show = async (label, r) => {
  const body = await r.text();
  console.log(`\n--- ${label}: ${r.status} ${r.statusText}`);
  console.log(body.slice(0, 500) || "(empty)");
  return body;
};

console.log(`stack: ${URL_}`);

// 1. Does the signup trigger exist and fire? (accounts row is created by it)
const created = await fetch(`${URL_}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
});
const createdBody = await show("admin create user", created);
const uid = (() => { try { return JSON.parse(createdBody).id; } catch { return null; } })();
console.log(`uid: ${uid}`);

const acct = await fetch(`${URL_}/rest/v1/accounts?select=id,email&id=eq.${uid}`, {
  headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
});
await show("accounts row (created by on_auth_user_created trigger)", acct);

// 2. Sign in as that user and insert a profile — the step that 403s in E2E.
const tok = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const tokBody = await show("password grant", tok);
const jwt = (() => { try { return JSON.parse(tokBody).access_token; } catch { return null; } })();

if (jwt) {
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
  console.log(`\njwt sub=${claims.sub} role=${claims.role} aud=${claims.aud}`);

  const ins = await fetch(`${URL_}/rest/v1/profiles`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ name: "Diagnostic Library" }),
  });
  await show("insert profile as the signed-in user", ins);
}

// Clean up.
if (uid) {
  await fetch(`${URL_}/auth/v1/admin/users/${uid}`, {
    method: "DELETE", headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` },
  });
}

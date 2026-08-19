// Integration test against the live Supabase project using throwaway accounts.
// Verifies: signup trigger, profile/book CRUD through user JWTs, RLS isolation
// between accounts, admin self-promotion prevention, app_settings access.
// Cleans up its test users afterwards (cascade removes all their data).
//
// Usage: node scripts/test-integration.js
import { authAdmin, findUserByEmail, loadEnv, assertNotProduction } from "./common.js";

const { url: BASE } = loadEnv();
assertNotProduction("test-integration.js");
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

// 11. mcp_tokens: RLS, column grants, and the single-library scoping property
// This is the only test that exercises the MCP's service-role data path against
// a real database, so it matters more than the unit suite: mcp-scope.js bypasses
// RLS entirely, and these checks are what prove the code-level scoping holds.
const { createHash, randomBytes } = await import("node:crypto");
const mintToken = () => {
  const raw = `alib_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
};

// A second library under the same account — the case a per-library token must
// not be able to cross.
const p2 = await a.rest("profiles", {
  method: "POST", headers: { Prefer: "return=representation" },
  body: { account_id: a.userId, name: "Second Library" },
});
const profile2Id = p2.data?.[0]?.id;
check("A can create a second library", !!profile2Id, `status ${p2.status}`);
const b2 = await a.rest("books", {
  method: "POST", headers: { Prefer: "return=representation" },
  body: { profile_id: profile2Id, title: "Only In Library Two" },
});
const book2Id = b2.data?.[0]?.id;

const tokenA = mintToken();
const mint = await a.rest("mcp_tokens", {
  method: "POST", headers: { Prefer: "return=representation" },
  body: { account_id: a.userId, profile_id: profileId, name: "integration", token_prefix: tokenA.raw.slice(0, 13), token_hash: tokenA.hash },
});
check("A can mint a token for their own library", mint.status === 201, `status ${mint.status}`);
const tokenRowId = mint.data?.[0]?.id;

// The insert policy's WITH CHECK proves ownership of the bound library, so a
// token cannot be pointed at somebody else's from the start.
const bTokenForA = await b.rest("mcp_tokens", {
  method: "POST",
  body: { account_id: b.userId, profile_id: profileId, name: "steal", token_prefix: "alib_x", token_hash: "c".repeat(64) },
});
check("B cannot mint a token bound to A's library", bTokenForA.status >= 400, `status ${bTokenForA.status}`);
const bTokenAsA = await b.rest("mcp_tokens", {
  method: "POST",
  body: { account_id: a.userId, profile_id: profileId, name: "steal", token_prefix: "alib_x", token_hash: "d".repeat(64) },
});
check("B cannot mint a token as A", bTokenAsA.status >= 400, `status ${bTokenAsA.status}`);

const bSees = await b.rest("mcp_tokens?select=id");
check("B cannot see A's tokens", (bSees.data ?? []).length === 0, `${bSees.data?.length ?? "?"} rows`);

// profiles and books ARE anon-readable for share links; credentials are not.
// Easy mistake to make given the default-privileges grant, so guard it loudly.
const anonResp = await fetch(`${BASE}/rest/v1/mcp_tokens?select=id`, { headers: { apikey: ANON } });
const anonRows = anonResp.ok ? await anonResp.json() : [];
check("the anon key cannot read mcp_tokens at all", anonRows.length === 0,
  anonRows.length ? "EXPOSED — check RLS on mcp_tokens" : "");

// Column grants, not policy: nothing may repoint a live token or swap its hash.
const rename = await a.rest(`mcp_tokens?id=eq.${tokenRowId}`, { method: "PATCH", body: { name: "renamed" } });
check("A can rename their own token", rename.status === 204 || rename.status === 200, `status ${rename.status}`);
const rebind = await a.rest(`mcp_tokens?id=eq.${tokenRowId}`, { method: "PATCH", body: { profile_id: profile2Id } });
check("nobody can repoint a token at another library", rebind.status >= 400, `status ${rebind.status}`);
const rehash = await a.rest(`mcp_tokens?id=eq.${tokenRowId}`, { method: "PATCH", body: { token_hash: "e".repeat(64) } });
check("nobody can swap a token's hash", rehash.status >= 400, `status ${rehash.status}`);

// ---- the service-role path: drive the real handler with the real token ----
const { handleMcpRequest } = await import("../api/_lib/mcp-core.js");
// Drive the handler over a real HTTP server rather than a stub req/res pair.
// The SDK's Node transport wraps @hono/node-server, which converts a genuine
// IncomingMessage/ServerResponse into a Web Standard Request — a hand-rolled
// fake does not satisfy it and every call comes back 400 with an empty body.
// Vercel and the Vite dev middleware both hand over real objects, so this
// matches production; anything less tests the wrong thing.
const { createServer } = await import("node:http");
const mcpServer = createServer((req, res) =>
  handleMcpRequest(req, res, { supabaseUrl: BASE, secretKey: process.env.SUPABASE_SECRET_KEY }));
await new Promise((r) => mcpServer.listen(0, "127.0.0.1", r));
const MCP_ORIGIN = `http://127.0.0.1:${mcpServer.address().port}`;

const mcp = async (body, token) => {
  const r = await fetch(MCP_ORIGIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const tool = async (name, args, token = tokenA.raw) => {
  const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } }, token);
  const text = r.body?.result?.content?.[0]?.text;
  return { status: r.status, isError: !!r.body?.result?.isError, payload: r.body?.result?.isError ? text : (text ? JSON.parse(text) : null) };
};

const listed = await tool("list_books", {});
const titles = (listed.payload?.items ?? []).map((x) => x.title);
check("the token reads its own library", titles.includes("Test Book"), titles.join(", ") || "no rows");
check("the token cannot see the account's OTHER library", !titles.includes("Only In Library Two"));

const crossRead = await tool("get_book", { book_id: book2Id });
check("reading a book from another library fails", crossRead.isError && /No such book/.test(crossRead.payload), String(crossRead.payload));
const crossWrite = await tool("update_books", { updates: [{ book_id: book2Id, patch: { rating: 1 } }] });
check("writing a book in another library fails", crossWrite.isError && /No such book/.test(crossWrite.payload), String(crossWrite.payload));
// And confirm nothing actually changed over there.
const untouched = await a.rest(`books?id=eq.${book2Id}&select=rating`);
check("the other library's book is untouched", untouched.data?.[0]?.rating == null);

const revoked = await a.rest(`mcp_tokens?id=eq.${tokenRowId}`, { method: "PATCH", body: { revoked_at: new Date().toISOString() } });
check("A can revoke their token", revoked.status === 204 || revoked.status === 200);
const afterRevoke = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, tokenA.raw);
check("a revoked token is refused", afterRevoke.status === 401, `status ${afterRevoke.status}`);

// Deleting the bound library cascades its tokens away.
const tokenB2 = mintToken();
await a.rest("mcp_tokens", {
  method: "POST",
  body: { account_id: a.userId, profile_id: profile2Id, name: "cascade", token_prefix: tokenB2.raw.slice(0, 13), token_hash: tokenB2.hash },
});
await a.rest(`profiles?id=eq.${profile2Id}`, { method: "DELETE" });
const orphan = await a.rest(`mcp_tokens?token_hash=eq.${tokenB2.hash}&select=id`);
check("deleting a library destroys its tokens", (orphan.data ?? []).length === 0);
const afterCascade = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, tokenB2.raw);
check("a token whose library is gone is refused", afterCascade.status === 401, `status ${afterCascade.status}`);

mcpServer.close();

// ---- cleanup ----
await deleteIfExists(TEST_A);
await deleteIfExists(TEST_B);
const gone = await findUserByEmail(TEST_A);
check("\ncleanup: test users deleted", gone === null);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll integration checks passed.");
process.exit(failures ? 1 : 0);

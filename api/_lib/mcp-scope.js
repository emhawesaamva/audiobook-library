// The MCP server's authorization boundary.
//
// /api/mcp authenticates with a personal access token, not a Supabase user JWT,
// so RLS cannot apply — PostgREST is called with the service key, which bypasses
// every policy in supabase/migrations/. This file is therefore the ONLY thing
// standing between a token and another library's data. It is deliberately small
// and boring so that a reviewer can read it end to end and conclude that a token
// cannot escape the one library it is bound to.
//
// Considered and rejected: minting a short-lived JWT with sub = account_id so
// RLS would do the work. The project JWT secret is not in the deployed env set;
// RLS is scoped per *account*, not per library, so this file would still be
// needed to enforce the single-library property; and Supabase's publishable /
// secret key model deprecates hand-rolled JWTs. The stronger future option is a
// `security definer` Postgres function taking the token hash and doing the
// scoping in SQL — that would also give real transactions, which PostgREST
// cannot.
//
// Rules enforced below, each covered by a named test in test/mcp-core.test.js:
//   - every read carries the bound profile_id (or account_id)
//   - every id-targeted write filters on BOTH id AND profile_id, so a forged id
//     matches zero rows instead of another library's row
//   - inserts are stamped with the bound profile_id, last, after cleanBookFields
//   - only an allowlist of tables is reachable at all
//   - ids and filter values are validated/encoded, never interpolated raw

import { cleanBookFields } from "../../src/lib/bookUtils.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tables an MCP token may touch. Everything absent from this set is
// unreachable: accounts, feedback, library_snapshots, app_settings (except the
// narrow read below), reading_goals and rejected_recommendations are all out of
// scope for the MCP by design.
const TABLES = new Set(["books", "book_reads", "profiles", "user_settings", "mcp_tokens"]);

// One narrow exception: Audible links carry the affiliate tag the app appends
// everywhere else, and it lives in app_settings. That table is already
// world-readable (appsettings_read ... using (true)), so this grants no
// privilege — but it is SELECT-only and pinned to the single key.
const APP_SETTINGS_READ_KEY = "affiliate_tag";

export function assertUuid(value, label = "id") {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new McpScopeError(`Invalid ${label}`);
  }
  return value;
}

export class McpScopeError extends Error {}

// PostgREST filter values are interpolated into a query string, so an
// unescaped value containing `&or=(...)` would append a filter of the
// attacker's choosing and escape the scope entirely. Every value that reaches a
// URL goes through here. (api/_lib/admin-core.js interpolates ids raw; that is
// safe there because the value came from a verified admin, and unsafe here
// because values arrive from a connected LLM.)
function eq(column, value) {
  return `${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`;
}

const UA = { "User-Agent": "audiolib.io/1.0 (+https://audiolib.io)" };

export function makeScope(env, { accountId, profileId, tokenId, canWrite }) {
  const pid = assertUuid(profileId, "profile id");
  const aid = assertUuid(accountId, "account id");
  const headers = {
    apikey: env.secretKey,
    Authorization: `Bearer ${env.secretKey}`,
    "Content-Type": "application/json",
    ...UA,
  };

  // Every PostgREST request in the MCP path goes through this one function.
  async function rest(table, query, { method = "GET", body, prefer } = {}) {
    if (!TABLES.has(table)) throw new McpScopeError(`Table not permitted: ${table}`);
    const res = await fetch(`${env.supabaseUrl}/rest/v1/${table}?${query}`, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new McpScopeError(pgMessage(data));
    return data;
  }

  // ---- scoped selects ----

  const scoped = (extra = "") => `${eq("profile_id", pid)}${extra ? `&${extra}` : ""}`;

  async function selectBooks(extra = "", { limit, offset, order } = {}) {
    const parts = [scoped(extra), "select=*"];
    if (order) parts.push(`order=${encodeURIComponent(order)}`);
    if (limit != null) parts.push(`limit=${Number(limit)}`);
    if (offset) parts.push(`offset=${Number(offset)}`);
    return rest("books", parts.join("&"));
  }

  // The single read the MCP makes outside its own tables. SELECT only, one key.
  async function getAffiliateTag() {
    const res = await fetch(
      `${env.supabaseUrl}/rest/v1/app_settings?${eq("key", APP_SETTINGS_READ_KEY)}&select=value`,
      { headers }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const v = rows?.[0]?.value;
    return typeof v === "string" && v ? v : null;
  }

  async function getProfile() {
    const rows = await rest("profiles", `${eq("id", pid)}&${eq("account_id", aid)}&select=*`);
    if (!rows?.length) throw new McpScopeError("This token's library no longer exists");
    return rows[0];
  }

  async function getSettings() {
    const rows = await rest("user_settings", `${eq("account_id", aid)}&select=*`);
    return rows?.[0] ?? null;
  }

  // ---- scoped writes ----
  // Every one of these filters on BOTH the row id and the bound profile_id, so
  // an id belonging to another library matches nothing and the write is a no-op
  // that we surface as an error rather than a silent success.

  function assertWritable() {
    if (!canWrite) throw new McpScopeError("This token is read-only");
  }

  async function getBook(bookId) {
    const rows = await rest("books", `${eq("id", assertUuid(bookId, "book id"))}&${scoped()}&select=*`);
    if (!rows?.length) throw new McpScopeError("No such book in this library");
    return rows[0];
  }

  async function insertBooks(rows) {
    assertWritable();
    // Shaping happens HERE rather than in the callers. Every caller in
    // mcp-tools.js already runs cleanBookFields, but this is the security
    // boundary: it must hold on its own, not because the code above it is
    // currently well behaved. cleanBookFields is idempotent, so running it
    // twice costs nothing.
    //
    // profile_id is stamped LAST. That ordering is load-bearing, not merely
    // defensive: profile_id IS in bookUtils' BOOK_COLUMNS allowlist, so a
    // caller-supplied profile_id survives cleaning and would otherwise land in
    // another library.
    const stamped = rows.map((r) => ({ ...cleanBookFields(r), profile_id: pid }));
    return rest("books", "select=*", { method: "POST", body: stamped, prefer: "return=representation" });
  }

  async function patchBook(bookId, patch) {
    assertWritable();
    const rows = await rest(
      "books",
      `${eq("id", assertUuid(bookId, "book id"))}&${scoped()}&select=*`,
      // Same reasoning as insertBooks: shape at the boundary, so a patch can
      // never carry a column the app's own write path would have rejected.
      { method: "PATCH", body: cleanBookFields(patch), prefer: "return=representation" }
    );
    if (!rows?.length) throw new McpScopeError("No such book in this library");
    return rows[0];
  }

  async function deleteBook(bookId) {
    assertWritable();
    const rows = await rest(
      "books",
      `${eq("id", assertUuid(bookId, "book id"))}&${scoped()}&select=id`,
      { method: "DELETE", prefer: "return=representation" }
    );
    if (!rows?.length) throw new McpScopeError("No such book in this library");
    return rows;
  }

  // book_reads has no profile_id of its own, so ownership is established by
  // resolving the parent book under scope first.
  async function insertRead(bookId, row) {
    assertWritable();
    const book = await getBook(bookId);
    return rest("book_reads", "select=*", {
      method: "POST",
      body: [{ ...row, book_id: book.id }],
      prefer: "return=representation",
    });
  }

  async function listReads(bookId) {
    const book = await getBook(bookId);
    return rest("book_reads", `${eq("book_id", book.id)}&select=*&order=created_at`);
  }

  async function patchProfile(patch) {
    assertWritable();
    const rows = await rest(
      "profiles",
      `${eq("id", pid)}&${eq("account_id", aid)}&select=*`,
      { method: "PATCH", body: patch, prefer: "return=representation" }
    );
    if (!rows?.length) throw new McpScopeError("This token's library no longer exists");
    return rows[0];
  }

  // user_settings is keyed on account_id, so this is the one write that reaches
  // past the bound library — see the Libby-key note in docs/DESIGN-mcp-server.md.
  async function mergeSettings(patch) {
    assertWritable();
    const current = await getSettings();
    const merged = { ...(current?.settings ?? {}), ...patch };
    const rows = await rest("user_settings", "select=*", {
      method: "POST",
      body: [{ account_id: aid, settings: merged }],
      prefer: "resolution=merge-duplicates,return=representation",
    });
    return rows?.[0] ?? null;
  }

  async function stampUsage(patch) {
    if (!tokenId) return;
    try {
      await rest("mcp_tokens", eq("id", tokenId), { method: "PATCH", body: patch });
    } catch {
      /* best-effort: a failed usage stamp must never fail the tool call */
    }
  }

  return {
    profileId: pid, accountId: aid, canWrite,
    rest, selectBooks, getProfile, getSettings, getAffiliateTag,
    getBook, insertBooks, patchBook, deleteBook, insertRead, listReads,
    patchProfile, mergeSettings, stampUsage, assertWritable,
  };
}

// Postgres constraint violations are not actionable by a connected model —
// `violates check constraint "books_hold_pair"` tells it nothing about what to
// send instead. Map the named constraints this schema defines onto sentences.
const CONSTRAINT_HELP = {
  no_nested_series: "A series volume can't itself be a series. Set series_id on a plain book instead.",
  series_rating_derived: "A series header can't carry a rating or a status — those come from its volumes.",
  books_hold_pair: "A hold needs both a wait in weeks and a date. Pass both, or pass weeks: null to clear it.",
  books_hold_weeks_range: "A hold wait must be between 1 and 104 weeks.",
  books_rating_check: "Ratings are 0 to 5 in half-star steps (e.g. 3, 3.5, 4).",
  books_progress_percent_check: "progress_percent must be between 0 and 100.",
  books_duration_minutes_check: "duration_minutes must be greater than 0.",
  books_status_check: "status must be one of: read, reading, wanttoread, recommended, dnf.",
  books_source_check: "source must be one of: audible, goodreads, libby, storygraph, other.",
  profiles_account_id_name_key: "You already have a library with that name.",
  profiles_age_group_check: "age_group must be one of: adult, teens, children.",
};

export function pgMessage(data) {
  const raw = data?.message ?? data?.error ?? "Database request failed";
  for (const [name, help] of Object.entries(CONSTRAINT_HELP)) {
    if (typeof raw === "string" && raw.includes(name)) return help;
  }
  return raw;
}

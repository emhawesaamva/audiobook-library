// Data layer over the v2 relational schema. All access is scoped to the
// signed-in user by RLS; this module never needs to filter by account.
import supabase from "./supabase.js";

function throwOn(error) {
  if (error) throw new Error(error.message);
}

// ---- profiles ----

export async function listProfiles(accountId) {
  // Always scope to the calling user — admins see all rows via RLS but should
  // only see their own libraries in the switcher.
  let q = supabase.from("profiles").select("*").order("sort_order").order("created_at");
  if (accountId) q = q.eq("account_id", accountId);
  const { data, error } = await q;
  throwOn(error);
  return data;
}

export async function createProfile(name, ageGroup = "adult") {
  const { data, error } = await supabase
    .from("profiles")
    .insert({ name, age_group: ageGroup })
    .select()
    .single();
  throwOn(error);
  return data;
}

export async function updateProfile(id, patch) {
  const { data, error } = await supabase
    .from("profiles").update(patch).eq("id", id).select().single();
  throwOn(error);
  return data;
}

export async function deleteProfile(id) {
  const { error } = await supabase.from("profiles").delete().eq("id", id);
  throwOn(error);
}

// ---- books ----

// Returns the app's in-memory shape: top-level entries ordered for display,
// with series headers carrying `books: [children sorted by series_position]`.
export async function loadBooks(profileId) {
  const { data, error } = await supabase
    .from("books")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at");
  throwOn(error);
  const byParent = new Map();
  for (const b of data) {
    if (b.parent_id) {
      if (!byParent.has(b.parent_id)) byParent.set(b.parent_id, []);
      byParent.get(b.parent_id).push(b);
    }
  }
  return data
    .filter((b) => !b.parent_id)
    .map((b) =>
      b.is_series
        ? {
            ...b,
            books: (byParent.get(b.id) ?? []).sort(
              (a, c) => (a.series_position ?? 0) - (c.series_position ?? 0)
            ),
          }
        : b
    );
}

const BOOK_COLUMNS = new Set([
  "profile_id", "parent_id", "is_series", "title", "author", "genre", "subgenre",
  "status", "rating", "loved", "notes", "year", "goodreads_rating", "goodreads_url",
  "cover_url", "narrator", "duration_minutes", "description", "date_started",
  "date_finished", "isbn", "asin", "series_position", "progress_percent",
  "dnf_reason", "recommended_by", "queue_position", "reread_count", "tags",
]);

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (BOOK_COLUMNS.has(k)) out[k] = v === "" ? null : v;
  }
  // Series headers keep rating/status NULL (derived from children).
  if (out.is_series) { out.rating = null; out.status = null; }
  if (out.rating != null && !(Number(out.rating) > 0)) out.rating = null;
  return out;
}

export async function createBook(fields) {
  const { data, error } = await supabase
    .from("books").insert(clean(fields)).select().single();
  throwOn(error);
  return data;
}

export async function createBooks(rows) {
  const { data, error } = await supabase
    .from("books").insert(rows.map(clean)).select();
  throwOn(error);
  return data;
}

export async function updateBook(id, patch) {
  const { data, error } = await supabase
    .from("books").update(clean(patch)).eq("id", id).select().single();
  throwOn(error);
  return data;
}

export async function deleteBook(id) {
  const { error } = await supabase.from("books").delete().eq("id", id);
  throwOn(error);
}

// ---- up-next queue ----

export async function setQueuePositions(entries) {
  // entries: [{id, queue_position}] — small N, sequential updates are fine.
  for (const { id, queue_position } of entries) {
    const { error } = await supabase.from("books").update({ queue_position }).eq("id", id);
    throwOn(error);
  }
}

// ---- re-listen history ----

export async function listReads(bookId) {
  const { data, error } = await supabase
    .from("book_reads").select("*").eq("book_id", bookId).order("created_at");
  throwOn(error);
  return data;
}

export async function addRead(bookId, dateStarted, dateFinished) {
  const { error } = await supabase
    .from("book_reads")
    .insert({ book_id: bookId, date_started: dateStarted, date_finished: dateFinished });
  throwOn(error);
}

// ---- goals ----

export async function listGoals(profileId) {
  const { data, error } = await supabase
    .from("reading_goals").select("*").eq("profile_id", profileId);
  throwOn(error);
  return data;
}

export async function setGoal(profileId, year, goalType, target) {
  if (!target) {
    const { error } = await supabase
      .from("reading_goals").delete()
      .eq("profile_id", profileId).eq("year", year).eq("goal_type", goalType);
    throwOn(error);
    return null;
  }
  const { data, error } = await supabase
    .from("reading_goals")
    .upsert(
      { profile_id: profileId, year, goal_type: goalType, target },
      { onConflict: "profile_id,year,goal_type" }
    )
    .select()
    .single();
  throwOn(error);
  return data;
}

// ---- rejected recommendations ----

export async function listRejected(profileId) {
  const { data, error } = await supabase
    .from("rejected_recommendations").select("title").eq("profile_id", profileId);
  throwOn(error);
  return data.map((r) => r.title);
}

export async function addRejected(profileId, title) {
  const { error } = await supabase
    .from("rejected_recommendations")
    .insert({ profile_id: profileId, title });
  // Unique index violation just means it's already there.
  if (error && !`${error.message}`.includes("duplicate")) throw new Error(error.message);
}

// ---- snapshots (one per profile per session; keep the newest 30) ----

const snapshotted = new Set();

export async function snapshot(profileId, books) {
  if (snapshotted.has(profileId)) return;
  snapshotted.add(profileId);
  try {
    await supabase.from("library_snapshots").insert({ profile_id: profileId, data: books });
    const { data } = await supabase
      .from("library_snapshots")
      .select("id")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .range(30, 1000);
    if (data?.length) {
      await supabase.from("library_snapshots").delete().in("id", data.map((s) => s.id));
    }
  } catch (e) {
    console.warn("Snapshot failed:", e.message);
  }
}

// ---- settings ----

export async function getUserSettings(accountId) {
  const { data, error } = await supabase
    .from("user_settings").select("*").eq("account_id", accountId).maybeSingle();
  throwOn(error);
  return data ?? { account_id: accountId, theme: null, default_profile_id: null, settings: {} };
}

export async function saveUserSettings(accountId, patch) {
  const { error } = await supabase
    .from("user_settings")
    .upsert({ account_id: accountId, ...patch }, { onConflict: "account_id" });
  throwOn(error);
}

export async function getAppSettings() {
  const { data, error } = await supabase.from("app_settings").select("key,value");
  throwOn(error);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

export async function setAppSetting(key, value) {
  const { error } = await supabase
    .from("app_settings").upsert({ key, value }, { onConflict: "key" });
  throwOn(error);
}

// ---- account ----

export async function getAccount(accountId) {
  const { data, error } = await supabase
    .from("accounts").select("*").eq("id", accountId).maybeSingle();
  throwOn(error);
  return data;
}

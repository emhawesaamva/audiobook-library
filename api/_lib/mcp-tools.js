// The MCP tool registry: what a connected LLM can do with one AudioLib library.
//
// The organising principle: this server stores and looks things up, and never
// performs inference. Where the app calls Claude — recommendations, paste
// import, book identification — the MCP instead hands the connecting model the
// grounding it needs and lets it reason. get_taste_profile is the tool the
// whole design exists for; everything else supports the loop around it.
//
// Imports from src/lib/ are the first api/ -> src/ imports in this repo. Each
// one is a pure module with no browser globals, traced into the Vercel function
// bundle at build time. That safety is not enforced anywhere, so if a future
// change adds a browser-only import to one of them this function breaks at
// build time with no warning — test/mcp-core.test.js imports the same chain
// under plain Node and is the tripwire.
import { searchBooks, seriesVolumes, libbyAvailability } from "./metadata-core.js";
import { McpScopeError, assertUuid } from "./mcp-scope.js";
import {
  cleanBookFields, withAutoDates, getStatus, calcSeriesRating, titleKey, sameTitle,
  audibleSearchUrl, libbySearchUrl, holdWeeksLeft, listenedMinutes, fmtDuration,
  audienceInstruction, ADULT_AUDIENCE_GUIDANCE,
} from "../../src/lib/bookUtils.js";
import { computeStats, listeningYears } from "../../src/lib/stats.js";
import { toLibbyState } from "../../src/lib/libbyStatus.js";

const STATUSES = ["read", "reading", "wanttoread", "recommended", "dnf"];
const SOURCES = ["audible", "goodreads", "libby", "storygraph", "other"];
const MAX_BULK = 100;
const MAX_AVAILABILITY_BATCH = 20;

// ---------------------------------------------------------------- utilities

// A Vercel function runs in UTC, but the app deliberately uses a *local*
// calendar date (see today() in bookUtils) because toISOString() rolls forward
// in the evening west of Greenwich and shifts every finish date and hold
// countdown by a day. The client knows its own date; tools accept it.
function resolveToday(args) {
  const t = args?.today;
  return typeof t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t)
    ? t
    : new Date().toISOString().slice(0, 10);
}

// db.loadBooks' in-memory shape: top-level rows, series headers carrying their
// volumes sorted by position. Several tools need it to reuse getStatus and
// calcSeriesRating, which are written against that shape.
function nest(rows) {
  const byParent = new Map();
  for (const b of rows) {
    if (!b.parent_id) continue;
    if (!byParent.has(b.parent_id)) byParent.set(b.parent_id, []);
    byParent.get(b.parent_id).push(b);
  }
  return rows
    .filter((b) => !b.parent_id)
    .map((b) =>
      b.is_series
        ? { ...b, books: (byParent.get(b.id) ?? []).sort((a, c) => (a.series_position ?? 0) - (c.series_position ?? 0)) }
        : b
    );
}

const SUMMARY_FIELDS = [
  "id", "title", "author", "narrator", "status", "rating", "loved", "genre",
  "series_position", "parent_id", "is_series", "queue_position", "duration_minutes",
];

function summarise(b) {
  const out = {};
  for (const f of SUMMARY_FIELDS) if (b[f] != null) out[f] = b[f];
  return out;
}

function envelope(items, { total, limit, offset }) {
  const nextOffset = offset + items.length;
  return {
    items, total, limit, offset,
    has_more: nextOffset < total,
    next_offset: nextOffset < total ? nextOffset : null,
  };
}

// Descriptions come back from Audible and can be long; they are also the most
// plausible prompt-injection vector into a model that has been told to act on
// this data. Truncate hard everywhere they surface.
function trimDescription(d) {
  if (!d) return null;
  const s = String(d).replace(/\s+/g, " ").trim();
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

function ok(payload, nextStep) {
  return nextStep ? { ...payload, next_step: nextStep } : payload;
}

// PostgREST caps how many rows one request returns (Supabase's db-max-rows,
// 1000 by default). An unbounded select therefore truncates a big library
// SILENTLY — and the tool that suffers most is get_taste_profile, whose
// "already owned" list would quietly stop covering everything and start
// recommending books the listener already has. Page instead.
const PAGE = 1000;
async function loadAllBooks(scope, { order = "created_at" } = {}) {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await scope.selectBooks("", { order, limit: PAGE, offset });
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

// ------------------------------------------------------- the taste profile

// Everything the in-app recommender puts into its system prompt
// (src/lib/ai.js fetchRecommendations), assembled as data instead.
export function buildTasteProfile(profile, rows, { maxTitles = 400 } = {}) {
  const nested = nest(rows);
  const flat = rows.filter((b) => !b.is_series);

  const lovedBooks = flat.filter((b) => b.loved || Number(b.rating) >= 5);
  const lovedAuthors = [...new Set(lovedBooks.map((b) => b.author).filter(Boolean))];
  const lovedGenres = [...new Set(lovedBooks.map((b) => b.subgenre || b.genre).filter(Boolean))];

  const readingNow = flat.filter((b) => b.status === "reading");
  const recentlyFinished = flat
    .filter((b) => b.status === "read" && b.date_finished)
    .sort((a, b) => (a.date_finished < b.date_finished ? 1 : -1))
    .slice(0, 12);

  const disliked = flat.filter((b) => Number(b.rating) > 0 && Number(b.rating) <= 2.5);
  const abandoned = flat.filter((b) => b.status === "dnf");

  const stats = computeStats(flat, new Date().getFullYear());

  const allTitles = rows.map((b) => b.title).filter(Boolean);
  // Loved titles are never dropped by truncation — they are the strongest
  // signal, and recommending something the listener already adores is the most
  // visible way for this to look broken.
  const lovedTitles = new Set(lovedBooks.map((b) => b.title));
  const truncated = allTitles.length > maxTitles;
  const excludeTitles = truncated
    ? [...new Set([...lovedTitles, ...allTitles.slice(-Math.max(0, maxTitles - lovedTitles.size))])]
    : allTitles;

  return {
    profile_name: profile.name,
    age_group: profile.age_group,
    guidance: audienceInstruction(profile.age_group) ?? ADULT_AUDIENCE_GUIDANCE,
    loved_books: lovedBooks.map((b) => ({
      title: b.title, author: b.author, rating: b.rating == null ? null : Number(b.rating),
      genre: b.genre, subgenre: b.subgenre,
    })),
    loved_authors: lovedAuthors,
    loved_genres: lovedGenres,
    reading_now: readingNow.map((b) => ({
      title: b.title, author: b.author, progress_percent: b.progress_percent,
    })),
    recently_finished: recentlyFinished.map((b) => ({
      title: b.title, author: b.author,
      rating: b.rating == null ? null : Number(b.rating), date_finished: b.date_finished,
    })),
    top_authors: stats.topAuthors,
    top_narrators: stats.topNarrators,
    top_genres: stats.topGenres,
    disliked: disliked.map((b) => ({ title: b.title, rating: Number(b.rating) })),
    abandoned: abandoned.map((b) => ({
      title: b.title, dnf_reason: b.dnf_reason, progress_percent: b.progress_percent,
    })),
    exclude_titles: excludeTitles,
    // titleKey normalisations, so the client can tell "Project Hail Mary: A
    // Novel" from the copy it already owns without another round trip.
    exclude_keys: [...new Set(excludeTitles.map(titleKey).filter(Boolean))],
    counts: {
      total: rows.length,
      entries: nested.length,
      loved: lovedBooks.length,
      finished: stats.finishedEver,
      hours_listened: Math.round(stats.minutesEver / 60),
    },
    truncated,
  };
}

// The same profile rendered as a block a model can drop straight into a
// recommendation prompt. This is what makes the tool useful rather than merely
// informative: a raw JSON dump leaves the model to invent its own framing, and
// the framing is where the audience rule and the exclusions actually bite.
export function renderTasteBlock(p) {
  const L = [];
  const n = p.counts.total;
  L.push(`=== Listener profile: "${p.profile_name}" (${p.age_group} library, ${n} book${n === 1 ? "" : "s"}) ===`);
  L.push("");
  L.push("AUDIENCE RULE — must be honoured:");
  L.push(p.guidance);
  L.push("");

  const join = (xs) => xs.join(" · ");
  const star = (r) => (r ? ` (${r}★)` : "");

  if (p.loved_books.length) {
    L.push(`LOVED (${p.loved_books.length}): ` +
      join(p.loved_books.slice(0, 40).map((b) => `${b.title}${b.author ? ` — ${b.author}` : ""}${star(b.rating)}`)));
  } else {
    L.push("LOVED: not yet established");
  }
  L.push(`LOVED AUTHORS: ${p.loved_authors.join(", ") || "not yet established"}`);
  L.push(`ENJOYED GENRES: ${p.loved_genres.join(", ") || "not yet established — default to adult fiction"}`);
  L.push(`LISTENING NOW: ${
    p.reading_now.map((b) => `${b.title}${b.author ? ` — ${b.author}` : ""}${b.progress_percent ? ` (${b.progress_percent}%)` : ""}`).join(" · ") || "nothing"
  }`);
  if (p.recently_finished.length) {
    L.push(`RECENTLY FINISHED: ` +
      join(p.recently_finished.map((b) => `${b.title}${star(b.rating)}`)));
  }
  if (p.top_narrators.length) {
    L.push(`NARRATORS THEY RETURN TO: ${p.top_narrators.map(([na, c]) => `${na} (${c})`).join(", ")}`);
  }
  if (p.disliked.length) {
    L.push(`RATED LOW — avoid this register: ${join(p.disliked.slice(0, 15).map((b) => `${b.title}${star(b.rating)}`))}`);
  }
  if (p.abandoned.length) {
    L.push(`ABANDONED: ${join(p.abandoned.slice(0, 15).map((b) =>
      `${b.title}${b.dnf_reason ? ` — "${b.dnf_reason}"` : ""}${b.progress_percent ? ` (${b.progress_percent}%)` : ""}`))}`);
  }
  L.push("");
  L.push(`ALREADY OWNED — do not recommend any of these (${p.exclude_titles.length}${p.truncated ? " shown, list truncated" : ""}):`);
  L.push(join(p.exclude_titles));
  if (p.truncated) L.push("(Truncated — call list_books to page through the rest before committing to a pick.)");
  L.push("");
  L.push("HOW TO USE THIS");
  L.push("Ground every pick in a specific loved title or author above, and say which.");
  L.push("Never recommend anything on the owned list.");
  L.push("Then: verify every pick with search_catalog, and call check_availability on the");
  L.push("survivors before presenting anything. Present each pick with its Audible link");
  L.push("and, where the library stocks it, its Libby link and current wait.");
  L.push("Do not write recommendations back — present them in the conversation.");
  return L.join("\n");
}

// ------------------------------------------------------------ book shaping

// Everything a caller may set on a book. profile_id and parent_id are absent on
// purpose: the scope stamps the first, and the second is derived from series_id
// after an ownership check.
const BOOK_PROPS = {
  title: { type: "string" },
  author: { type: "string" }, narrator: { type: "string" },
  genre: { type: "string" }, subgenre: { type: "string" },
  description: { type: "string" }, notes: { type: "string" },
  cover_url: { type: "string" }, isbn: { type: "string" }, asin: { type: "string" },
  goodreads_url: { type: "string" }, goodreads_rating: { type: "number" },
  recommended_by: { type: "string", description: "Who suggested it — a person's name, or an assistant's." },
  status: { type: "string", enum: STATUSES },
  rating: { type: "number", minimum: 0, maximum: 5, description: "0-5 in half-star steps." },
  loved: { type: "boolean" },
  year: { type: "integer" },
  duration_minutes: { type: "integer", minimum: 1 },
  progress_percent: { type: "integer", minimum: 0, maximum: 100 },
  dnf_reason: { type: "string" },
  series_position: { type: "number" },
  tags: { type: "array", items: { type: "string" } },
  source: { type: "string", enum: SOURCES },
  date_started: { type: "string", description: "YYYY-MM-DD" },
  date_finished: { type: "string", description: "YYYY-MM-DD" },
  queue_position: { type: ["integer", "null"], description: "Up Next order; null removes it from the queue." },
};

async function shapeBook(scope, input, { seriesId, todayStr, enrich, prev } = {}) {
  let fields = { ...input };
  delete fields.series_id;

  if (enrich) {
    const meta = await enrichFromCatalog(fields);
    fields = { ...meta, ...fields }; // caller-supplied values always win
  }

  if (seriesId) {
    const header = await scope.getBook(seriesId);
    if (!header.is_series) throw new McpScopeError("That book is not a series header");
    fields.parent_id = header.id;
    fields.is_series = false;
  }

  const cleaned = cleanBookFields(withAutoDates(fields, prev, todayStr));
  if (!cleaned.title && !prev) throw new McpScopeError("Every book needs a title");
  return cleaned;
}

// Fill only what is missing, exactly as the app's metadata refresh does —
// existing values are never overwritten.
async function enrichFromCatalog(fields) {
  if (!fields.title) return {};
  try {
    const { source, results } = await searchBooks(`${fields.title} ${fields.author ?? ""}`.trim(), 5);
    if (source !== "audible" || !results?.length) return {};
    const match = results.find((r) => sameTitle(r.title, fields.title)) ?? results[0];
    return {
      author: match.author, narrator: match.narrator, year: match.year,
      duration_minutes: match.duration_minutes, cover_url: match.cover_url,
      asin: match.asin, genre: match.genre, subgenre: match.subgenre,
      goodreads_rating: match.public_rating?.average ?? null,
      description: trimDescription(match.description),
      source: "audible",
    };
  } catch {
    return {}; // enrichment is a convenience; never fail a write over it
  }
}

// ------------------------------------------------------------------- tools

export const TOOLS = [
  {
    name: "get_taste_profile",
    write: false,
    description:
      "Call this FIRST, before answering, whenever the listener asks what to read or listen to next, " +
      "asks for a recommendation, asks for something 'like X', or describes a mood they want matched. " +
      "Returns their listening profile as a ready-to-use prompt block: loved books and authors, genres, " +
      "what they are listening to now, what they abandoned, and every title they already own (never " +
      "recommend those). This server does no inference — reason from this block yourself.",
    inputSchema: {
      type: "object",
      properties: {
        max_titles: { type: "integer", minimum: 50, maximum: 2000, description: "Cap on the owned-titles exclusion list. Default 400." },
        format: { type: "string", enum: ["prompt", "data", "both"], description: "Default 'both'." },
      },
    },
    async handler(scope, args) {
      const [profile, rows] = await Promise.all([scope.getProfile(), loadAllBooks(scope)]);
      const profileData = buildTasteProfile(profile, rows, { maxTitles: args.max_titles ?? 400 });
      const format = args.format ?? "both";
      const out = {};
      if (format !== "data") out.prompt_block = renderTasteBlock(profileData);
      if (format !== "prompt") out.data = profileData;
      return ok(out, "Reason from this yourself, then verify each pick with search_catalog before presenting it.");
    },
  },

  {
    name: "get_library",
    write: false,
    description: "The library this token is bound to: name, age group, book counts by status, the genres/tags/recommenders already in use, Libby settings, and its public share URL.",
    inputSchema: { type: "object", properties: {} },
    async handler(scope) {
      const [profile, rows, settings] = await Promise.all([
        scope.getProfile(), loadAllBooks(scope), scope.getSettings(),
      ]);
      const nested = nest(rows);
      const leaves = rows.filter((b) => !b.is_series);
      const byStatus = {};
      for (const s of STATUSES) byStatus[s] = leaves.filter((b) => b.status === s).length;
      return {
        id: profile.id, name: profile.name, age_group: profile.age_group,
        created_at: profile.created_at,
        counts: {
          total: rows.length, entries: nested.length,
          series: rows.filter((b) => b.is_series).length,
          by_status: byStatus,
          loved: leaves.filter((b) => b.loved).length,
          queued: rows.filter((b) => b.queue_position != null).length,
          unrated: leaves.filter((b) => !(Number(b.rating) > 0)).length,
        },
        genres: [...new Set(rows.map((b) => b.genre).filter(Boolean))].sort(),
        tags: [...new Set(rows.flatMap((b) => b.tags ?? []))].sort(),
        recommenders: [...new Set(rows.map((b) => b.recommended_by).filter(Boolean))].sort(),
        settings: {
          libby_key: settings?.settings?.libby_key ?? null,
          audible_subscriber: !!settings?.settings?.audible_subscriber,
          note: "Libby settings are account-wide, not per library.",
        },
        share_url: `https://audiolib.io/share/${profile.id}`,
      };
    },
  },

  {
    name: "list_books",
    write: false,
    description: "Query the library. Every filter is optional and they combine. Use this instead of asking for the whole library — it pages.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string", enum: STATUSES } },
        loved: { type: "boolean" },
        genre: { type: "string" }, subgenre: { type: "string" }, tag: { type: "string" },
        author: { type: "string", description: "Substring, case-insensitive." },
        narrator: { type: "string", description: "Substring, case-insensitive." },
        search: { type: "string", description: "Free text over title, author, narrator and tags." },
        min_rating: { type: "number", minimum: 0, maximum: 5 },
        min_crowd_rating: { type: "number", minimum: 0, maximum: 5 },
        queued: { type: "boolean", description: "Only books on the Up Next queue." },
        has_hold: { type: "boolean", description: "Only books with a recorded Libby hold." },
        libby_state: { type: "string", enum: ["available", "wait", "absent"] },
        series_id: { type: "string", description: "Only volumes of this series header." },
        finished_year: { type: "integer" },
        fields: { type: "string", enum: ["summary", "full"], description: "Default 'summary'." },
        sort: { type: "string", enum: ["status", "rating", "crowd", "recent", "title", "author", "duration"] },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
        offset: { type: "integer", minimum: 0 },
      },
    },
    async handler(scope, args) {
      const rows = await loadAllBooks(scope);
      const norm = (s) => (s ?? "").toLowerCase();
      let out = rows;

      if (args.series_id) out = out.filter((b) => b.parent_id === assertUuid(args.series_id, "series id"));
      if (args.status?.length) out = out.filter((b) => args.status.includes(b.status));
      if (args.loved != null) out = out.filter((b) => !!b.loved === args.loved);
      if (args.genre) out = out.filter((b) => norm(b.genre) === norm(args.genre));
      if (args.subgenre) out = out.filter((b) => norm(b.subgenre) === norm(args.subgenre));
      if (args.tag) out = out.filter((b) => (b.tags ?? []).some((t) => norm(t) === norm(args.tag)));
      if (args.author) out = out.filter((b) => norm(b.author).includes(norm(args.author)));
      if (args.narrator) out = out.filter((b) => norm(b.narrator).includes(norm(args.narrator)));
      if (args.min_rating != null) out = out.filter((b) => Number(b.rating) >= args.min_rating);
      if (args.min_crowd_rating != null) out = out.filter((b) => Number(b.goodreads_rating) >= args.min_crowd_rating);
      if (args.queued != null) out = out.filter((b) => (b.queue_position != null) === args.queued);
      if (args.has_hold != null) out = out.filter((b) => (holdWeeksLeft(b) != null) === args.has_hold);
      if (args.libby_state) out = out.filter((b) => b.libby_state === args.libby_state);
      if (args.finished_year != null) {
        out = out.filter((b) => b.date_finished && Number(b.date_finished.slice(0, 4)) === args.finished_year);
      }
      if (args.search) {
        const q = norm(args.search);
        out = out.filter((b) =>
          norm(b.title).includes(q) || norm(b.author).includes(q) ||
          norm(b.narrator).includes(q) || (b.tags ?? []).some((t) => norm(t).includes(q)));
      }

      const cmp = {
        rating: (a, b) => Number(b.rating || 0) - Number(a.rating || 0),
        crowd: (a, b) => Number(b.goodreads_rating || 0) - Number(a.goodreads_rating || 0),
        recent: (a, b) => (a.created_at < b.created_at ? 1 : -1),
        title: (a, b) => (a.title ?? "").localeCompare(b.title ?? ""),
        author: (a, b) => (a.author ?? "").localeCompare(b.author ?? ""),
        duration: (a, b) => (b.duration_minutes || 0) - (a.duration_minutes || 0),
        status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status),
      }[args.sort];
      if (cmp) out = [...out].sort(cmp);

      const total = out.length;
      const limit = Math.min(args.limit ?? 50, 200);
      const offset = args.offset ?? 0;
      const page = out.slice(offset, offset + limit);
      const full = args.fields === "full";
      const items = page.map((b) =>
        full
          ? { ...b, description: trimDescription(b.description), hold_weeks_left: holdWeeksLeft(b) }
          : summarise(b));
      return envelope(items, { total, limit, offset });
    },
  },

  {
    name: "get_book",
    write: false,
    description: "One book in full, with its series siblings and re-listen history. Give book_id, or title for a fuzzy match.",
    inputSchema: {
      type: "object",
      properties: { book_id: { type: "string" }, title: { type: "string" } },
    },
    async handler(scope, args) {
      let book;
      if (args.book_id) {
        book = await scope.getBook(args.book_id);
      } else if (args.title) {
        const rows = await loadAllBooks(scope);
        const hits = rows.filter((b) => sameTitle(b.title, args.title));
        if (!hits.length) throw new McpScopeError(`No book matching "${args.title}" in this library`);
        if (hits.length > 1) {
          return { ambiguous: true, candidates: hits.map(summarise), next_step: "Ask which one, then call get_book with its book_id." };
        }
        book = hits[0];
      } else {
        throw new McpScopeError("Give either book_id or title");
      }

      const [reads, siblings] = await Promise.all([
        scope.listReads(book.id).catch(() => []),
        book.parent_id || book.is_series
          ? loadAllBooks(scope, { order: "series_position" })
          : Promise.resolve([]),
      ]);
      const seriesId = book.is_series ? book.id : book.parent_id;
      return {
        ...book,
        description: trimDescription(book.description),
        hold_weeks_left: holdWeeksLeft(book),
        series: seriesId
          ? { id: seriesId, volumes: siblings.filter((b) => b.parent_id === seriesId).map(summarise) }
          : null,
        reads,
      };
    },
  },

  {
    name: "list_series",
    write: false,
    description: "Series in the library with their volumes, derived status and rating, and any gaps in volume numbering (so you can spot a missing #3 without a catalogue call).",
    inputSchema: {
      type: "object",
      properties: {
        include_volumes: { type: "boolean", description: "Default true." },
        limit: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 },
      },
    },
    async handler(scope, args) {
      const rows = await loadAllBooks(scope);
      const headers = nest(rows).filter((b) => b.is_series);
      const total = headers.length;
      const limit = Math.min(args.limit ?? 50, 200);
      const offset = args.offset ?? 0;
      const items = headers.slice(offset, offset + limit).map((h) => {
        const vols = h.books ?? [];
        const positions = vols.map((v) => Number(v.series_position)).filter(Number.isFinite);
        const max = positions.length ? Math.max(...positions) : 0;
        const gaps = [];
        for (let i = 1; i < max; i++) if (!positions.includes(i)) gaps.push(i);
        return {
          id: h.id, title: h.title, author: h.author, genre: h.genre, subgenre: h.subgenre,
          derived_status: getStatus(h), derived_rating: calcSeriesRating(h),
          volume_count: vols.length, position_gaps: gaps,
          ...(args.include_volumes === false ? {} : { volumes: vols.map(summarise) }),
        };
      });
      return envelope(items, { total, limit, offset });
    },
  },

  {
    name: "get_up_next",
    write: false,
    description: "The Up Next queue, in order.",
    inputSchema: { type: "object", properties: {} },
    async handler(scope) {
      const rows = await scope.selectBooks("queue_position=not.is.null", { order: "queue_position" });
      return { queue: rows.map(summarise) };
    },
  },

  {
    name: "get_stats",
    write: false,
    description: "Listening statistics: hours, books finished, top authors/narrators/genres, rating distribution, how their ratings compare to the crowd, hidden gems, re-listens and DNFs.",
    inputSchema: { type: "object", properties: { year: { type: "integer" } } },
    async handler(scope, args) {
      const rows = await loadAllBooks(scope);
      const flat = rows.filter((b) => !b.is_series);
      const year = args.year ?? new Date().getFullYear();
      const s = computeStats(flat, year);
      return {
        year,
        years_with_activity: listeningYears(nest(rows)),
        finished_ever: s.finishedEver, finished_this_year: s.finishedThisYear,
        hours_ever: Math.round(s.minutesEver / 60), hours_this_year: Math.round(s.minutesYear / 60),
        average_rating: s.avg,
        top_authors: s.topAuthors, top_narrators: s.topNarrators, top_genres: s.topGenres,
        rating_distribution: Object.fromEntries([...s.dist.entries()].sort((a, b) => a[0] - b[0])),
        longest: s.longest ? { title: s.longest.title, duration: fmtDuration(s.longest.duration_minutes) } : null,
        dnf_count: s.dnf, rereads: s.rereads,
        crowd: s.crowd ? { ...s.crowd, spiciest: s.crowd.spiciest ? summarise(s.crowd.spiciest) : null } : null,
        hidden_gems: s.gems.map(summarise), contrarian_authors: s.contrarians,
      };
    },
  },

  {
    name: "search_catalog",
    write: false,
    description:
      "Look a book up in Audible's catalogue. Use this to verify that every book you are about to recommend actually exists, " +
      "and to get its real narrator, runtime, cover and crowd rating. Results carry an Audible link, a Libby link, and an " +
      "in_library flag so you never pitch something the listener already owns.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Title, ideally with the author." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 8." },
      },
    },
    async handler(scope, args) {
      const [{ source, results }, settings, tag, rows] = await Promise.all([
        searchBooks(args.query, Math.min(args.limit ?? 8, 20)),
        scope.getSettings(), scope.getAffiliateTag(),
        loadAllBooks(scope),
      ]);
      const libbyKey = settings?.settings?.libby_key ?? null;
      const owned = new Set(rows.map((b) => titleKey(b.title)).filter(Boolean));
      return ok({
        source,
        results: (results ?? []).map((r) => ({
          ...r,
          description: trimDescription(r.description),
          audible_url: audibleSearchUrl(r, tag),
          libby_url: libbySearchUrl(r, libbyKey),
          in_library: owned.has(titleKey(r.title)),
        })),
      }, "Call check_availability on the ones you intend to present, then show each with its links.");
    },
  },

  {
    name: "get_series_volumes",
    write: false,
    description: "Every volume of a series from Audible's catalogue, in order. Needs the series ASIN from a search_catalog result.",
    inputSchema: {
      type: "object", required: ["series_asin"],
      properties: { series_asin: { type: "string" } },
    },
    async handler(_scope, args) {
      return seriesVolumes(args.series_asin);
    },
  },

  {
    name: "check_availability",
    write: false,
    description:
      "Whether the listener's library lends these audiobooks on Libby, and how long the wait is. Call this on every book you " +
      "are about to recommend. If no library code is set it returns needs:'library_key' — ask the listener which library they " +
      "borrow from, call set_libby_key, and try again. Anything with a wait: ask whether they placed a hold, and record it with set_hold.",
    inputSchema: {
      type: "object", required: ["books"],
      properties: {
        books: {
          type: "array", maxItems: MAX_AVAILABILITY_BATCH,
          items: {
            type: "object", required: ["title"],
            properties: {
              title: { type: "string" }, author: { type: "string" },
              book_id: { type: "string", description: "If this book is already in the library, pass its id to cache the result." },
            },
          },
        },
        library_key: { type: "string", description: "Check one specific library without saving it as the default." },
      },
    },
    async handler(scope, args) {
      const settings = await scope.getSettings();
      const saved = settings?.settings?.libby_key ?? null;
      const key = args.library_key || saved;
      const tag = await scope.getAffiliateTag();

      if (!key) {
        return {
          needs: "library_key",
          next_step:
            "Ask the listener which library they borrow from, then call set_libby_key with its Libby code " +
            "(the slug in their libbyapp.com URL, e.g. 'lapl') and call this again. If they don't use Libby, " +
            "present the Audible links on their own.",
          results: (args.books ?? []).map((b) => ({
            title: b.title, author: b.author ?? null,
            audible_url: audibleSearchUrl(b, tag), libby_url: libbySearchUrl(b, null),
          })),
        };
      }

      const books = (args.books ?? []).slice(0, MAX_AVAILABILITY_BATCH);
      // Sequentially, 20 OverDrive round trips would blow the function's 30s
      // budget. Three at a time is what the app's own background refresh uses.
      const results = new Array(books.length);
      let anyWait = false;
      let cursor = 0;
      const worker = async () => {
        while (cursor < books.length) {
          const i = cursor++;
          const b = books[i];
          let avail = null;
          try { avail = await libbyAvailability(key, b.title, b.author); }
          catch { /* best-effort per book; a dead upstream shouldn't fail the batch */ }
          const state = toLibbyState(avail);
          if (state.libby_state === "wait") anyWait = true;
          results[i] = {
            title: b.title, author: b.author ?? null,
            owned: !!avail?.owned, available: !!avail?.available,
            wait_days: avail?.waitDays ?? null, holds: avail?.holds ?? 0, copies: avail?.copies ?? 0,
            libby_state: state.libby_state,
            audible_url: audibleSearchUrl(b, tag),
            libby_url: libbySearchUrl(b, key),
          };
          // Warm the same 24h cache the app's background refresh writes, so the
          // UI shows what the assistant just looked up.
          if (b.book_id && scope.canWrite) {
            await scope.patchBook(b.book_id, { ...state, libby_checked_at: new Date().toISOString() })
              .catch(() => {});
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return ok({ library_key: key, results }, anyWait
        ? "Present each with its links and wait. For anything with a wait, ask whether they placed a hold — if they did, call set_hold (adding the book first if it isn't in the library)."
        : "Present each with its Audible and Libby links.");
    },
  },

  {
    name: "add_books",
    write: true,
    description: "Add books to the library. Only when the listener asks for something to be added — recommendations stay in the conversation until they say so. Set enrich to fill missing narrator/runtime/cover/year from Audible.",
    inputSchema: {
      type: "object", required: ["books"],
      properties: {
        books: {
          type: "array", minItems: 1, maxItems: MAX_BULK,
          items: { type: "object", required: ["title"], properties: { ...BOOK_PROPS, series_id: { type: "string", description: "Attach as a volume of this series header." } } },
        },
        enrich: { type: "boolean", description: "Look each one up in Audible and fill missing metadata. Default false." },
        today: { type: "string", description: "The listener's local date, YYYY-MM-DD. Status changes auto-set listening dates from it; defaults to UTC." },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const todayStr = resolveToday(args);
      const rows = [];
      for (const b of args.books.slice(0, MAX_BULK)) {
        rows.push(await shapeBook(scope, b, { seriesId: b.series_id, todayStr, enrich: args.enrich }));
      }
      const created = await scope.insertBooks(rows);
      return { created: created.length, books: created.map(summarise) };
    },
  },

  {
    name: "update_books",
    write: true,
    description: "Change books already in the library — status, rating, loved, tags, notes, progress, dates, queue position. Status changes auto-set listening dates.",
    inputSchema: {
      type: "object", required: ["updates"],
      properties: {
        updates: {
          type: "array", minItems: 1, maxItems: MAX_BULK,
          items: {
            type: "object", required: ["book_id", "patch"],
            properties: { book_id: { type: "string" }, patch: { type: "object", properties: BOOK_PROPS } },
          },
        },
        today: { type: "string", description: "The listener's local date, YYYY-MM-DD." },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const todayStr = resolveToday(args);
      const updated = [];
      for (const u of args.updates.slice(0, MAX_BULK)) {
        const prev = await scope.getBook(u.book_id);
        const patch = cleanBookFields(withAutoDates(u.patch ?? {}, prev, todayStr));
        updated.push(await scope.patchBook(u.book_id, patch));
      }
      return { updated: updated.length, books: updated.map(summarise) };
    },
  },

  {
    name: "delete_book",
    write: true,
    description: "Remove a book from the library. Deleting a series header also removes its volumes — say how many when you report back.",
    inputSchema: {
      type: "object", required: ["book_id"], properties: { book_id: { type: "string" } },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const book = await scope.getBook(args.book_id);
      const volumes = book.is_series
        ? (await loadAllBooks(scope, { order: "series_position" })).filter((b) => b.parent_id === book.id).length
        : 0;
      await scope.deleteBook(book.id);
      return { deleted: book.title, volumes_also_deleted: volumes };
    },
  },

  {
    name: "create_series",
    write: true,
    description: "Create a series header with its volumes. The header carries no rating or status of its own — both are derived from the volumes.",
    inputSchema: {
      type: "object", required: ["title"],
      properties: {
        title: { type: "string" }, author: { type: "string" },
        genre: { type: "string" }, subgenre: { type: "string" },
        cover_url: { type: "string" }, loved: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        volumes: { type: "array", maxItems: MAX_BULK, items: { type: "object", required: ["title"], properties: BOOK_PROPS } },
        today: { type: "string" },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const todayStr = resolveToday(args);
      const [header] = await scope.insertBooks([
        cleanBookFields({
          title: args.title, author: args.author, genre: args.genre, subgenre: args.subgenre,
          cover_url: args.cover_url, loved: args.loved, tags: args.tags, is_series: true,
        }),
      ]);
      let volumes = [];
      if (args.volumes?.length) {
        const rows = [];
        for (const [i, v] of args.volumes.slice(0, MAX_BULK).entries()) {
          const shaped = await shapeBook(scope, v, { todayStr });
          rows.push({ ...shaped, parent_id: header.id, is_series: false, series_position: shaped.series_position ?? i + 1 });
        }
        volumes = await scope.insertBooks(rows);
      }
      return { series: summarise(header), volumes: volumes.map(summarise) };
    },
  },

  {
    name: "add_series_volumes",
    write: true,
    description: "Add volumes to an existing series. With fetch_missing, looks the series up in Audible and adds whatever volumes the library doesn't have yet, as 'want to listen'.",
    inputSchema: {
      type: "object", required: ["series_id"],
      properties: {
        series_id: { type: "string" },
        volumes: { type: "array", maxItems: MAX_BULK, items: { type: "object", required: ["title"], properties: BOOK_PROPS } },
        series_asin: { type: "string" },
        fetch_missing: { type: "boolean" },
        today: { type: "string" },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const todayStr = resolveToday(args);
      const header = await scope.getBook(args.series_id);
      if (!header.is_series) throw new McpScopeError("That book is not a series header");
      const existing = (await loadAllBooks(scope, { order: "series_position" })).filter((b) => b.parent_id === header.id);

      let incoming = args.volumes ?? [];
      let skipped = 0;
      if (args.fetch_missing) {
        let asin = args.series_asin;
        if (!asin) {
          const { results } = await searchBooks(`${header.title} ${header.author ?? ""}`.trim(), 5);
          asin = results?.find((r) => r.series?.asin)?.series?.asin;
        }
        if (!asin) throw new McpScopeError("Couldn't find that series in the catalogue — pass series_asin from a search_catalog result");
        const { volumes } = await seriesVolumes(asin);
        const haveTitles = new Set(existing.map((b) => titleKey(b.title)));
        const haveAsins = new Set(existing.map((b) => b.asin).filter(Boolean));
        const fresh = (volumes ?? []).filter((v) => !haveTitles.has(titleKey(v.title)) && !haveAsins.has(v.asin));
        skipped = (volumes ?? []).length - fresh.length;
        incoming = fresh.map((v) => ({
          title: v.title, author: v.author, narrator: v.narrator, year: v.year,
          duration_minutes: v.duration_minutes, cover_url: v.cover_url, asin: v.asin,
          description: trimDescription(v.description), series_position: v.position,
          genre: header.genre, subgenre: header.subgenre,
          goodreads_rating: v.public_rating?.average ?? null,
          status: "wanttoread", source: "audible",
        }));
      }

      if (!incoming.length) return { added: 0, skipped, volumes: [], note: "Nothing new to add — the library already has every volume." };
      const rows = [];
      for (const [i, v] of incoming.slice(0, MAX_BULK).entries()) {
        const shaped = await shapeBook(scope, v, { todayStr });
        rows.push({ ...shaped, parent_id: header.id, is_series: false, series_position: shaped.series_position ?? existing.length + i + 1 });
      }
      const added = await scope.insertBooks(rows);
      return { added: added.length, skipped, volumes: added.map(summarise) };
    },
  },

  {
    name: "set_up_next",
    write: true,
    description: "Set, extend or clear the Up Next queue. 'replace' makes the given order the whole queue; 'append' adds to the end; 'remove' takes these off it.",
    inputSchema: {
      type: "object", required: ["book_ids"],
      properties: {
        book_ids: { type: "array", items: { type: "string" }, maxItems: MAX_BULK },
        mode: { type: "string", enum: ["replace", "append", "remove"], description: "Default 'replace'." },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const mode = args.mode ?? "replace";
      const ids = args.book_ids.slice(0, MAX_BULK).map((id) => assertUuid(id, "book id"));
      for (const id of ids) await scope.getBook(id); // ownership before any write

      const current = (await scope.selectBooks("queue_position=not.is.null", { order: "queue_position" }));
      if (mode === "remove") {
        for (const id of ids) await scope.patchBook(id, { queue_position: null });
      } else if (mode === "replace") {
        for (const b of current) if (!ids.includes(b.id)) await scope.patchBook(b.id, { queue_position: null });
        for (const [i, id] of ids.entries()) await scope.patchBook(id, { queue_position: i + 1 });
      } else {
        let n = current.length ? Math.max(...current.map((b) => b.queue_position ?? 0)) : 0;
        for (const id of ids) if (!current.some((b) => b.id === id)) await scope.patchBook(id, { queue_position: ++n });
      }
      // PostgREST has no transactions, so return the real resulting order
      // rather than the order we intended — a partial run stays visible.
      const queue = await scope.selectBooks("queue_position=not.is.null", { order: "queue_position" });
      return { queue: queue.map(summarise) };
    },
  },

  {
    name: "set_hold",
    write: true,
    description:
      "Record that the listener placed a Libby hold, so it shows on their Holds tab and counts down. Call this whenever they say " +
      "they placed or joined a hold. Pass weeks: null to clear one. If the book isn't in the library yet, add it first.",
    inputSchema: {
      type: "object", required: ["book_id"],
      properties: {
        book_id: { type: "string" },
        weeks: { type: ["integer", "null"], minimum: 1, maximum: 104, description: "The wait Libby quoted, in weeks. null clears the hold." },
        hold_date: { type: "string", description: "When it was placed, YYYY-MM-DD. Defaults to today." },
        today: { type: "string" },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const book = await scope.getBook(args.book_id);
      if (args.weeks == null) {
        // hold_weeks and hold_date move together — the books_hold_pair check
        // rejects one without the other.
        const cleared = await scope.patchBook(book.id, { hold_weeks: null, hold_date: null });
        return { cleared: true, book: summarise(cleared) };
      }
      const patch = { hold_weeks: args.weeks, hold_date: args.hold_date || resolveToday(args) };
      // Mirrors saveHold in App.jsx: you don't place a hold on something you
      // haven't decided on, so a suggestion becomes a want.
      if (book.status === "recommended") patch.status = "wanttoread";
      const updated = await scope.patchBook(book.id, patch);
      return { book: summarise(updated), weeks_left: holdWeeksLeft(updated) };
    },
  },

  {
    name: "mark_borrowed",
    write: true,
    description:
      "The listener's Libby hold came through and they have the book. Clears the hold, marks it as being listened to now, " +
      "and puts it first in Up Next — a borrowed book has a due date, so it jumps the queue. Reach for this whenever they " +
      "say a hold arrived, that a book is ready, or that they just borrowed something.",
    inputSchema: {
      type: "object", required: ["book_id"],
      properties: {
        book_id: { type: "string" },
        today: { type: "string", description: "The listener's local date, YYYY-MM-DD." },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const book = await scope.getBook(args.book_id);
      const queued = await scope.selectBooks("queue_position=not.is.null", { order: "queue_position" });

      const updated = await scope.patchBook(book.id, {
        hold_weeks: null,
        hold_date: null,
        status: "reading",
        date_started: book.date_started || resolveToday(args),
        queue_position: 1,
      });
      // Renumber from 2 so the borrowed book owns the front. PostgREST has no
      // transaction here, so the queue is re-read below rather than assumed.
      let n = 2;
      for (const b of queued) {
        if (b.id === book.id) continue;
        await scope.patchBook(b.id, { queue_position: n++ });
      }
      const queue = await scope.selectBooks("queue_position=not.is.null", { order: "queue_position" });
      return ok(
        { book: summarise(updated), hold_cleared: true, queue: queue.map(summarise) },
        "It's now first in Up Next and marked as being listened to."
      );
    },
  },

  {
    name: "log_reread",
    write: true,
    description: "Record that the listener went through a book again. Increments their re-listen count (which is what the stats and listening hours use) and, if you give dates, files a dated entry too.",
    inputSchema: {
      type: "object", required: ["book_id"],
      properties: {
        book_id: { type: "string" },
        date_started: { type: "string", description: "YYYY-MM-DD" },
        date_finished: { type: "string", description: "YYYY-MM-DD" },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const book = await scope.getBook(args.book_id);
      const updated = await scope.patchBook(book.id, { reread_count: (book.reread_count ?? 0) + 1 });
      let logged = false;
      if (args.date_started || args.date_finished) {
        await scope.insertRead(book.id, {
          date_started: args.date_started ?? null,
          date_finished: args.date_finished ?? null,
        });
        logged = true;
      }
      return {
        book: summarise(updated), reread_count: updated.reread_count, dated_entry_logged: logged,
        listened_minutes: listenedMinutes(updated),
      };
    },
  },

  {
    name: "update_library",
    write: true,
    description: "Rename this library, or change its age group. The age group decides what is appropriate to recommend, so confirm before changing it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        age_group: { type: "string", enum: ["adult", "teens", "children"] },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const patch = {};
      if (args.name) patch.name = args.name;
      if (args.age_group) patch.age_group = args.age_group;
      if (!Object.keys(patch).length) throw new McpScopeError("Give a name or an age_group to change");
      return { library: await scope.patchProfile(patch) };
    },
  },

  {
    name: "set_libby_key",
    write: true,
    description:
      "Save which library the listener borrows from, so availability checks work. The code is the slug in their libbyapp.com " +
      "URL (e.g. 'lapl' for Los Angeles Public Library). Confirm it with them before saving — a wrong code reports every book as " +
      "not stocked, which looks like a real answer. NOTE: this setting is account-wide, not per library.",
    inputSchema: {
      type: "object",
      properties: {
        libby_key: { type: ["string", "null"], description: "The library slug, or null to clear it." },
      },
    },
    async handler(scope, args) {
      scope.assertWritable();
      const key = args.libby_key == null ? null : String(args.libby_key).trim().toLowerCase();
      await scope.mergeSettings({ libby_key: key || null });
      return ok(
        { libby_key: key || null, scope: "account-wide" },
        key ? "Now call check_availability again." : "Libby lookups are off until a code is set."
      );
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// The one string every client reads before it decides which tools to use, so it
// carries the design intent rather than a feature list.
export const SERVER_INSTRUCTIONS = [
  "This server is one person's audiobook library. It stores data and looks books up; it performs no AI inference of its own.",
  "",
  "FIRST USE IN A CONVERSATION: before doing anything else, introduce yourself with the text below,",
  "then carry on with what they asked. Say it ONCE per conversation and never repeat it — a second",
  "telling reads as though you have forgotten the first. Keep the meaning; the wording can flex to fit",
  "the moment.",
  "---",
  "Work with your audiobook library directly in this chat, so you don't have to click around the app.",
  "",
  "I know your taste. Ask me what you should listen to next and I'll read your actual shelf — your",
  "five-star books, the narrators you keep coming back to, what you abandoned and why — and recommend",
  "from that. I'll never suggest something you already own.",
  "",
  "I update your shelf as we talk. Tell me \"finished Project Hail Mary, five stars,\" or \"add the rest",
  "of that series,\" or \"put that one on hold, six weeks\" — and it all lands in the app.",
  "---",
  "",
  "When they ask what to listen to next, or for a recommendation, or for something like a book they loved:",
  "call get_taste_profile FIRST, reason from the block it returns yourself, verify every pick with search_catalog,",
  "then call check_availability and present each pick with its Audible and Libby links.",
  "Honour the AUDIENCE RULE that get_taste_profile returns — some of these libraries belong to children.",
  "Never recommend a book already on the owned list.",
  "",
  "Do not write recommendations into the library. Add a book only when the listener asks you to.",
  "If they say they placed a Libby hold, record it with set_hold so it counts down on their Holds tab.",
].join("\n");

// An MCP prompt is the deterministic version of the workflow above: the
// listener invokes it directly, so it does not depend on the model choosing to
// call get_taste_profile first.
export const PROMPTS = [
  {
    name: "recommend_from_my_library",
    description: "Ask for an audiobook recommendation grounded in this library's taste profile.",
    arguments: [
      { name: "mood", description: "What they're in the mood for. Optional.", required: false },
      { name: "count", description: "How many suggestions. Defaults to 5.", required: false },
    ],
    async build(scope, args = {}) {
      const [profile, rows] = await Promise.all([scope.getProfile(), loadAllBooks(scope)]);
      const block = renderTasteBlock(buildTasteProfile(profile, rows));
      const count = Number(args.count) > 0 ? Number(args.count) : 5;
      const mood = args.mood ? ` They're in the mood for: ${args.mood}.` : "";
      return {
        description: `Audiobook recommendations for ${profile.name}`,
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `${block}\n\n---\n\nUsing the profile above, suggest ${count} audiobooks I'd love.${mood} ` +
              `Ground each one in a specific book or author I already love and say which. Verify each with search_catalog, ` +
              `check availability with check_availability, and give me the Audible and Libby links.`,
          },
        }],
      };
    },
  },
];

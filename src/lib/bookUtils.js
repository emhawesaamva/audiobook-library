// Pure helpers over the in-memory book shape produced by db.loadBooks():
// top-level rows, with series headers carrying a `books` array of child rows.

export function getStatus(book) {
  if (!book.is_series || !book.books?.length) return book.status;
  const subs = book.books;
  if (subs.some((b) => b.status === "reading")) return "reading";
  if (subs.length && subs.every((b) => b.status === "read")) return "read";
  if (subs.some((b) => b.status === "wanttoread")) return "wanttoread";
  if (subs.some((b) => b.status === "recommended")) return "recommended";
  if (subs.some((b) => b.status === "dnf")) return "dnf";
  return book.status;
}

export function calcSeriesRating(book) {
  if (!book.is_series) return Number(book.rating) || 0;
  if (!book.books?.length) return 0;
  const rated = book.books.filter((b) => Number(b.rating) > 0);
  if (!rated.length) return 0;
  return Math.round((rated.reduce((s, b) => s + Number(b.rating), 0) / rated.length) * 10) / 10;
}

export const STATUS_LABEL = {
  read: "Read",
  reading: "Reading",
  wanttoread: "Want to Listen",
  recommended: "Recommended",
  dnf: "DNF",
};

export const STATUS_SHORT = {
  read: "READ",
  reading: "NOW",
  wanttoread: "WANT",
  recommended: "REC",
  dnf: "DNF",
};

// Genre taxonomy modeled on Audible's top-level categories (the source of our
// metadata) merged with Goodreads/StoryGraph conventions. Grouped for the
// form's select; GENRES stays a flat list for any code that needs one.
export const GENRE_GROUPS = {
  Fiction: [
    "Science Fiction", "Fantasy", "Horror", "Thriller", "Mystery", "Crime",
    "Romance", "Historical Fiction", "Literary Fiction", "Contemporary Fiction",
    "Classics", "Action & Adventure", "Comedy", "Westerns", "Short Stories",
    "Poetry & Drama",
  ],
  Nonfiction: [
    "Memoir", "Biography", "History", "True Crime", "Self-Help",
    "Business & Finance", "Science & Technology", "Health & Wellness",
    "Religion & Spirituality", "Politics & Society", "Sports & Outdoors",
    "Travel", "Arts & Entertainment",
  ],
  "Young Listeners": ["Young Adult", "Middle Grade", "Children"],
  "": ["Other"],
};

export const GENRES = Object.values(GENRE_GROUPS).flat();

export function fmtDuration(minutes) {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function fmtHours(minutes) {
  if (!minutes) return "0";
  return (minutes / 60).toFixed(minutes >= 600 ? 0 : 1);
}

// Total listening minutes represented by a top-level entry (series sum their
// finished children; standalone books count when read).
export function listenedMinutes(book, year = null) {
  const inYear = (b) =>
    !year || (b.date_finished && new Date(b.date_finished + "T00:00:00").getFullYear() === year);
  const rows = book.is_series ? (book.books ?? []) : [book];
  return rows
    .filter((b) => b.status === "read" && b.duration_minutes && inYear(b))
    .reduce((s, b) => s + b.duration_minutes * (1 + (b.reread_count || 0)), 0);
}

// Flatten an entry list into individual listenable rows (series expanded).
export function flattenBooks(books) {
  return books.flatMap((b) => (b.is_series ? (b.books ?? []) : [b]));
}

// Normalized key for "is this the same book?" title comparisons: lowercase,
// subtitle (after a colon) dropped, punctuation stripped, leading article gone.
export function titleKey(t) {
  return (t ?? "")
    .toLowerCase()
    .split(":")[0]
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/^(the|a|an) /, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sameTitle(a, b) {
  const ka = titleKey(a), kb = titleKey(b);
  if (!ka || !kb) return false;
  return ka === kb ||
    (ka.length >= 8 && kb.startsWith(ka)) ||
    (kb.length >= 8 && ka.startsWith(kb));
}

export function audibleSearchUrl(book, affiliateTag = null) {
  const q = encodeURIComponent(`${book.title} ${book.author ?? ""}`.trim()).replace(/%20/g, "+");
  const url = `https://www.audible.com/search?keywords=${q}`;
  return affiliateTag ? `${url}&tag=${affiliateTag}` : url;
}

// Libby search deep link. With a library code (the slug from the user's
// libbyapp.com URL, e.g. "lapl") it searches their library directly;
// otherwise it falls back to OverDrive's universal catalog search.
export function libbySearchUrl(book, libraryKey) {
  const q = encodeURIComponent(`${book.title} ${book.author ?? ""}`.trim());
  return libraryKey
    ? `https://libbyapp.com/search/${encodeURIComponent(libraryKey)}/search/scope-auto/audiobooks/query-${q}/language-en/page-1`
    : `https://www.overdrive.com/search?q=${q}`;
}

// ---- library holds ----
// A hold is an indicator, not a status: hold_weeks (the wait Libby quoted) plus
// hold_date (when it was recorded). Remaining wait counts down from there, so a
// 10-week hold placed 2 weeks ago reads 8 weeks. Both columns move together —
// either missing means no hold.
export function hasHold(book) {
  return !!(book?.hold_date && Number(book?.hold_weeks) > 0);
}

// Whole weeks left before the quoted wait elapses. 0 means the estimate has
// run out (the book may be ready); the hold is kept until the user clears it.
export function holdWeeksLeft(book) {
  if (!hasHold(book)) return null;
  // Parse as local midnight — "2026-08-16" alone parses as UTC and can land on
  // the previous day west of Greenwich, shifting every countdown by a day.
  const ready = new Date(`${book.hold_date}T00:00:00`);
  ready.setDate(ready.getDate() + Number(book.hold_weeks) * 7);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((ready - today) / 86_400_000);
  return days <= 0 ? 0 : Math.ceil(days / 7);
}

// Section heading for the Holds tab. Expired holds group first under wording
// that stays honest about the estimate: Libby's quote is a guess, not a promise.
export function holdGroupLabel(weeksLeft) {
  if (weeksLeft === 0) return "These may be ready now";
  return weeksLeft === 1 ? "1 week" : `${weeksLeft} weeks`;
}

export function goodreadsSearchUrl(book) {
  return book.goodreads_url ||
    `https://www.goodreads.com/search?q=${encodeURIComponent(`${book.title} ${book.author ?? ""}`.trim())}`;
}

// Deterministic tinted placeholder for books without covers.
const PLACEHOLDER_HUES = [18, 42, 88, 152, 200, 230, 268, 312, 350];
export function placeholderHue(title) {
  let h = 0;
  for (const c of title ?? "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PLACEHOLDER_HUES[h % PLACEHOLDER_HUES.length];
}

// ---- write-path shaping (used by db.js before every insert/update) ----

const BOOK_COLUMNS = new Set([
  "profile_id", "parent_id", "is_series", "title", "author", "genre", "subgenre",
  "status", "rating", "loved", "notes", "year", "goodreads_rating", "goodreads_url",
  "cover_url", "narrator", "duration_minutes", "description", "date_started",
  "date_finished", "isbn", "asin", "series_position", "progress_percent",
  "dnf_reason", "recommended_by", "queue_position", "reread_count", "tags",
  "hold_weeks", "hold_date",
  "libby_state", "libby_wait_days", "libby_checked_at",
  "source",
]);

export function cleanBookFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (BOOK_COLUMNS.has(k)) out[k] = v === "" ? null : v;
  }
  // Series headers keep rating/status NULL (derived from children).
  if (out.is_series) { out.rating = null; out.status = null; }
  if (out.rating != null && !(Number(out.rating) > 0)) out.rating = null;
  return out;
}

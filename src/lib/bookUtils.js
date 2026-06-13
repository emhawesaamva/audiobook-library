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
  reading: "Listening",
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
    ? `https://libbyapp.com/search/${encodeURIComponent(libraryKey)}/search/scope-auto/query-${q}/page-1`
    : `https://www.overdrive.com/search?q=${q}`;
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

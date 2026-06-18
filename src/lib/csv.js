// CSV parsing/serialization: Goodreads library import and our own export.

// Minimal RFC-4180 parser (handles quoted fields, escaped quotes, CRLF).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Goodreads CSV -> array of book-field objects.
// Notable: ISBNs arrive Excel-escaped as ="9780765326355"; "Exclusive Shelf"
// holds read/currently-reading/to-read; ratings are whole stars 0-5.
export function parseGoodreadsCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { books: [], errors: ["Empty file"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());
  const iTitle = col("Title"), iAuthor = col("Author"), iRating = col("My Rating"),
    iShelf = col("Exclusive Shelf"), iIsbn13 = col("ISBN13"), iIsbn = col("ISBN"),
    iDateRead = col("Date Read"), iYear = col("Original Publication Year"),
    iAvg = col("Average Rating"), iReview = col("My Review"), iReadCount = col("Read Count");
  if (iTitle === -1 || iAuthor === -1)
    return { books: [], errors: ["Not a Goodreads export: missing Title/Author columns"] };

  const cleanIsbn = (v) => (v ?? "").replace(/[="]/g, "").trim() || null;
  const shelfStatus = { read: "read", "currently-reading": "reading", "to-read": "wanttoread" };

  const books = [];
  const errors = [];
  for (const r of rows.slice(1)) {
    const title = (r[iTitle] ?? "").trim();
    if (!title) continue;
    try {
      const shelf = (r[iShelf] ?? "").trim();
      const rating = Number(r[iRating]) || 0;
      const dateRead = (r[iDateRead] ?? "").trim();
      books.push({
        title: title.replace(/\s*\(.*?#\d+(\.\d+)?\)\s*$/, ""), // strip "(Series, #1)"
        author: (r[iAuthor] ?? "").trim() || null,
        rating: rating > 0 ? rating : null,
        status: shelfStatus[shelf] ?? "wanttoread",
        isbn: cleanIsbn(r[iIsbn13]) ?? cleanIsbn(r[iIsbn]),
        date_finished: /^\d{4}\/\d{2}\/\d{2}$/.test(dateRead) ? dateRead.replaceAll("/", "-") : null,
        year: Number(r[iYear]) || null,
        goodreads_rating: Number(r[iAvg]) || null,
        notes: (r[iReview] ?? "").trim() || null,
        reread_count: Math.max(0, (Number(r[iReadCount]) || 1) - 1),
      });
    } catch (e) {
      errors.push(`Row "${title}": ${e.message}`);
    }
  }
  return { books, errors };
}

// ---- Libby timeline import ----
// CSV header (verified against real exports; order varies — parse by name):
// cover,title,author,publisher,isbn,timestamp,activity,details,library
// The JSON variant (share.libbyapp.com export) adds cover.format, letting us
// skip ebooks/magazines. Borrowed -> Read (start = borrow, finish = return);
// titles only ever placed on hold -> Want to Listen.

function libbyEventsToBooks(events) {
  const byBook = new Map();
  for (const e of events) {
    if (!e.title) continue;
    const key = `${e.title.toLowerCase()}|${(e.author ?? "").toLowerCase()}`;
    if (!byBook.has(key)) {
      byBook.set(key, { title: e.title, author: e.author || null, isbn: e.isbn || null, borrows: [], returns: [], holds: 0 });
    }
    const b = byBook.get(key);
    const act = (e.activity ?? "").toLowerCase();
    if (act === "borrowed") b.borrows.push(e.when);
    else if (act === "returned") b.returns.push(e.when);
    else if (act.startsWith("placed")) b.holds++;
    if (!b.isbn && e.isbn) b.isbn = e.isbn;
  }
  const iso = (d) => (d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);
  const books = [];
  for (const b of byBook.values()) {
    if (b.borrows.length) {
      const started = new Date(Math.min(...b.borrows.map((d) => d.getTime())));
      const finished = b.returns.length ? new Date(Math.max(...b.returns.map((d) => d.getTime()))) : null;
      books.push({
        title: b.title, author: b.author, isbn: b.isbn, status: "read",
        date_started: iso(started), date_finished: finished ? iso(finished) : null,
        reread_count: Math.max(0, b.borrows.length - 1),
        recommended_by: null, notes: null,
      });
    } else if (b.holds) {
      books.push({ title: b.title, author: b.author, isbn: b.isbn, status: "wanttoread" });
    }
  }
  return books;
}

export function parseLibbyCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { books: [], errors: ["Empty file"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iTitle = col("title"), iAuthor = col("author"), iIsbn = col("isbn"),
    iWhen = col("timestamp"), iAct = col("activity");
  if (iTitle === -1 || iAct === -1 || iWhen === -1)
    return { books: [], errors: ["Not a Libby export: missing title/activity/timestamp columns"] };
  const events = rows.slice(1).map((r) => ({
    title: (r[iTitle] ?? "").trim(),
    author: (r[iAuthor] ?? "").trim(),
    isbn: (r[iIsbn] ?? "").replace(/[="]/g, "").trim(),
    activity: (r[iAct] ?? "").trim(),
    when: new Date((r[iWhen] ?? "").trim()), // "August 27, 2023 11:46"
  }));
  return { books: libbyEventsToBooks(events), errors: [] };
}

export function parseLibbyJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { books: [], errors: ["Invalid JSON file"] }; }
  const timeline = data.timeline ?? [];
  if (!Array.isArray(timeline) || !timeline.length)
    return { books: [], errors: ["No timeline entries found in JSON"] };
  let skipped = 0;
  const events = [];
  for (const t of timeline) {
    const format = t.cover?.format;
    if (format && format !== "audiobook") { skipped++; continue; }
    events.push({
      title: t.title?.text ?? t.title ?? "",
      author: t.author ?? "",
      isbn: t.isbn ?? "",
      activity: t.activity ?? "",
      when: new Date(t.timestamp),
    });
  }
  const books = libbyEventsToBooks(events);
  return { books, errors: [], note: skipped ? `${skipped} non-audiobook entries skipped` : null };
}

// ---- Audible Library Extractor JSON import ----
// Accepts the JSON exported by the "Audible Library Extractor" browser
// extension (github.com/joonaspaakko/audible-library-extractor).
// Top-level shape: { books: [...], series: [...], collections: [...], ... }

function parseAudibleLength(str) {
  if (!str) return null;
  const h = Number(str.match(/(\d+)\s*h(?:r|rs)?/i)?.[1] ?? 0);
  const m = Number(str.match(/(\d+)\s*m(?:in|ins)?/i)?.[1] ?? 0);
  const total = h * 60 + m;
  return total > 0 ? total : null;
}

export function parseAudibleJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { books: [], errors: ["Invalid JSON file"] }; }

  const items = data.books ?? [];
  if (!Array.isArray(items) || !items.length)
    return { books: [], errors: ["No books found in Audible export — make sure this is an Audible Library Extractor JSON file"] };

  const books = [];
  const errors = [];

  for (const item of items) {
    const title = (item.titleShort ?? item.title ?? "").trim();
    if (!title) continue;
    try {
      const author = (item.authors ?? []).map((a) => a.name).filter(Boolean).join(", ") || null;
      const narrator = (item.narrators ?? []).map((n) => n.name).filter(Boolean).join(", ") || null;
      const duration_minutes = parseAudibleLength(item.length);
      const progress = item.progress ?? 0;
      const status = progress >= 100 ? "read" : progress > 0 ? "reading" : "wanttoread";
      const seriesInfo = item.series?.[0] ?? null;
      const series_title = seriesInfo?.name ?? null;
      const rawPos = seriesInfo?.bookNumbers?.[0];
      const series_position = rawPos != null ? parseFloat(rawPos) : null;
      const cover_url = item.cover ? `https://m.media-amazon.com/images/I/${item.cover}._SL500_.jpg` : null;
      const year = item.releaseDate ? new Date(item.releaseDate + "T00:00:00").getFullYear() : null;
      const genre = item.categories?.[0]?.name ?? null;

      books.push({
        title,
        author,
        narrator,
        duration_minutes,
        status,
        series_title,
        series_position: isNaN(series_position) ? null : series_position,
        cover_url,
        year,
        genre,
        goodreads_rating: Number(item.rating) > 0 ? Number(item.rating) : null,
        rating: Number(item.myRating) > 0 ? Number(item.myRating) : null,
        asin: item.asin ?? null,
        loved: item.favorite === true,
        progress_percent: progress > 0 && progress < 100 ? progress : null,
      });
    } catch (e) {
      errors.push(`"${title}": ${e.message}`);
    }
  }

  const wishlistCount = data.wishlist?.length ?? 0;
  const note = wishlistCount
    ? `${items.length} library books imported (${wishlistCount} wishlist items not included)`
    : null;
  return { books, errors, note };
}

// ---- Audible Library Extractor "Raw data" CSV import ----
// Columns (verbatim, order varies — parsed by name) produced by the extension's
// CSV export "Raw data" format: Added, Title, Title Short, Series, Book Numbers,
// Blurb, Authors, Narrators, Tags, Categories, Parent Category, Child Category,
// Length, Progress, Release Date, Publishers, My Rating, Rating, Ratings,
// Favorite, Format, Language, ..., ASIN, ISBN10, ISBN13, Cover, ...
// Distinguished from a Goodreads CSV (which also has "My Rating") by "Narrators".
export function parseAudibleCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { books: [], errors: ["Empty file"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());
  const iTitle = col("Title"), iTitleShort = col("Title Short");
  if (iTitle === -1 && iTitleShort === -1)
    return { books: [], errors: ["Not an Audible Library Extractor CSV: missing Title column"] };

  const iSeries = col("Series"), iBookNums = col("Book Numbers"),
    iAuthors = col("Authors"), iNarrators = col("Narrators"),
    iCategories = col("Categories"), iParentCat = col("Parent Category"),
    iLength = col("Length"), iProgress = col("Progress"), iRelease = col("Release Date"),
    iMyRating = col("My Rating"), iRating = col("Rating"), iAsin = col("ASIN"),
    iIsbn13 = col("ISBN13"), iIsbn10 = col("ISBN10"), iCover = col("Cover"), iFav = col("Favorite");

  const cell = (r, i) => (i === -1 ? "" : (r[i] ?? "").trim());

  const books = [];
  const errors = [];
  for (const r of rows.slice(1)) {
    const title = cell(r, iTitleShort) || cell(r, iTitle);
    if (!title) continue;
    try {
      const progress = Number(cell(r, iProgress).replace(/[^0-9.]/g, "")) || 0;
      const status = progress >= 100 ? "read" : progress > 0 ? "reading" : "wanttoread";
      const seriesRaw = cell(r, iSeries);
      const series_title = seriesRaw ? (seriesRaw.match(/^(.*?)\s*\(book/i)?.[1] ?? seriesRaw).trim() || null : null;
      const series_position = parseFloat(cell(r, iBookNums)); // "1" or "1, 2" -> 1; "∞" -> NaN
      const release = cell(r, iRelease);
      const fav = cell(r, iFav);

      books.push({
        title,
        author: cell(r, iAuthors) || null,
        narrator: cell(r, iNarrators) || null,
        duration_minutes: parseAudibleLength(cell(r, iLength)),
        status,
        series_title,
        series_position: isNaN(series_position) ? null : series_position,
        cover_url: cell(r, iCover) || null,
        year: /^\d{4}/.test(release) ? Number(release.slice(0, 4)) : null,
        genre: cell(r, iParentCat) || cell(r, iCategories).split(">")[0].trim() || null,
        goodreads_rating: Number(cell(r, iRating)) > 0 ? Number(cell(r, iRating)) : null,
        rating: Number(cell(r, iMyRating)) > 0 ? Number(cell(r, iMyRating)) : null,
        asin: cell(r, iAsin) || null,
        isbn: cell(r, iIsbn13) || cell(r, iIsbn10) || null,
        loved: /^(true|yes|1|x|✓)$/i.test(fav),
        progress_percent: progress > 0 && progress < 100 ? progress : null,
      });
    } catch (e) {
      errors.push(`"${title}": ${e.message}`);
    }
  }
  return { books, errors, note: null };
}

// ---- StoryGraph CSV import ----
// StoryGraph export: Title, Authors, Contributors, ISBN/UID, Format, Read Status,
// Date Added, Last Date Read, Dates Read, Read Count, Moods, Pace, ...,
// Star Rating, Review, Content Warnings, Content Warning Description, Tags, Owned?
// ISBN/UID may be an ASIN (B0XXXXXXXXX) or a real ISBN.
export function parseStorygraphCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { books: [], errors: ["Empty file"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());

  const iTitle = col("title"), iAuthors = col("authors"), iIsbn = col("isbn/uid"),
    iStatus = col("read status"), iLastRead = col("last date read"),
    iDatesRead = col("dates read"), iReadCount = col("read count"),
    iMoods = col("moods"), iTags = col("tags"),
    iRating = col("star rating"), iReview = col("review");

  if (iTitle === -1 || iStatus === -1)
    return { books: [], errors: ["Not a StoryGraph export: missing Title/Read Status columns"] };

  const statusMap = { "read": "read", "currently-reading": "reading", "to-read": "wanttoread", "did-not-finish": "dnf" };
  const cell = (r, i) => (i === -1 ? "" : (r[i] ?? "").trim());
  const parseDate = (v) => /^\d{4}\/\d{2}\/\d{2}$/.test(v) ? v.replaceAll("/", "-") : null;
  const isAsin = (v) => /^B[0-9A-Z]{9}$/.test(v);

  const books = [];
  const errors = [];
  for (const r of rows.slice(1)) {
    const title = cell(r, iTitle);
    if (!title) continue;
    try {
      const statusRaw = cell(r, iStatus);
      const uidRaw = cell(r, iIsbn);
      const lastRead = parseDate(cell(r, iLastRead));
      const datesRead = cell(r, iDatesRead).split(",").map((d) => d.trim()).filter(Boolean);
      const date_finished = lastRead ?? (datesRead.length ? parseDate(datesRead[datesRead.length - 1]) : null);
      const readCount = Number(cell(r, iReadCount)) || 0;
      const rating = Number(cell(r, iRating)) > 0 ? Number(cell(r, iRating)) : null;
      const tagsRaw = cell(r, iTags).split(",").map((t) => t.trim()).filter(Boolean);
      const moodsRaw = cell(r, iMoods).split(",").map((m) => m.trim()).filter(Boolean);
      const allTags = [...tagsRaw, ...moodsRaw];

      books.push({
        title,
        author: cell(r, iAuthors) || null,
        isbn: !isAsin(uidRaw) && uidRaw ? uidRaw : null,
        asin: isAsin(uidRaw) ? uidRaw : null,
        status: statusMap[statusRaw] ?? "wanttoread",
        date_finished,
        reread_count: Math.max(0, readCount - 1),
        rating,
        notes: cell(r, iReview) || null,
        tags: allTags.length ? allTags : null,
      });
    } catch (e) {
      errors.push(`Row "${title}": ${e.message}`);
    }
  }
  return { books, errors };
}

// Sniff which importer fits a file's content.
export function detectImportFormat(text, filename = "") {
  if (filename.endsWith(".json") || text.trimStart().startsWith("{")) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data.books) && (data.series != null || data.books[0]?.asin !== undefined))
        return "audible";
    } catch { /* fall through */ }
    return "libby-json";
  }
  const header = (parseCSV(text.slice(0, 2000))[0] ?? []).map((h) => h.trim().toLowerCase());
  // Audible Library Extractor "Raw data" CSV also has "my rating", so check its
  // distinctive "narrators" column before the Goodreads check below.
  if (header.includes("narrators") && header.includes("title")) return "audible-csv";
  if (header.includes("exclusive shelf") || (header.includes("my rating") && header.includes("title"))) return "goodreads";
  if (header.includes("read status") && header.includes("star rating")) return "storygraph";
  if (header.includes("activity") && header.includes("timestamp")) return "libby";
  return null;
}

// ---- AI-assisted import primitives (tiers 2 & 3) ----
// These are the deterministic halves of the AI cascade: AI infers the
// column mapping / repairs rows, but the bulk parsing and validation below
// run locally so cost stays flat regardless of library size.

export const VALID_STATUSES = ["read", "reading", "wanttoread", "recommended", "dnf"];

// Fields a generic (unknown-format) CSV can be mapped onto. `read_count` is a
// synthetic source field (total times read) converted to reread_count.
// Order is the canonical order shown in the import preview.
export const MAPPABLE_FIELDS = [
  "title", "author", "status", "rating", "date_finished", "date_started",
  "year", "isbn", "asin", "narrator", "duration_minutes", "series_title",
  "series_position", "notes", "tags", "read_count", "goodreads_rating",
];

const isAsin = (v) => /^B[0-9A-Z]{9}$/.test(v);
const cleanIsbnUid = (v) => (v ?? "").replace(/[="]/g, "").trim();

// Coerce a raw cell to an ISO date, or null. Returns { value, failed } so the
// caller can flag a value that was present but unparseable (tier-3 repair bait).
function coerceDate(raw) {
  const v = (raw ?? "").trim();
  if (!v) return { value: null, failed: false };
  const ymd = v.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return { value: `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`, failed: false };
  }
  // Fall back to Date for human formats like "May 13, 2024".
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return { value: new Date(t).toISOString().slice(0, 10), failed: false };
  return { value: null, failed: true };
}

const toNum = (raw) => {
  const n = Number(String(raw ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Generic mapping-based CSV parser (tier 2). `mapping` maps our field names to
// source column names (or null); `statusMap` maps raw status values to our
// status enum. Unparseable-but-present values are stashed in `_unparsed` so the
// tier-3 repair pass can find them. Mirrors the shape the dedicated parsers emit.
export function parseWithMapping(text, { mapping = {}, statusMap = {} } = {}) {
  const rows = parseCSV(text);
  if (!rows.length) return { books: [], errors: ["Empty file"] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [field, colName] of Object.entries(mapping)) {
    idx[field] = colName ? header.indexOf(String(colName).trim().toLowerCase()) : -1;
  }
  if (!("title" in idx) || idx.title === -1)
    return { books: [], errors: ["Mapping did not identify a title column"] };

  const cell = (r, field) => (idx[field] == null || idx[field] === -1 ? "" : (r[idx[field]] ?? "").trim());
  const norm = (v) => v.toLowerCase().trim();

  const books = [];
  const errors = [];
  for (const r of rows.slice(1)) {
    const title = cell(r, "title");
    if (!title) continue;
    try {
      const unparsed = {};
      const book = { title };

      if ("author" in idx) book.author = cell(r, "author") || null;
      if ("narrator" in idx) book.narrator = cell(r, "narrator") || null;
      if ("notes" in idx) book.notes = cell(r, "notes") || null;

      if ("status" in idx) {
        const raw = cell(r, "status");
        book.status = statusMap[norm(raw)] ?? statusMap[raw] ?? "wanttoread";
      }

      for (const f of ["rating", "goodreads_rating"]) {
        if (f in idx) { const n = toNum(cell(r, f)); book[f] = n && n > 0 ? n : null; }
      }
      if ("year" in idx) { const n = toNum(cell(r, "year")); book.year = n && n > 0 ? Math.trunc(n) : null; }
      if ("duration_minutes" in idx) { const n = toNum(cell(r, "duration_minutes")); book.duration_minutes = n && n > 0 ? Math.trunc(n) : null; }
      if ("series_position" in idx) { const n = toNum(cell(r, "series_position")); book.series_position = n != null ? n : null; }
      if ("series_title" in idx) book.series_title = cell(r, "series_title") || null;

      if ("read_count" in idx) { const n = toNum(cell(r, "read_count")); book.reread_count = Math.max(0, (n || 1) - 1); }

      for (const f of ["date_finished", "date_started"]) {
        if (f in idx) {
          const { value, failed } = coerceDate(cell(r, f));
          book[f] = value;
          if (failed) unparsed[f] = cell(r, f);
        }
      }

      if ("isbn" in idx || "asin" in idx) {
        const isbnRaw = cleanIsbnUid(cell(r, "isbn"));
        const asinRaw = cleanIsbnUid(cell(r, "asin"));
        // A column mapped as ISBN may actually hold an ASIN (StoryGraph's
        // ISBN/UID does this); route each value to the right field.
        book.asin = (asinRaw && isAsin(asinRaw)) ? asinRaw : (isAsin(isbnRaw) ? isbnRaw : null);
        book.isbn = (isbnRaw && !isAsin(isbnRaw)) ? isbnRaw : null;
      }

      if ("tags" in idx) {
        const tags = cell(r, "tags").split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        book.tags = tags.length ? tags : null;
      }

      if (Object.keys(unparsed).length) book._unparsed = unparsed;
      books.push(book);
    } catch (e) {
      errors.push(`Row "${title}": ${e.message}`);
    }
  }
  return { books, errors };
}

// Flag parsed rows with detectable ("loud") problems for the tier-3 repair pass.
// Catches: garbled/misaligned titles, author duplicating title, out-of-range
// rating/year, invalid status, and values that were present but failed to parse
// (recorded in _unparsed by parseWithMapping). Returns array of { index, book,
// reasons }. It cannot see silently-defaulted values — that is the confirmation
// layer's job.
export function detectMalformedRows(books) {
  const flagged = [];
  books.forEach((book, index) => {
    const reasons = [];
    const title = (book.title ?? "").trim();
    if (!title) reasons.push("empty title");
    if (title.includes("�")) reasons.push("garbled title (encoding)");
    if (title.length > 300) reasons.push("title implausibly long (likely column misalignment)");
    if (book.author && title && book.author.trim().toLowerCase() === title.toLowerCase())
      reasons.push("author duplicates title");
    if (book.status && !VALID_STATUSES.includes(book.status)) reasons.push(`invalid status "${book.status}"`);
    if (book.rating != null && (book.rating < 0 || book.rating > 5)) reasons.push("rating out of range");
    if (book.goodreads_rating != null && (book.goodreads_rating < 0 || book.goodreads_rating > 5)) reasons.push("goodreads_rating out of range");
    // Only flag impossible/garbage years (future-dated, or a misaligned page
    // count / ISBN landing here). Ancient texts use small or negative (BCE)
    // years, so no lower bound — that would false-flag classics from Goodreads.
    if (book.year != null && book.year > 2100) reasons.push("year out of range");
    for (const [field, raw] of Object.entries(book._unparsed ?? {})) reasons.push(`unparseable ${field}: "${raw}"`);
    if (reasons.length) flagged.push({ index, book, reasons });
  });
  return flagged;
}

const EXPORT_COLUMNS = [
  "title", "author", "narrator", "genre", "subgenre", "status", "rating", "loved",
  "year", "duration_minutes", "date_started", "date_finished", "series_title",
  "series_position", "notes", "recommended_by", "tags", "isbn", "asin",
  "goodreads_rating", "goodreads_url",
];

const esc = (v) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Export the in-memory book tree as flat CSV rows (series expanded).
export function booksToCSV(books) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const b of books) {
    if (b.is_series) {
      for (const sub of b.books ?? []) {
        lines.push(EXPORT_COLUMNS.map((c) => esc(c === "series_title" ? b.title : sub[c])).join(","));
      }
    } else {
      lines.push(EXPORT_COLUMNS.map((c) => esc(c === "series_title" ? "" : b[c])).join(","));
    }
  }
  return lines.join("\r\n");
}

export function download(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

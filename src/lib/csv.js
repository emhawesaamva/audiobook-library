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
  if (header.includes("activity") && header.includes("timestamp")) return "libby";
  return null;
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

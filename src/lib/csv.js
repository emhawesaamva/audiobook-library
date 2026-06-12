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

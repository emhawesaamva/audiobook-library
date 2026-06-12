// Backfills cover_url / narrator / duration_minutes / year / asin for books
// that lack them, using the Audible catalog (same source as the app's
// autofill). Conservative: only fills empty fields, and only when the search
// result clearly matches title + author. Series headers inherit the first
// volume's cover when no direct match is found.
//
// Usage: node scripts/backfill-covers.js [--dry-run]
import { rest } from "./common.js";
import { searchBooks } from "../api/_lib/metadata-core.js";

const DRY = process.argv.includes("--dry-run");

const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|a|an|series|saga|trilogy)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const surname = (author) => norm(author).split(" ").pop() ?? "";

function isConfidentMatch(book, r) {
  const bt = norm(book.title), rt = norm(r.title);
  if (!bt || !rt) return false;
  const titleOk = bt === rt || rt.startsWith(bt) || bt.startsWith(rt) || rt.includes(bt);
  if (!titleOk) return false;
  if (book.author && r.author) {
    const bs = surname(book.author);
    return bs.length >= 3 ? norm(r.author).includes(bs) : true;
  }
  return true;
}

const books = await rest("books?select=id,title,author,is_series,parent_id,cover_url,narrator,duration_minutes,year,asin&order=created_at&limit=1000");
const targets = books.filter((b) => !b.cover_url);
console.log(`${books.length} books total, ${targets.length} missing covers${DRY ? " (dry run)" : ""}\n`);

let filled = 0, skipped = 0;
const updatedById = new Map();

for (const book of targets) {
  if (book.is_series) continue; // headers handled in a second pass
  let match = null;
  try {
    const q = `${book.title} ${book.author ?? ""}`.trim();
    const { source, results } = await searchBooks(q, 5);
    if (source === "audible") match = results.find((r) => isConfidentMatch(book, r));
    else match = results.filter((r) => r.cover_url).find((r) => isConfidentMatch(book, r));
  } catch { /* treat as no match */ }

  if (!match?.cover_url) {
    skipped++;
    console.log(`  skip   ${book.title}`);
    continue;
  }
  const patch = { cover_url: match.cover_url };
  if (!book.narrator && match.narrator) patch.narrator = match.narrator;
  if (!book.duration_minutes && match.duration_minutes) patch.duration_minutes = match.duration_minutes;
  if (!book.year && match.year) patch.year = match.year;
  if (!book.asin && match.asin) patch.asin = match.asin;
  if (!DRY) await rest(`books?id=eq.${book.id}`, { method: "PATCH", body: patch });
  updatedById.set(book.id, patch);
  filled++;
  console.log(`  cover  ${book.title}${patch.narrator ? ` (+narrator)` : ""}${patch.duration_minutes ? ` (+runtime)` : ""}`);
  await new Promise((r) => setTimeout(r, 200)); // be polite to the API
}

// Second pass: series headers inherit the first child's cover.
const headers = books.filter((b) => b.is_series && !b.cover_url);
for (const h of headers) {
  const child = books
    .filter((b) => b.parent_id === h.id)
    .map((b) => ({ ...b, ...updatedById.get(b.id) }))
    .find((b) => b.cover_url);
  if (!child) { skipped++; console.log(`  skip   [series] ${h.title}`); continue; }
  if (!DRY) await rest(`books?id=eq.${h.id}`, { method: "PATCH", body: { cover_url: child.cover_url } });
  filled++;
  console.log(`  cover  [series] ${h.title} (from "${child.title}")`);
}

console.log(`\nDone: ${filled} filled, ${skipped} left as placeholder.`);

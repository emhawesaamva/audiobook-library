// Library-wide metadata refresh + series consolidation.
//
// Pass A (always): every non-header book gets a confident Audible match;
//   missing narrator / duration_minutes / year / cover_url / asin are filled.
//   Existing values are never overwritten.
// Pass B: standalone books whose match reports a series are grouped:
//   - join an existing series header when titles match, or
//   - form a new series when >= 2 standalone books share one series.
//   Singletons stay standalone. Dry-run prints the plan; --apply executes
//   (after snapshotting each affected profile).
//
// Usage: node scripts/refresh-metadata.js [--apply]
import { rest } from "./common.js";
import { searchBooks } from "../api/_lib/metadata-core.js";

const APPLY = process.argv.includes("--apply");

const norm = (s) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|a|an|series|saga|trilogy)\b/g, " ").replace(/\s+/g, " ").trim();
const surname = (a) => norm(a).split(" ").pop() ?? "";

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

const books = await rest("books?select=*&order=created_at&limit=1000");
const headers = books.filter((b) => b.is_series);
const nonHeaders = books.filter((b) => !b.is_series);
console.log(`${books.length} rows: ${headers.length} series headers, ${nonHeaders.length} books${APPLY ? " [APPLY]" : " [dry run]"}\n`);

// ---- Pass A: field refresh + series detection ----
let filled = 0, unmatched = 0;
const seriesCandidates = []; // { book, seriesTitle, seriesAsin, position }

for (const book of nonHeaders) {
  let match = null;
  try {
    const { source, results } = await searchBooks(`${book.title} ${book.author ?? ""}`.trim(), 5);
    if (source === "audible") match = results.find((r) => isConfidentMatch(book, r));
  } catch { /* skip */ }
  if (!match) { unmatched++; continue; }

  const patch = {};
  if (!book.narrator && match.narrator) patch.narrator = match.narrator;
  if (!book.duration_minutes && match.duration_minutes) patch.duration_minutes = match.duration_minutes;
  if (!book.year && match.year) patch.year = match.year;
  if (!book.cover_url && match.cover_url) patch.cover_url = match.cover_url;
  if (!book.asin && match.asin) patch.asin = match.asin;
  if (Object.keys(patch).length) {
    filled++;
    console.log(`  fields ${book.title}: ${Object.keys(patch).join(", ")}`);
    if (APPLY) await rest(`books?id=eq.${book.id}`, { method: "PATCH", body: patch });
  }
  if (!book.parent_id && match.series?.asin) {
    seriesCandidates.push({
      book, seriesTitle: match.series.title, seriesAsin: match.series.asin,
      position: match.series.position ?? null,
    });
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`\nPass A: ${filled} books updated, ${unmatched} without a confident match.\n`);

// ---- Pass B: series consolidation ----
const byProfileSeries = new Map(); // `${profile}|${seriesAsin}` -> candidates[]
for (const c of seriesCandidates) {
  const key = `${c.book.profile_id}|${c.seriesAsin}`;
  if (!byProfileSeries.has(key)) byProfileSeries.set(key, []);
  byProfileSeries.get(key).push(c);
}

const plans = [];
for (const [key, group] of byProfileSeries) {
  const profileId = key.split("|")[0];
  const seriesTitle = group[0].seriesTitle;
  const existing = headers.find(
    (h) => h.profile_id === profileId && norm(h.title) === norm(seriesTitle)
  );
  // Duplicate guard: skip books whose title already exists inside the target series
  const childTitles = existing
    ? new Set(books.filter((b) => b.parent_id === existing.id).map((b) => norm(b.title)))
    : new Set();
  const movers = group.filter((c) => !childTitles.has(norm(c.book.title)));
  const dupes = group.filter((c) => childTitles.has(norm(c.book.title)));
  for (const d of dupes) {
    console.log(`  DUPLICATE (left alone): "${d.book.title}" already inside "${existing.title}"`);
  }
  if (!movers.length) continue;
  if (!existing && movers.length < 2) continue; // no one-book series
  plans.push({ profileId, seriesTitle, seriesAsin: group[0].seriesAsin, existing, movers });
}

if (!plans.length) {
  console.log("Pass B: nothing to consolidate.");
} else {
  console.log(`Pass B: ${plans.length} consolidation(s):\n`);
  for (const p of plans) {
    console.log(`  ${p.existing ? `JOIN existing "${p.existing.title}"` : `NEW series "${p.seriesTitle}"`}`);
    for (const m of p.movers.sort((a, b) => (a.position ?? 99) - (b.position ?? 99))) {
      console.log(`    <- #${m.position ?? "?"} ${m.book.title}`);
    }
  }

  if (APPLY) {
    const snapshotted = new Set();
    for (const p of plans) {
      if (!snapshotted.has(p.profileId)) {
        snapshotted.add(p.profileId);
        const data = await rest(`books?select=*&profile_id=eq.${p.profileId}`);
        await rest("library_snapshots", {
          method: "POST",
          body: { profile_id: p.profileId, data },
        });
      }
      let headerId = p.existing?.id;
      if (!headerId) {
        const first = p.movers[0].book;
        const [header] = await rest("books", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: {
            profile_id: p.profileId, is_series: true, title: p.seriesTitle,
            author: first.author, genre: first.genre, subgenre: first.subgenre,
            cover_url: p.movers.find((m) => m.book.cover_url)?.book.cover_url ?? null,
          },
        });
        headerId = header.id;
      }
      for (const m of p.movers) {
        await rest(`books?id=eq.${m.book.id}`, {
          method: "PATCH",
          body: { parent_id: headerId, series_position: m.position },
        });
      }
    }
    console.log("\nApplied. Snapshots saved per affected profile.");
  } else {
    console.log("\nDry run only — re-run with --apply to execute.");
  }
}

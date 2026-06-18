// Shared import pipeline. Reconciles freshly-parsed rows against the existing
// library (diffImport): genuinely new books are enriched with Audible metadata
// and created (onImportBooks, which groups series); books that already exist but
// changed are patched (onUpdateBooks) under the smart-merge policy in mergeBook.
// Returns a summary so the caller can show progress, a toast/diff, and triage.
import { searchBooks, resultToBook } from "./metadata.js";
import { titleKey, flattenBooks } from "./bookUtils.js";

// Map a detected import format (from parseImportFile) to a stable `source` slug
// stored on each book so a later re-import can scope its diff to one service.
export function formatToSource(format) {
  return {
    goodreads: "goodreads", storygraph: "storygraph",
    libby: "libby", "libby-json": "libby",
    audible: "audible", "audible-csv": "audible",
  }[format] ?? "other";
}

const STATUS_RANK = { wanttoread: 0, reading: 1, read: 2 };
const isEmpty = (v) => v == null || v === "";

// Smart-merge policy for a book that already exists in the library. Returns only
// the fields that should change (`patch`) plus a human-readable `changes` list
// for the diff UI. Reading progress only advances; user-owned fields
// (notes/loved/tags/recommended_by/queue_position/dnf_reason and a hand-set
// rating) are never touched; empty incoming values never overwrite anything.
export function mergeBook(existing, incoming) {
  const patch = {};
  const changes = [];

  // status: advance only along wanttoread < reading < read; never regress.
  const cur = existing.status ?? null;
  const next = incoming.status ?? null;
  if (next && next !== cur) {
    const curRank = STATUS_RANK[cur] ?? -1;
    const nextRank = STATUS_RANK[next] ?? -1;
    if (nextRank > curRank) {
      patch.status = next;
      changes.push(`status: ${cur ?? "none"} → ${next}`);
    } else if (next === "dnf" && (cur == null || cur === "wanttoread")) {
      patch.status = "dnf";
      changes.push(`status: ${cur ?? "none"} → dnf`);
    }
  }

  // Fill-only scalar fields: set when missing on the existing row.
  const FILL_FIELDS = [
    "date_started", "date_finished", "year", "narrator", "duration_minutes",
    "cover_url", "asin", "isbn", "goodreads_rating", "description",
  ];
  for (const f of FILL_FIELDS) {
    if (isEmpty(existing[f]) && !isEmpty(incoming[f])) {
      patch[f] = incoming[f];
      changes.push(`+${f.replace(/_/g, " ")}`);
    }
  }

  // rating: only fill if the user hasn't set one (never overwrite a hand-set rating).
  if (isEmpty(existing.rating) && Number(incoming.rating) > 0) {
    patch.rating = incoming.rating;
    changes.push(`+rating ★${incoming.rating}`);
  }

  // progress: take the max.
  const ep = Number(existing.progress_percent) || 0;
  const ip = Number(incoming.progress_percent) || 0;
  if (ip > ep) {
    patch.progress_percent = ip;
    changes.push(`progress: ${ep}% → ${ip}%`);
  }

  return { patch, changes };
}

// Classify freshly-parsed rows against the existing library. Pure (no I/O).
//   create    — no title match; a genuinely new book.
//   update    — title match with a non-empty smart-merge patch ({id,title,patch,changes}).
//   unchanged — title match with nothing to change (count only).
//   missing   — existing books from `source` that the fresh export no longer lists
//               (report-only; never deleted). Empty when `source` is null.
//   restamp   — silent source-provenance backfill ({id,patch:{source}}) for matched
//               books that have no recorded source yet. Applied but never surfaced
//               in the diff UI (it isn't a content change the user cares about).
// Self-healing: when `source` is known, any matched book missing a source gets it —
// folded into its update patch if it's already changing, else added to `restamp`.
export function diffImport(parsed, existingBooks = [], { source = null } = {}) {
  const flat = flattenBooks(existingBooks);
  const byKey = new Map();
  for (const b of flat) {
    const k = titleKey(b.title);
    if (k && !byKey.has(k)) byKey.set(k, b);
  }

  const create = [];
  const update = [];
  const restamp = [];
  const matchedIds = new Set();
  let unchanged = 0;

  for (const b of parsed) {
    const match = byKey.get(titleKey(b.title));
    if (!match) { create.push(b); continue; }
    matchedIds.add(match.id);
    const { patch, changes } = mergeBook(match, b);
    const needsSource = source && isEmpty(match.source);
    if (changes.length) {
      if (needsSource) patch.source = source; // ride along on the same write, silently
      update.push({ id: match.id, title: match.title, patch, changes });
    } else {
      if (needsSource) restamp.push({ id: match.id, patch: { source } });
      unchanged++;
    }
  }

  const missing = source
    ? flat.filter((b) => b.source === source && !matchedIds.has(b.id))
    : [];

  return { create, update, unchanged, missing, restamp };
}

// Enrich genuinely-new books with Audible metadata (best-effort) and attach a
// transient `_series` descriptor for series grouping. Stamps `source` so future
// re-imports can scope their diff. Shared by file and paste imports.
async function enrichNewBooks(fresh, { enrich = false, source = null, onProgress } = {}) {
  const toCreate = [];
  let done = 0;
  if (!fresh.length) return toCreate;
  onProgress?.({ total: fresh.length, done });
  for (const b of fresh) {
    let enriched = {};
    let series = null;
    if (enrich) {
      try {
        const { results } = await searchBooks(`${b.title} ${b.author ?? ""}`, 3);
        const probe = b.title.toLowerCase().slice(0, 15);
        const hit = results.find((r) => r.title?.toLowerCase().includes(probe)) ?? results[0];
        if (hit) {
          const meta = resultToBook(hit);
          enriched = {
            narrator: meta.narrator || null,
            duration_minutes: meta.duration_minutes,
            cover_url: meta.cover_url,
            asin: meta.asin,
            year: b.year ?? meta.year,
            ...(meta.genre ? { genre: meta.genre } : {}),
            ...(meta.subgenre ? { subgenre: meta.subgenre } : {}),
          };
          if (hit.series?.asin) series = hit.series; // {asin, title, position}
        }
      } catch { /* enrichment is best-effort */ }
    }
    const fallbackSeries = !series && b.series_title
      ? { asin: `series:${b.series_title.toLowerCase()}`, title: b.series_title, position: b.series_position ?? null }
      : null;
    toCreate.push({
      ...b, ...enriched,
      genre: b.genre ?? enriched.genre ?? "Other",
      ...(source ? { source } : {}),
      _series: series ?? fallbackSeries,
    });
    done++;
    onProgress?.({ total: fresh.length, done });
  }
  return toCreate;
}

// Reconcile `parsed` against the library, then create new books and patch
// changed ones. `onImportBooks(toCreate)` persists new books (and groups series),
// returning { seriesCount }; `onUpdateBooks(updates)` applies the field patches.
export async function runImport(parsed, {
  books = [], enrich = false, source = null,
  onImportBooks, onUpdateBooks, onProgress,
} = {}) {
  const diff = diffImport(parsed, books, { source });

  // Patch existing books first (visible field changes + silent source backfills),
  // then enrich + create the genuinely new ones.
  const patches = [...diff.update, ...diff.restamp];
  if (patches.length) await onUpdateBooks?.(patches);

  let seriesCount = 0;
  const toCreate = await enrichNewBooks(diff.create, { enrich, source, onProgress });
  if (toCreate.length) ({ seriesCount } = await onImportBooks(toCreate));

  const top = toCreate
    .filter((b) => b.status === "wanttoread" && Number(b.goodreads_rating) > 0)
    .sort((a, b) => Number(b.goodreads_rating) - Number(a.goodreads_rating))
    .slice(0, 3);

  return {
    imported: toCreate.length, updated: diff.update.length,
    unchanged: diff.unchanged, missing: diff.missing,
    seriesCount, top,
    allExisting: !diff.create.length && !diff.update.length,
  };
}

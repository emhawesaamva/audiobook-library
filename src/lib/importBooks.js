// Shared import pipeline: dedupe parsed rows against the existing library,
// optionally enrich each with Audible metadata (cover/narrator/runtime/series),
// then hand off to onImportBooks (which groups series). Returns a summary so the
// caller can show progress, a toast, and import-triage suggestions.
import { searchBooks, resultToBook } from "./metadata.js";

export async function runImport(parsed, { books = [], enrich = false, onImportBooks, onProgress } = {}) {
  const existing = new Set(
    books.flatMap((b) => (b.is_series ? [b, ...(b.books ?? [])] : [b])).map((b) => b.title.toLowerCase())
  );
  const fresh = parsed.filter((b) => !existing.has(b.title.toLowerCase()));
  if (!fresh.length) return { imported: 0, seriesCount: 0, top: [], allExisting: parsed.length > 0 };

  const toCreate = [];
  let done = 0;
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
    toCreate.push({ ...b, ...enriched, genre: b.genre ?? enriched.genre ?? "Other", _series: series ?? fallbackSeries });
    done++;
    onProgress?.({ total: fresh.length, done });
  }

  const { seriesCount } = await onImportBooks(toCreate);
  const top = toCreate
    .filter((b) => b.status === "wanttoread" && Number(b.goodreads_rating) > 0)
    .sort((a, b) => Number(b.goodreads_rating) - Number(a.goodreads_rating))
    .slice(0, 3);
  return { imported: toCreate.length, seriesCount, top, allExisting: false };
}

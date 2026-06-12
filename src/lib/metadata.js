// Browser client for the metadata proxy (api/metadata.js in prod,
// Vite middleware in dev — same handler).

export async function searchBooks(q, limit = 8) {
  const r = await fetch(`/api/metadata?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!r.ok) throw new Error("Metadata search failed");
  return r.json();
}

export async function seriesVolumes(seriesAsin) {
  const r = await fetch(`/api/metadata?series=${encodeURIComponent(seriesAsin)}`);
  if (!r.ok) throw new Error("Series lookup failed");
  return r.json();
}

// Map a metadata result onto book-form fields.
export function resultToBook(r) {
  return {
    title: r.title ?? "",
    author: r.author ?? "",
    narrator: r.narrator ?? "",
    duration_minutes: r.duration_minutes ?? null,
    cover_url: r.cover_url ?? null,
    year: r.year ?? null,
    asin: r.asin ?? null,
    isbn: r.isbn ?? null,
    description: r.description ?? null,
    series_position: r.series?.position ?? r.position ?? null,
  };
}

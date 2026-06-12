// Book-metadata lookup core, shared by the Vercel function (api/metadata.js)
// and the Vite dev middleware. Primary source is Audible's public catalog API
// (keyless, returns narrator/runtime/series/cover in one call); Open Library
// and iTunes are cover/author fallbacks when Audible has nothing.

const AUDIBLE = "https://api.audible.com/1.0/catalog/products";
const RESPONSE_GROUPS = "contributors,media,product_attrs,series";
const UA = { "User-Agent": "Mozilla/5.0 (AudiobookLibrary/2.0)" };

function normalizeProduct(p) {
  const series = (p.series ?? []).find((s) => s.sequence) ?? (p.series ?? [])[0] ?? null;
  const img = p.product_images ? Object.values(p.product_images)[0] : null;
  return {
    asin: p.asin,
    title: p.title,
    subtitle: p.subtitle ?? null,
    author: (p.authors ?? []).map((a) => a.name).join(", ") || null,
    narrator: (p.narrators ?? []).map((n) => n.name).join(", ") || null,
    duration_minutes: p.runtime_length_min ?? null,
    cover_url: img ? img.replace("._SL500_", "._SL500_") : null,
    year: p.release_date ? Number(p.release_date.slice(0, 4)) : null,
    language: p.language ?? null,
    series: series
      ? { asin: series.asin, title: series.title, position: series.sequence ? Number(series.sequence) : null }
      : null,
    description: p.publisher_summary ? String(p.publisher_summary).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600) : null,
  };
}

async function jget(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url.split("?")[0]} -> ${r.status}`);
  return r.json();
}

export async function searchBooks(q, limit = 8) {
  try {
    const data = await jget(
      `${AUDIBLE}?keywords=${encodeURIComponent(q)}&num_results=${limit}&products_sort_by=Relevance&response_groups=${RESPONSE_GROUPS}`
    );
    const results = (data.products ?? [])
      .filter((p) => p.title)
      .map(normalizeProduct)
      .filter((p) => !p.language || p.language === "english");
    if (results.length) return { source: "audible", results };
  } catch { /* fall through */ }

  // Fallback: Open Library (no narrator/duration, but title/author/cover/year)
  try {
    const data = await jget(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=title,author_name,first_publish_year,cover_i,isbn`
    );
    const results = (data.docs ?? []).map((d) => ({
      asin: null,
      title: d.title,
      author: d.author_name?.[0] ?? null,
      narrator: null,
      duration_minutes: null,
      cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
      year: d.first_publish_year ?? null,
      isbn: d.isbn?.[0] ?? null,
      series: null,
      description: null,
    }));
    if (results.length) return { source: "openlibrary", results };
  } catch { /* fall through */ }

  // Last resort: iTunes audiobooks (cover + author)
  try {
    const data = await jget(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=audiobook&limit=${limit}`
    );
    const results = (data.results ?? []).map((d) => ({
      asin: null,
      title: d.collectionName,
      author: d.artistName ?? null,
      narrator: null,
      duration_minutes: null,
      cover_url: d.artworkUrl100 ? d.artworkUrl100.replace("100x100bb", "600x600bb") : null,
      year: d.releaseDate ? Number(d.releaseDate.slice(0, 4)) : null,
      series: null,
      description: d.description?.slice(0, 600) ?? null,
    }));
    return { source: "itunes", results };
  } catch {
    return { source: "none", results: [] };
  }
}

// All volumes of a series, deduped per position (prefer english + longest
// runtime, which skips abridged editions and dramatizations of partial books).
export async function seriesVolumes(seriesAsin) {
  const data = await jget(`${AUDIBLE}/${seriesAsin}?response_groups=relationships,product_attrs`);
  const rels = (data.product?.relationships ?? []).filter(
    (r) => r.relationship_type === "series" && r.relationship_to_product === "child"
  );
  const seriesTitle = data.product?.title ?? null;
  if (!rels.length) return { series: seriesTitle, volumes: [] };

  const details = [];
  const asins = rels.map((r) => r.asin);
  for (let i = 0; i < asins.length; i += 50) {
    const batch = await jget(
      `${AUDIBLE}?asins=${asins.slice(i, i + 50).join(",")}&response_groups=${RESPONSE_GROUPS}`
    );
    details.push(...(batch.products ?? []));
  }
  const byAsin = new Map(details.map((p) => [p.asin, p]));

  const byPosition = new Map();
  for (const rel of rels) {
    const p = byAsin.get(rel.asin);
    if (!p || !p.title) continue;
    const pos = Number(rel.sort);
    if (!Number.isFinite(pos)) continue;
    const norm = { ...normalizeProduct(p), position: pos };
    const cur = byPosition.get(pos);
    const better =
      !cur ||
      (norm.language === "english" && cur.language !== "english") ||
      (norm.language === cur.language && (norm.duration_minutes ?? 0) > (cur.duration_minutes ?? 0));
    if (better) byPosition.set(pos, norm);
  }
  const volumes = [...byPosition.values()]
    .filter((v) => !v.language || v.language === "english")
    .sort((a, b) => a.position - b.position);
  // The series product often lacks a title; fall back to what the volumes say.
  const fallbackTitle = volumes
    .map((v) => v.series)
    .find((s) => s?.asin === seriesAsin)?.title ?? volumes[0]?.series?.title ?? null;
  return { series: seriesTitle || fallbackTitle, volumes };
}

// Connect/Vercel-compatible request handler.
export async function handleMetadataRequest(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams.get("q");
    const series = url.searchParams.get("series");
    let payload;
    if (series) payload = await seriesVolumes(series);
    else if (q) payload = await searchBooks(q, Number(url.searchParams.get("limit")) || 8);
    else { res.statusCode = 400; res.end(JSON.stringify({ error: "q or series required" })); return; }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(JSON.stringify(payload));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message ?? "metadata lookup failed" }));
  }
}

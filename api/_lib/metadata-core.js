// Book-metadata lookup core, shared by the Vercel function (api/metadata.js)
// and the Vite dev middleware. Primary source is Audible's public catalog API
// (keyless, returns narrator/runtime/series/cover in one call); Open Library
// and iTunes are cover/author fallbacks when Audible has nothing.

const AUDIBLE = "https://api.audible.com/1.0/catalog/products";
const RESPONSE_GROUPS = "contributors,media,product_attrs,series,category_ladders,rating";
const UA = { "User-Agent": "Mozilla/5.0 (AudiobookLibrary/2.0)" };

// Map Audible category ladders onto the app's genre list. Deepest rungs are
// checked first so "Epic Fantasy" wins over the "Science Fiction & Fantasy"
// umbrella; the deepest non-umbrella leaf becomes the subgenre.
const GENRE_PATTERNS = [
  [/science fiction/, "Science Fiction"],
  [/fantasy/, "Fantasy"],
  [/horror/, "Horror"],
  [/thriller|suspense/, "Thriller"],
  [/mystery/, "Mystery"],
  [/true crime/, "True Crime"],
  [/\bcrime\b/, "Crime"],
  [/erotica|romance/, "Romance"],
  [/historical fiction/, "Historical Fiction"],
  [/middle grade/, "Middle Grade"],
  [/teen|young adult/, "Young Adult"],
  [/children|kids/, "Children"],
  [/comedy|humor/, "Comedy"],
  [/classic/, "Classics"],
  [/western/, "Westerns"],
  [/short stor|antholog/, "Short Stories"],
  [/poetry|drama/, "Poetry & Drama"],
  [/action & adventure|adventure/, "Action & Adventure"],
  [/contemporary/, "Contemporary Fiction"],
  [/literary|literature & fiction|women's fiction|lgbtq/, "Literary Fiction"],
  [/memoir/, "Memoir"],
  [/biograph/, "Biography"],
  [/self.development|self.help|relationships|parenting|personal development|education/, "Self-Help"],
  [/business|careers|money|finance/, "Business & Finance"],
  [/science & engineering|computers|technology/, "Science & Technology"],
  [/health|wellness|fitness/, "Health & Wellness"],
  [/religion|spiritual/, "Religion & Spirituality"],
  [/politics|social science/, "Politics & Society"],
  [/sports|outdoors/, "Sports & Outdoors"],
  [/travel|tourism/, "Travel"],
  [/arts & entertainment|music|home & garden/, "Arts & Entertainment"],
  [/history/, "History"],
];

function categoriesToGenre(ladders) {
  const names = (ladders ?? []).flatMap((l) => [...(l.ladder ?? [])].reverse().map((c) => c.name));
  let genre = null;
  outer: for (const n of names) {
    const ln = n.toLowerCase();
    for (const [re, g] of GENRE_PATTERNS) {
      if (re.test(ln)) { genre = g; break outer; }
    }
  }
  const leaves = (ladders ?? []).map((l) => l.ladder?.[l.ladder.length - 1]?.name).filter(Boolean);
  const subgenre = leaves.find((n) => n !== genre && !n.includes("&")) ?? null;
  return { genre, subgenre };
}

function normalizeProduct(p) {
  const series = (p.series ?? []).find((s) => s.sequence) ?? (p.series ?? [])[0] ?? null;
  const img = p.product_images ? Object.values(p.product_images)[0] : null;
  const dist = p.rating?.overall_distribution;
  // Polarizing = meaningful sample where the low end is unusually fat for
  // Audible's 5-skewed norm (people either love it or hate it).
  const lowShare = dist?.num_ratings
    ? (dist.num_one_star_ratings + dist.num_two_star_ratings) / dist.num_ratings
    : 0;
  return {
    ...categoriesToGenre(p.category_ladders),
    public_rating: dist?.num_ratings
      ? {
          average: Math.round(dist.average_rating * 10) / 10,
          count: dist.num_ratings,
          polarizing: dist.num_ratings >= 200 && lowShare >= 0.12,
        }
      : null,
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

// Audiobook availability at a Libby/OverDrive library, via the same public
// "Thunder" API the libbyapp.com front-end uses. Keyless; best-effort.
//
// English only, and deliberately so. Without `language=en` the search happily
// matches a foreign-language edition of the same title and reports *its*
// availability: Fairfax owns the Spanish Piranesi (3 copies, ~19 day wait) but
// not the English one, so an English-language shelf was told to expect a
// three-week wait for a book its library cannot lend it at all. The Libby deep
// links this app builds are already pinned to language-en; this matches them.
const LIBBY_LANGUAGE = "en";

export async function libbyAvailability(libraryKey, title, author) {
  const q = encodeURIComponent(`${title} ${author ?? ""}`.trim());
  const data = await jget(
    `https://thunder.api.overdrive.com/v2/libraries/${encodeURIComponent(libraryKey)}/media?query=${q}&format=audiobook-overdrive,audiobook-mp3&language=${LIBBY_LANGUAGE}&perPage=10`
  );
  const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const target = norm(title);
  const hit = (data.items ?? []).find((i) => {
    const t = norm(i.title);
    if (!(t === target || t.startsWith(target) || target.startsWith(t))) return false;
    // Belt and braces: if the language filter is ever ignored or renamed, a
    // wrong-language match would silently return to reporting the wrong
    // edition's wait. Records without a language list are let through rather
    // than dropped, since absence is not evidence of a foreign edition.
    const langs = (i.languages ?? []).map((l) => l?.id).filter(Boolean);
    return langs.length === 0 || langs.includes(LIBBY_LANGUAGE);
  });
  if (!hit || !hit.isOwned) return { owned: false };
  return {
    owned: true,
    available: !!hit.isAvailable,
    waitDays: hit.estimatedWaitDays ?? null,
    holds: hit.holdsCount ?? 0,
    copies: hit.ownedCopies ?? 0,
  };
}

// Connect/Vercel-compatible request handler.
export async function handleMetadataRequest(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const q = url.searchParams.get("q");
    const series = url.searchParams.get("series");
    const libby = url.searchParams.get("libby");
    let payload;
    if (libby && q) payload = await libbyAvailability(libby, q, url.searchParams.get("author"));
    else if (series) payload = await seriesVolumes(series);
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

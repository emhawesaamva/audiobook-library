// The Stats tab's computation, extracted so it has exactly one implementation.
//
// It was a useMemo inside src/components/Stats.jsx until the MCP server needed
// the same numbers for its get_stats tool. Duplicating ~80 lines of tallying
// would have guaranteed the two drifted, so the pure part lives here and both
// callers import it. Stats.jsx still owns all the rendering.
//
// Input is the flattened book list (flattenBooks — series expanded into their
// volumes), not the nested shape.
import { flattenBooks } from "./bookUtils.js";

// Comma-separated contributor fields ("Ray Porter, Amanda Dolan") count once per
// name, which is why this splits rather than tallying the raw string.
function tally(list, key, limit = 6) {
  const m = new Map();
  for (const b of list) {
    const v = b[key];
    if (!v) continue;
    for (const part of String(v).split(",").map((x) => x.trim()).filter(Boolean)) {
      m.set(part, (m.get(part) ?? 0) + 1);
    }
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// Years the library has finished books in, newest first, always including the
// current one so the selector is never empty.
export function listeningYears(books, thisYear = new Date().getFullYear()) {
  const flat = flattenBooks(books);
  const ys = new Set([thisYear]);
  for (const b of flat) {
    if (b.date_finished) ys.add(new Date(b.date_finished + "T00:00:00").getFullYear());
  }
  return [...ys].sort((a, b) => b - a);
}

export function computeStats(flat, year) {
  const finishedEver = flat.filter((b) => b.status === "read");
  const inYear = (b) =>
    b.date_finished && new Date(b.date_finished + "T00:00:00").getFullYear() === year;
  const finishedThisYear = finishedEver.filter(inYear);
  // Undated finished books only count in all-time numbers.
  const minutesEver = finishedEver.reduce((s, b) => s + (b.duration_minutes ?? 0), 0);
  const minutesYear = finishedThisYear.reduce((s, b) => s + (b.duration_minutes ?? 0), 0);

  const rated = finishedEver.filter((b) => Number(b.rating) > 0);
  const dist = new Map();
  for (const b of rated) {
    const r = Number(b.rating);
    dist.set(r, (dist.get(r) ?? 0) + 1);
  }

  const longest = finishedEver.reduce(
    (a, b) => ((b.duration_minutes ?? 0) > (a?.duration_minutes ?? 0) ? b : a),
    null
  );
  const dnf = flat.filter((b) => b.status === "dnf").length;

  // "You vs the crowd": books carrying both your rating and a public one.
  const pairs = finishedEver.filter((b) => Number(b.rating) > 0 && Number(b.goodreads_rating) > 0);
  const delta = (b) => Number(b.rating) - Number(b.goodreads_rating);
  let crowd = null;
  if (pairs.length >= 3) {
    const avgDelta = pairs.reduce((s, b) => s + delta(b), 0) / pairs.length;
    const agree = pairs.filter((b) => Math.abs(delta(b)) <= 0.5).length;
    const spiciest = pairs.reduce((a, b) => (Math.abs(delta(b)) > Math.abs(delta(a)) ? b : a));
    const yearPairs = pairs.filter(inYear);
    crowd = {
      n: pairs.length,
      avgDelta: Math.round(avgDelta * 10) / 10,
      agreePct: Math.round((agree / pairs.length) * 100),
      yearAgreePct: yearPairs.length >= 3
        ? Math.round((yearPairs.filter((b) => Math.abs(delta(b)) <= 0.5).length / yearPairs.length) * 100)
        : null,
      spiciest,
    };
  }

  // Hidden gems: you loved these well beyond the public.
  const gems = pairs.filter((b) => delta(b) >= 1).sort((a, b) => delta(b) - delta(a)).slice(0, 5);

  // Contrarian authors: where your taste consistently diverges (2+ books).
  const byAuthor = new Map();
  for (const b of pairs) {
    if (!b.author) continue;
    if (!byAuthor.has(b.author)) byAuthor.set(b.author, []);
    byAuthor.get(b.author).push(delta(b));
  }
  const contrarians = [...byAuthor.entries()]
    .filter(([, ds]) => ds.length >= 2)
    .map(([author, ds]) => ({
      author,
      n: ds.length,
      delta: Math.round((ds.reduce((s, d) => s + d, 0) / ds.length) * 10) / 10,
    }))
    .filter((a) => Math.abs(a.delta) >= 0.5)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 4);

  return {
    finishedEver: finishedEver.length,
    finishedThisYear: finishedThisYear.length,
    minutesEver, minutesYear,
    avg: rated.length
      ? (rated.reduce((s, b) => s + Number(b.rating), 0) / rated.length).toFixed(1)
      : "—",
    topAuthors: tally(finishedEver, "author"),
    topNarrators: tally(finishedEver, "narrator"),
    topGenres: tally(finishedEver, "genre"),
    dist, longest, dnf, crowd, gems, contrarians,
    rereads: flat.reduce((s, b) => s + (b.reread_count ?? 0), 0),
  };
}

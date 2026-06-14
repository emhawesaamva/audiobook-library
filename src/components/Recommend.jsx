// AI recommendation tab: free-text search against Claude, grounded in the
// profile's loved books/authors/genres. Accepted picks are enriched with
// real metadata (cover, narrator, duration) before saving. With a Libby
// library code configured, each pick also shows live library availability.
import { useState, useEffect } from "react";
import { Dialog, Spinner, Stars, btnPrimary, btnSecondary, inputCls, labelCls } from "./shared.jsx";
import { fetchRecommendations } from "../lib/ai.js";
import { searchBooks, resultToBook, libbyAvailability } from "../lib/metadata.js";
import { flattenBooks, libbySearchUrl, sameTitle, audibleSearchUrl } from "../lib/bookUtils.js";

// Shown when the user clicks a Libby badge without a library code configured.
function LibbySetupDialog({ book, onSave, onClose }) {
  const [code, setCode] = useState("");
  return (
    <Dialog title="Connect your Libby library" onClose={onClose}>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        With your library's code saved, Libby badges show live availability and wait times from
        your library's actual catalog.
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
        <li>Open <a href="https://libbyapp.com" target="_blank" rel="noopener noreferrer" className="text-accent-600 hover:underline">libbyapp.com</a> and go to your library</li>
        <li>Look at the address bar: <span className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">libbyapp.com/library/<strong>code</strong></span></li>
        <li>Paste that last part below</li>
      </ol>
      <div className="mt-3">
        <label className={labelCls}>Library code</label>
        <input
          autoFocus value={code}
          onChange={(e) => setCode(e.target.value.trim().toLowerCase())}
          onKeyDown={(e) => e.key === "Enter" && code && onSave(code)}
          placeholder="e.g. lapl" className={inputCls}
        />
      </div>
      <div className="mt-4 flex gap-2">
        <button onClick={() => code && onSave(code)} disabled={!code} className={`${btnPrimary} flex-1`}>
          Save & check availability
        </button>
        <a
          href={libbySearchUrl(book)} target="_blank" rel="noopener noreferrer"
          onClick={onClose} className={btnSecondary}
        >
          Skip — just search
        </a>
      </div>
    </Dialog>
  );
}

function LibbyBadge({ status, book, libbyKey }) {
  if (!status) return null;
  const base = "shrink-0 rounded-md px-2 py-1 text-xs font-bold";
  const href = libbySearchUrl(book, libbyKey);
  if (!status.owned)
    return <span className={`${base} bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500`}>NOT ON LIBBY</span>;
  if (status.available)
    return <a href={href} target="_blank" rel="noopener noreferrer" className={`${base} bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900`}>LIBBY ✓ AVAILABLE</a>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${base} bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-950 dark:text-sky-400 dark:hover:bg-sky-900`}>
      LIBBY · {status.waitDays != null ? `~${status.waitDays}d wait` : `${status.holds} holds`}
    </a>
  );
}

export default function Recommend({ books, profileName, ageGroup, model, libbyKey, affiliateTag, onLibbyKeyChange, onAdd, onToast }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState({});
  const [libbyStatus, setLibbyStatus] = useState({});
  const [libbySetup, setLibbySetup] = useState(null); // book whose badge was clicked
  const [loadingMore, setLoadingMore] = useState(false);
  const [lastQ, setLastQ] = useState("");

  // Best-effort availability check at the user's library for each pick.
  useEffect(() => {
    if (!libbyKey || !res?.recommendations?.length) return;
    let cancelled = false;
    setLibbyStatus({});
    for (const r of res.recommendations) {
      libbyAvailability(libbyKey, r.title, r.author)
        .then((status) => !cancelled && setLibbyStatus((m) => ({ ...m, [r.title]: status })))
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [libbyKey, res]);

  // Public Audible star ratings per pick — catalog API, no AI involved.
  const [publicRatings, setPublicRatings] = useState({});
  useEffect(() => {
    if (!res?.recommendations?.length) return;
    let cancelled = false;
    for (const r of res.recommendations) {
      if (publicRatings[r.title]) continue;
      searchBooks(`${r.title} ${r.author}`, 3)
        .then(({ results }) => {
          if (cancelled) return;
          const hit = results.find((x) => sameTitle(x.title, r.title)) ?? results[0];
          if (hit?.public_rating) setPublicRatings((m) => ({ ...m, [r.title]: hit.public_rating }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res]);
  // Fuzzy "already in the library" check: catches subtitle/punctuation/article
  // variants ("Project Hail Mary: A Novel" vs "Project Hail Mary").
  const libraryTitles = [...books, ...flattenBooks(books)].map((b) => b.title);
  const inLibrary = (title) => libraryTitles.some((t) => sameTitle(t, title));
  const lovedAuthors = [...new Set(books.filter((b) => b.loved || Number(b.rating) >= 5).map((b) => b.author).filter(Boolean))];

  const go = async () => {
    if (!q.trim() || loading) return;
    setLoading(true);
    setRes(null);
    setLastQ(q);
    try {
      const result = await fetchRecommendations({ books, profileName, ageGroup, query: q, model });
      result.recommendations = result.recommendations.filter((r) => !inLibrary(r.title));
      setRes(result);
    } catch (e) {
      setRes({ error: true, msg: e.message });
    }
    setLoading(false);
  };

  const loadMore = async () => {
    if (loadingMore || !res?.recommendations) return;
    setLoadingMore(true);
    const shown = res.recommendations.map((r) => r.title);
    try {
      const result = await fetchRecommendations({
        books, profileName, ageGroup, model,
        query: `${lastQ}\n\nGive me 5 MORE recommendations for the same request. Do not repeat any of these already-suggested titles: ${shown.join(", ")}.`,
      });
      const fresh = result.recommendations.filter(
        (r) => !inLibrary(r.title) && !shown.some((t) => sameTitle(t, r.title))
      );
      setRes((p) => ({ ...p, recommendations: [...p.recommendations, ...fresh] }));
      if (!fresh.length) onToast?.({ text: "No new suggestions this round — try refining the search" });
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    }
    setLoadingMore(false);
  };

  const handleAdd = async (r) => {
    setAdded((a) => ({ ...a, [r.title]: "adding" }));
    let enriched = {};
    try {
      const { results } = await searchBooks(`${r.title} ${r.author}`, 3);
      const hit = results.find((x) => x.title.toLowerCase().includes(r.title.toLowerCase().slice(0, 20)));
      if (hit) enriched = resultToBook(hit);
    } catch { /* metadata is best-effort */ }
    try {
      await onAdd({
        author: r.author,
        genre: r.genre || "Science Fiction",
        subgenre: r.subgenre || "",
        status: "wanttoread",
        recommended_by: "AudioLib",
        year: r.year ? Number(r.year) : null,
        ...enriched,
        title: enriched.title || r.title, // prefer canonical metadata title
      });
      setAdded((a) => ({ ...a, [r.title]: true }));
    } catch (e) {
      setAdded((a) => ({ ...a, [r.title]: false }));
      onToast?.({ text: `Add failed: ${e.message}`, isError: true });
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Ask anything — describe a mood, genre, author, or a book you loved and want more of.
      </p>
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
          placeholder="What are you looking for?"
          className={inputCls}
        />
        <button onClick={go} disabled={loading} className={btnPrimary}>
          {loading ? <Spinner /> : "Find"}
        </button>
      </div>

      {res?.error && (
        <p className="text-sm text-red-600 dark:text-red-400">Something went wrong{res.msg ? `: ${res.msg}` : "."}</p>
      )}
      {res?.headline && <p className="text-base font-bold">{res.headline}</p>}
      {res?.note && <p className="text-sm italic text-zinc-600 dark:text-zinc-400">{res.note}</p>}
      {res?.recommendations?.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">No new results found.</p>}

      {res?.recommendations?.map((r, i) => (
        <div key={i} className="rounded-xl border border-zinc-300/90 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-base font-semibold">{r.title}</span>
              <span className="ml-2 text-sm text-zinc-600 dark:text-zinc-400">{r.author}</span>
              {r.year && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{r.year}</span>}
              {publicRatings[r.title] && (
                <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap align-middle">
                  <Stars rating={publicRatings[r.title].average} size="text-xs" />
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {publicRatings[r.title].average} ({publicRatings[r.title].count.toLocaleString()})
                  </span>
                  {publicRatings[r.title].polarizing && (
                    <span
                      className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                      title="Listeners either love this or hate it — the rating spread is unusually wide"
                    >
                      ⚡ polarizing
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {libbyKey ? (
                <LibbyBadge status={libbyStatus[r.title]} book={r} libbyKey={libbyKey} />
              ) : (
                <button
                  onClick={() => setLibbySetup(r)}
                  className="shrink-0 cursor-pointer rounded-md bg-sky-100 px-2 py-1 text-xs font-bold text-sky-700 hover:bg-sky-200 dark:bg-sky-950 dark:text-sky-400 dark:hover:bg-sky-900"
                >
                  LIBBY ↗
                </button>
              )}
              <a
                href={audibleSearchUrl(r, affiliateTag)}
                target="_blank" rel="noopener noreferrer"
                className="shrink-0 rounded-md bg-accent-100 px-2 py-1 text-xs font-bold text-accent-700 hover:bg-accent-200 dark:bg-accent-700/20 dark:text-accent-400 dark:hover:bg-accent-700/40"
              >
                AUDIBLE ↗
              </a>
            </div>
          </div>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{r.why}</p>
          <div className="mt-2.5 flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              {r.similarity && <span>↔ {r.similarity}</span>}
              <a
                href={`https://www.goodreads.com/search?q=${encodeURIComponent(`${r.title} ${r.author}`)}`}
                target="_blank" rel="noopener noreferrer" className="text-accent-600 hover:underline"
              >
                Goodreads ↗
              </a>
            </div>
            {added[r.title] === true ? (
              <span className="text-xs font-semibold text-emerald-600">✓ Added</span>
            ) : added[r.title] === "adding" ? (
              <Spinner className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
            ) : (
              <button onClick={() => handleAdd(r)} className={`${btnSecondary} !py-1 !px-2.5 text-xs`}>
                + Want to Listen
              </button>
            )}
          </div>
        </div>
      ))}

      {res?.recommendations?.length > 0 && (
        <button onClick={loadMore} disabled={loadingMore} className={`${btnSecondary} w-full`}>
          {loadingMore ? <><Spinner /> Finding more…</> : "More recommendations"}
        </button>
      )}

      {libbySetup && (
        <LibbySetupDialog
          book={libbySetup}
          onSave={(code) => { onLibbyKeyChange?.(code); setLibbySetup(null); onToast?.({ text: "Libby library saved — checking availability" }); }}
          onClose={() => setLibbySetup(null)}
        />
      )}

      {lovedAuthors.length > 0 && (
        <div className="rounded-xl border border-zinc-300/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Loved authors</div>
          <div className="flex flex-wrap gap-1.5">
            {lovedAuthors.map((a) => (
              <span key={a} className="rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                {a}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

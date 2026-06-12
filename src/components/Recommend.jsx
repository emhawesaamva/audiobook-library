// AI recommendation tab: free-text search against Claude, grounded in the
// profile's loved books/authors/genres. Accepted picks are enriched with
// real metadata (cover, narrator, duration) before saving.
import { useState } from "react";
import { Spinner, btnPrimary, btnSecondary, inputCls } from "./shared.jsx";
import { fetchRecommendations } from "../lib/ai.js";
import { searchBooks, resultToBook } from "../lib/metadata.js";
import { flattenBooks } from "../lib/bookUtils.js";

export default function Recommend({ books, profileName, ageGroup, model, onAdd, onToast }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState({});
  const existingTitles = new Set(
    [...books, ...flattenBooks(books)].map((b) => b.title.toLowerCase())
  );
  const lovedAuthors = [...new Set(books.filter((b) => b.loved || Number(b.rating) >= 5).map((b) => b.author).filter(Boolean))];

  const go = async () => {
    if (!q.trim() || loading) return;
    setLoading(true);
    setRes(null);
    try {
      const result = await fetchRecommendations({ books, profileName, ageGroup, query: q, model });
      result.recommendations = result.recommendations.filter((r) => !existingTitles.has(r.title.toLowerCase()));
      setRes(result);
    } catch (e) {
      setRes({ error: true, msg: e.message });
    }
    setLoading(false);
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
        recommended_by: "Claude",
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
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
      {res?.note && <p className="text-sm italic text-zinc-500">{res.note}</p>}
      {res?.recommendations?.length === 0 && <p className="text-sm text-zinc-400">No new results found.</p>}

      {res?.recommendations?.map((r, i) => (
        <div key={i} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-base font-semibold">{r.title}</span>
              <span className="ml-2 text-sm text-zinc-500">{r.author}</span>
              {r.year && <span className="ml-2 text-xs text-zinc-400">{r.year}</span>}
            </div>
            <a
              href={`https://www.audible.com/search?keywords=${encodeURIComponent(`${r.title} ${r.author}`).replace(/%20/g, "+")}`}
              target="_blank" rel="noopener noreferrer"
              className="shrink-0 rounded-md bg-accent-100 px-2 py-1 text-xs font-bold text-accent-700 hover:bg-accent-200 dark:bg-accent-700/20 dark:text-accent-400 dark:hover:bg-accent-700/40"
            >
              AUDIBLE ↗
            </a>
          </div>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{r.why}</p>
          <div className="mt-2.5 flex items-center justify-between">
            <div className="flex items-center gap-3 text-xs text-zinc-400">
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
              <Spinner className="h-3.5 w-3.5 text-zinc-400" />
            ) : (
              <button onClick={() => handleAdd(r)} className={`${btnSecondary} !py-1 !px-2.5 text-xs`}>
                + Want to Listen
              </button>
            )}
          </div>
        </div>
      ))}

      {lovedAuthors.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Loved authors</div>
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

// Series detail dialog: header metadata plus the volume list, with add/edit/
// delete per volume and a "fetch missing volumes" action driven by metadata.
import { useState } from "react";
import { Dialog, Stars, StatusChip, Cover, Spinner, btnSecondary } from "./shared.jsx";
import BookForm from "./BookForm.jsx";
import { calcSeriesRating, fmtDuration } from "../lib/bookUtils.js";
import { searchBooks, seriesVolumes, resultToBook } from "../lib/metadata.js";

export default function SeriesModal({ series, onClose, onSaveSub, onDeleteSub, onEditHeader, onAddVolumes, onToast }) {
  const [subForm, setSubForm] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [missing, setMissing] = useState(null); // volumes not yet in the series
  const subBooks = series.books ?? [];
  const rating = calcSeriesRating(series);

  const fetchMissing = async () => {
    setFetching(true);
    try {
      // Find the series ASIN via any volume's asin->series, else search by title.
      let seriesAsin = null;
      const { results } = await searchBooks(series.title, 5);
      seriesAsin = results.find((r) => r.series)?.series?.asin ?? null;
      if (!seriesAsin) throw new Error("Series not found on Audible");
      const { volumes } = await seriesVolumes(seriesAsin);
      const have = new Set(subBooks.map((b) => b.title.toLowerCase()));
      const haveAsins = new Set(subBooks.map((b) => b.asin).filter(Boolean));
      const fresh = volumes.filter((v) => !have.has(v.title.toLowerCase()) && !haveAsins.has(v.asin));
      if (!fresh.length) onToast?.({ text: "No missing volumes found — series is complete!" });
      else setMissing(fresh);
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    }
    setFetching(false);
  };

  const addMissing = async () => {
    await onAddVolumes(missing.map((v) => ({
      ...resultToBook(v),
      genre: series.genre, subgenre: series.subgenre, status: "wanttoread",
    })));
    onToast?.({ text: `Added ${missing.length} volume${missing.length === 1 ? "" : "s"}` });
    setMissing(null);
  };

  return (
    <>
      <Dialog title={series.title} onClose={onClose} wide>
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-zinc-500">{series.author}</span>
          {rating > 0 && <Stars rating={rating} size="text-sm" />}
          {series.loved && <span className="text-xs font-bold uppercase tracking-wider text-accent-600">⭐ Loved</span>}
          {series.genre && <span className="text-xs text-zinc-400">{series.genre}{series.subgenre ? ` · ${series.subgenre}` : ""}</span>}
          <span className="text-xs text-zinc-400">{subBooks.length} book{subBooks.length === 1 ? "" : "s"}</span>
          <button onClick={onEditHeader} className="ml-auto text-xs font-medium text-accent-600 hover:text-accent-700 cursor-pointer">Edit series ✏️</button>
        </div>

        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Books in series</span>
          <div className="flex gap-2">
            <button onClick={fetchMissing} disabled={fetching} className={`${btnSecondary} !py-1.5 !px-2.5 text-xs`}>
              {fetching ? <Spinner className="h-3 w-3" /> : "Fetch missing volumes"}
            </button>
            <button onClick={() => setSubForm({})} className={`${btnSecondary} !py-1.5 !px-2.5 text-xs`}>+ Add book</button>
          </div>
        </div>

        {missing && (
          <div className="mb-3 rounded-lg border border-accent-200 bg-accent-50 p-3 dark:border-accent-700/40 dark:bg-accent-700/10">
            <div className="mb-2 text-sm font-medium">{missing.length} volume{missing.length === 1 ? "" : "s"} you don't have:</div>
            <ul className="mb-2 space-y-0.5 text-sm">
              {missing.map((v) => (
                <li key={v.asin} className="text-zinc-600 dark:text-zinc-300">
                  <span className="text-xs text-zinc-400">#{v.position}</span> {v.title}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button onClick={addMissing} className={`${btnSecondary} !py-1 !px-2.5 text-xs`}>Add all as Want to Listen</button>
              <button onClick={() => setMissing(null)} className="text-xs text-zinc-400 hover:text-zinc-600 cursor-pointer">Dismiss</button>
            </div>
          </div>
        )}

        {subBooks.length === 0 ? (
          <div className="py-8 text-center text-sm text-zinc-400">No books added yet.</div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {subBooks.map((b) => (
              <div key={b.id} className="flex items-center gap-3 py-2">
                <span className="w-7 shrink-0 text-right text-xs text-zinc-400">
                  {b.series_position ? `#${b.series_position}` : ""}
                </span>
                <Cover book={b} className="h-12 w-8 shrink-0" rounded="rounded" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-serif text-sm font-semibold">{b.title}{b.loved && <span className="ml-1 text-accent-500">⭐</span>}</div>
                  <div className="truncate text-xs text-zinc-400">
                    {b.narrator ? `🎙 ${b.narrator}` : b.author}{b.duration_minutes ? ` · ${fmtDuration(b.duration_minutes)}` : ""}{b.year ? ` · ${b.year}` : ""}
                  </div>
                </div>
                {Number(b.rating) > 0 && <Stars rating={b.rating} size="text-xs" />}
                <StatusChip status={b.status} />
                <button onClick={() => setSubForm(b)} className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 cursor-pointer" aria-label="Edit">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </Dialog>

      {subForm && (
        <BookForm
          book={subForm.id ? subForm : { author: series.author, genre: series.genre, subgenre: series.subgenre, status: "read" }}
          isSub
          onSave={async (fields) => { await onSaveSub(subForm.id ?? null, fields); setSubForm(null); }}
          onClose={() => setSubForm(null)}
          onToast={onToast}
        />
      )}
    </>
  );
}

// Series detail dialog: header metadata plus the volume list, with add/edit/
// delete per volume and a "fetch missing volumes" action driven by metadata.
import { useState } from "react";
import { Dialog, Stars, StatusChip, Cover, Spinner, btnSecondary, ConfirmRow } from "./shared.jsx";
import BookForm from "./BookForm.jsx";
import { ActionMenu, LibbyChip } from "./BookCard.jsx";
import { calcSeriesRating, fmtDuration } from "../lib/bookUtils.js";
import { Heart } from "lucide-react";
import { searchBooks, seriesVolumes, resultToBook } from "../lib/metadata.js";

// Crowd-rating sparkline across the volumes: does the series hold up?
function SeriesQualityCurve({ books }) {
  const rated = books
    .filter((b) => Number(b.goodreads_rating) > 0)
    .sort((a, b) => (a.series_position ?? 0) - (b.series_position ?? 0));
  if (rated.length < 3) return null;

  const vals = rated.map((b) => Number(b.goodreads_rating));
  const min = Math.min(...vals), max = Math.max(...vals);
  const lo = Math.floor(min * 2) / 2 - 0.1, hi = Math.ceil(max * 2) / 2 + 0.1;
  const W = 420, H = 60, PAD = 8;
  const x = (i) => PAD + (i / (rated.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - PAD * 2);
  const points = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const dipIdx = vals.indexOf(min);
  const dipBook = rated[dipIdx];
  const flat = max - min < 0.3;

  return (
    <div className="mb-3 rounded-lg border border-zinc-300/90 p-3 dark:border-zinc-800">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Crowd ratings across the series</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {flat
            ? "holds steady — safe to commit"
            : `#${dipBook.series_position ?? dipIdx + 1} is the dip (${min}★)`}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full">
        <polyline points={points} fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {vals.map((v, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(v)} r="3" fill="#f59e0b" />
            <text x={x(i)} y={y(v) - 6} textAnchor="middle" className="fill-zinc-500 dark:fill-zinc-400" fontSize="9">{v}</text>
            <text x={x(i)} y={H + 10} textAnchor="middle" className="fill-zinc-400 dark:fill-zinc-500" fontSize="9">
              #{rated[i].series_position ?? i + 1}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export default function SeriesModal({ series, recommenders = [], allTags = [], libbyKey, affiliateTag, onLibbyHold, onClose, onSaveSub, onDeleteSub, onEditHeader, onDeleteSeries, onAddVolumes, onToast }) {
  const [subForm, setSubForm] = useState(null);
  const [fetching, setFetching] = useState(false);
  const [missing, setMissing] = useState(null); // volumes not yet in the series
  const [openMenu, setOpenMenu] = useState(null); // sub-book id whose menu is open
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
          <span className="text-zinc-600 dark:text-zinc-400">{series.author}</span>
          {rating > 0 && <Stars rating={rating} size="text-sm" />}
          {series.loved && <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wider text-accent-600"><Heart className="h-3.5 w-3.5 fill-accent-500 text-accent-500" /> Loved</span>}
          {series.genre && <span className="text-xs text-zinc-500 dark:text-zinc-400">{series.genre}{series.subgenre ? ` · ${series.subgenre}` : ""}</span>}
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{subBooks.length} book{subBooks.length === 1 ? "" : "s"}</span>
          {!confirmingDelete && (
            <span className="ml-auto flex items-center gap-3">
              <button onClick={onEditHeader} className="text-xs font-medium text-accent-600 hover:text-accent-700 cursor-pointer">Edit series</button>
              <button onClick={() => setConfirmingDelete(true)} className="text-xs font-medium text-red-600 hover:text-red-700 dark:text-red-400 cursor-pointer">Delete series</button>
            </span>
          )}
        </div>

        {confirmingDelete && (
          <div className="mb-4">
            <ConfirmRow
              message={`Delete "${series.title}" and all ${subBooks.length} book${subBooks.length === 1 ? "" : "s"} in it? This cannot be undone.`}
              onConfirm={onDeleteSeries}
              onCancel={() => setConfirmingDelete(false)}
            />
          </div>
        )}

        <SeriesQualityCurve books={subBooks} />

        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Books in series</span>
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
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">#{v.position}</span> {v.title}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button onClick={addMissing} className={`${btnSecondary} !py-1 !px-2.5 text-xs`}>Add all as Want to Listen</button>
              <button onClick={() => setMissing(null)} className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 cursor-pointer">Dismiss</button>
            </div>
          </div>
        )}

        {subBooks.length === 0 ? (
          <div className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">No books added yet.</div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {subBooks.map((b) => (
              <div
                key={b.id}
                onClick={() => setOpenMenu(b.id)}
                className="relative flex cursor-pointer items-center gap-3 rounded-md px-1 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
              >
                <span className="w-7 shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-400">
                  {b.series_position ? `#${b.series_position}` : ""}
                </span>
                <Cover book={b} className="h-12 w-8 shrink-0" rounded="rounded" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{b.title}{b.loved && <Heart className="ml-1 inline h-3.5 w-3.5 fill-accent-500 text-accent-500" />}</div>
                  <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {b.narrator ? b.narrator : b.author}{b.duration_minutes ? ` · ${fmtDuration(b.duration_minutes)}` : ""}{b.year ? ` · ${b.year}` : ""}
                  </div>
                </div>
                {Number(b.rating) > 0 && <Stars rating={b.rating} size="text-xs" />}
                {/* Volumes were the one place this never showed, so "is this on
                    Libby or Audible-only?" could only be answered by leaving the
                    series and finding the book in the library grid. */}
                <LibbyChip book={b} className="hidden sm:inline-block" />
                <StatusChip status={b.status} />
                {openMenu === b.id && (
                  <ActionMenu
                    book={b}
                    libbyKey={libbyKey}
                    affiliateTag={affiliateTag}
                    onEdit={() => setSubForm(b)}
                    onDelete={async () => { await onDeleteSub(b.id); onToast?.({ text: `Deleted "${b.title}"` }); }}
                    onLibbyHold={onLibbyHold}
                    onClose={() => setOpenMenu(null)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Dialog>

      {subForm && (
        <BookForm
          book={subForm.id ? subForm : { author: series.author, genre: series.genre, subgenre: series.subgenre, status: "read" }}
          recommenders={recommenders}
          allTags={allTags}
          isSub
          onSave={async (fields) => { await onSaveSub(subForm.id ?? null, fields); setSubForm(null); }}
          onClose={() => setSubForm(null)}
          onToast={onToast}
        />
      )}
    </>
  );
}

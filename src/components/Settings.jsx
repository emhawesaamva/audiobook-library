// Settings dialog: library (profile) management, Goodreads import,
// CSV/JSON export, and account info. The library dropdown at the top selects
// which library the panel configures (it also switches the active library).
import { useState, useEffect, useRef } from "react";
import { Dialog, btnPrimary, btnSecondary, btnDanger, inputCls, selectCls, selectArrowStyle, labelCls, Spinner, ConfirmRow } from "./shared.jsx";
import { booksToCSV, download } from "../lib/csv.js";
import { parseImportFile } from "../lib/importPipeline.js";
import ImportGuides from "./ImportGuides.jsx";
import ImportConfirm from "./ImportConfirm.jsx";
import PasteImport from "./PasteImport.jsx";
import { Upload, Download, RefreshCw } from "lucide-react";
import { searchBooks, resultToBook } from "../lib/metadata.js";
import { updateBook } from "../lib/db.js";

const AGE_GROUPS = [
  { value: "adult", label: "Adult" },
  { value: "teens", label: "Teens" },
  { value: "children", label: "Children" },
];

export default function Settings({
  profile, profiles, books, session, libbyKey,
  audibleSubscriber = false, onAudibleSubscriberChange,
  onSelectProfile, onRenameProfile, onAgeGroupChange, onDeleteProfile, onImportBooks,
  onLibbyKeyChange, onRefreshDone, onClose, onSignOut, onToast,
}) {
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const [libby, setLibby] = useState(libbyKey ?? "");

  // Keep the rename field in sync when a different library is selected.
  useEffect(() => { setName(profile.name); setConfirming(false); }, [profile.id, profile.name]);
  const [importing, setImporting] = useState(null); // {total, done} during import
  const [refreshing, setRefreshing] = useState(null); // {total, done, filled} during metadata refresh
  const refreshAbort = useRef(false);
  const [enrich, setEnrich] = useState(true);
  const [triage, setTriage] = useState(null); // post-import crowd suggestions
  const [pendingImport, setPendingImport] = useState(null); // AI-assisted result awaiting confirmation
  const [analyzing, setAnalyzing] = useState(false); // AI cascade running on an uploaded file
  const fileRef = useRef(null);
  const lastProfile = profiles.length <= 1;

  // Metadata refresh: searches Audible for every book in the library and fills
  // missing narrator / duration / cover / year / asin / goodreads_rating.
  // Existing values are never overwritten. Runs fully client-side via the
  // /api/metadata proxy — no admin credentials needed.
  const refreshMetadata = async () => {
    const leafBooks = books.flatMap((b) => (b.is_series ? (b.books ?? []) : [b]));
    if (!leafBooks.length) { onToast?.({ text: "Library is empty" }); return; }
    refreshAbort.current = false;
    setRefreshing({ total: leafBooks.length, done: 0, filled: 0 });

    const norm = (s) =>
      (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
        .replace(/^(the|a|an) /, "").replace(/\s+/g, " ").trim();
    const surname = (a) => norm(a).split(" ").pop() ?? "";

    let filled = 0;
    for (const book of leafBooks) {
      if (refreshAbort.current) break;
      try {
        const { source, results } = await searchBooks(`${book.title} ${book.author ?? ""}`, 5);
        if (source === "audible") {
          const match = results.find((r) => {
            const bt = norm(book.title), rt = norm(r.title);
            if (!bt || !rt) return false;
            const titleOk = bt === rt || rt.startsWith(bt) || bt.startsWith(rt) || rt.includes(bt);
            if (!titleOk) return false;
            if (book.author && r.author) {
              const bs = surname(book.author);
              return bs.length >= 3 ? norm(r.author).includes(bs) : true;
            }
            return true;
          });
          if (match) {
            const meta = resultToBook(match);
            const patch = {};
            if (!book.narrator && meta.narrator) patch.narrator = meta.narrator;
            if (!book.duration_minutes && meta.duration_minutes) patch.duration_minutes = meta.duration_minutes;
            if (!book.year && meta.year) patch.year = meta.year;
            if (!book.cover_url && meta.cover_url) patch.cover_url = meta.cover_url;
            if (!book.asin && meta.asin) patch.asin = meta.asin;
            if (!book.goodreads_rating && meta.goodreads_rating) patch.goodreads_rating = meta.goodreads_rating;
            if (Object.keys(patch).length) {
              await updateBook(book.id, patch);
              filled++;
            }
          }
        }
      } catch { /* skip this book */ }
      await new Promise((r) => setTimeout(r, 180));
      setRefreshing((p) => p ? { ...p, done: p.done + 1, filled } : null);
    }

    const wasCancelled = refreshAbort.current;
    setRefreshing(null);
    onToast?.({ text: wasCancelled ? `Refresh stopped — ${filled} books updated` : `Refresh complete — ${filled} books updated` });
    if (filled > 0) onRefreshDone?.();
  };

  // Shared import pipeline: dedupe against the library, enrich each book with
  // Audible metadata (covers/narrator/runtime/genre/series), then hand off to
  // onImportBooks (which also groups series). Used by file and paste imports.
  const importParsed = async (parsed, sourceLabel, { note = null, skippedRows = 0 } = {}) => {
    const existing = new Set(
      books.flatMap((b) => (b.is_series ? [b, ...(b.books ?? [])] : [b])).map((b) => b.title.toLowerCase())
    );
    const fresh = parsed.filter((b) => !existing.has(b.title.toLowerCase()));
    if (!fresh.length) {
      onToast?.({ text: `All ${sourceLabel} books are already in this library` });
      return;
    }

    setImporting({ total: fresh.length, done: 0 });
    const toCreate = [];
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
      setImporting((p) => ({ ...p, done: p.done + 1 }));
    }
    try {
      const { seriesCount } = await onImportBooks(toCreate);
      onToast?.({
        text: `Imported ${toCreate.length} books from ${sourceLabel}` +
          (seriesCount ? `, organized ${seriesCount} series` : "") +
          (note ? ` (${note})` : "") +
          (skippedRows ? ` (${skippedRows} rows skipped)` : ""),
      });
      // Import triage: surface the crowd's favorite unread imports as a
      // ready-made starting point.
      const top = toCreate
        .filter((b) => b.status === "wanttoread" && Number(b.goodreads_rating) > 0)
        .sort((a, b) => Number(b.goodreads_rating) - Number(a.goodreads_rating))
        .slice(0, 3);
      if (top.length >= 2) setTriage({ imported: toCreate.length, top });
    } catch (err) {
      onToast?.({ text: `Import failed: ${err.message}`, isError: true });
    }
    setImporting(null);
  };


  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();

    setAnalyzing(true);
    let result;
    try {
      result = await parseImportFile(text, file.name);
    } catch (err) {
      setAnalyzing(false);
      onToast?.({ text: `Couldn't read that file: ${err.message}`, isError: true });
      return;
    }
    setAnalyzing(false);

    if (!result.books.length) {
      onToast?.({ text: result.errors?.[0] ?? "No books found in file", isError: true });
      return;
    }
    // Confirmation rule: anything AI touched (tier 2 mapping / tier 3 repair)
    // is previewed before import; recognized clean formats import directly.
    if (result.aiUsed) {
      setPendingImport(result);
      return;
    }
    await importParsed(result.books, result.sourceLabel, { note: result.note, skippedRows: result.errors?.length ?? 0 });
  };

  const confirmPendingImport = async () => {
    const r = pendingImport;
    setPendingImport(null);
    if (!r) return;
    await importParsed(r.books, r.sourceLabel, { note: r.note, skippedRows: r.errors?.length ?? 0 });
  };

  const section = "border-t border-zinc-100 pt-4 mt-4 dark:border-zinc-800";

  return (
    <Dialog title="Library settings" onClose={onClose}>

      {/* ---- which library ---- */}
      <div>
        <label className={labelCls}>Library</label>
        <select
          value={profile.id}
          onChange={(e) => onSelectProfile(e.target.value)}
          className={selectCls}
          style={selectArrowStyle}
        >
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Everything below applies to <strong>{profile.name}</strong>.
        </p>
      </div>

      {/* ---- rename ---- */}
      <div className="mt-4">
        <label className={labelCls}>Rename this library</label>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          <button
            onClick={() => name.trim() && name !== profile.name && onRenameProfile(name.trim())}
            disabled={!name.trim() || name === profile.name}
            className={btnSecondary}
          >
            Rename
          </button>
        </div>
      </div>

      <div className="mt-4">
        <label className={labelCls}>Profile type <span className="normal-case font-normal">(tunes AI recommendations)</span></label>
        <div className="flex gap-2">
          {AGE_GROUPS.map((ag) => (
            <button
              key={ag.value}
              onClick={() => onAgeGroupChange(ag.value)}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition cursor-pointer ${
                profile.age_group === ag.value
                  ? "border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-700/15 dark:text-accent-400"
                  : "border-zinc-300/90 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:border-zinc-700"
              }`}
            >
              {ag.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---- import / export ---- */}
      <div className={section}>
        <div className={labelCls}>Import & export</div>
        {analyzing ? (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-300/90 p-3 text-sm dark:border-zinc-700">
            <Spinner />
            <span>Reading your file…</span>
          </div>
        ) : importing ? (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-300/90 p-3 text-sm dark:border-zinc-700">
            <Spinner />
            <span>Importing… {importing.done}/{importing.total}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full bg-accent-500 transition-all" style={{ width: `${(importing.done / importing.total) * 100}%` }} />
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => fileRef.current?.click()} className={btnSecondary}><Upload className="h-4 w-4" /> Import</button>
              <PasteImport onConfirm={(rows) => importParsed(rows, "your list")} onToast={onToast} />
              <button onClick={() => download(`${profile.name}-library.csv`, booksToCSV(books), "text/csv")} className={btnSecondary}><Download className="h-4 w-4" /> Export CSV</button>
              <button onClick={() => download(`${profile.name}-library.json`, JSON.stringify(books, null, 2), "application/json")} className={btnSecondary}><Download className="h-4 w-4" /> Export JSON</button>
              <input ref={fileRef} type="file" accept=".csv,.json" onChange={handleImport} className="hidden" />
            </div>
            <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} className="accent-accent-500" />
              Enrich imports with covers, narrators & durations (slower)
            </label>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Accepts Audible Library Extractor (CSV or JSON), Goodreads, StoryGraph, or Libby exports — format is detected
              automatically. Any other book CSV is mapped with AI (you'll confirm before it imports). Imports are additive,
              duplicates are skipped, and series are grouped together.
            </p>
            <ImportGuides />
          </>
        )}
      </div>

      {/* ---- metadata refresh ---- */}
      <div className={section}>
        <div className={labelCls}>Refresh metadata</div>
        {refreshing ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-lg border border-zinc-300/90 p-3 text-sm dark:border-zinc-700">
              <Spinner />
              <div className="flex-1">
                <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-1">
                  <span>Checking book {refreshing.done} of {refreshing.total}…</span>
                  <span>{refreshing.filled} updated</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full bg-accent-500 transition-all" style={{ width: `${(refreshing.done / refreshing.total) * 100}%` }} />
                </div>
              </div>
            </div>
            <button onClick={() => { refreshAbort.current = true; }} className={`${btnSecondary} w-full text-xs`}>
              Stop
            </button>
          </div>
        ) : (
          <>
            <button onClick={refreshMetadata} className={btnSecondary}>
              <RefreshCw className="h-4 w-4" /> Refresh this library
            </button>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Searches Audible for every book in <strong>{profile.name}</strong> and fills in any missing covers,
              narrators, durations, publication years, and public crowd ratings. Existing values are never overwritten.
              Takes about {Math.ceil(books.flatMap(b => b.is_series ? (b.books ?? []) : [b]).length * 0.2 / 60)} min for this library.
            </p>
          </>
        )}
      </div>

      {/* ---- danger zone ---- */}
      <div className={section}>
        {confirming ? (
          <ConfirmRow
            message={`Delete "${profile.name}" and all its books? This cannot be undone.`}
            onConfirm={onDeleteProfile}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <button onClick={() => setConfirming(true)} disabled={lastProfile} className={`${btnDanger} w-full`} title={lastProfile ? "You can't delete your only library" : undefined}>
            Delete the library “{profile.name}”{lastProfile ? " (create another first)" : ""}
          </button>
        )}
      </div>

      {/* ---- Libby ---- */}
      <div className={section}>
        <div className={labelCls}>Libby library code <span className="normal-case font-normal">(applies to your whole account)</span></div>
        <div className="flex gap-2">
          <input
            value={libby}
            onChange={(e) => setLibby(e.target.value.trim().toLowerCase())}
            placeholder="e.g. lapl"
            className={inputCls}
          />
          <button
            onClick={() => { onLibbyKeyChange(libby || null); onToast?.({ text: libby ? "Libby library saved" : "Libby library cleared" }); }}
            disabled={(libbyKey ?? "") === libby}
            className={btnSecondary}
          >
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          The slug from your library's Libby URL (libbyapp.com/library/<strong>code</strong>). With it set, every book's
          “Libby” action searches your library directly; without it, the universal OverDrive search is used.
        </p>
      </div>

      {/* ---- Audible ---- */}
      <div className={section}>
        <div className={labelCls}>Audible</div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={!!audibleSubscriber}
            onChange={(e) => onAudibleSubscriberChange?.(e.target.checked)}
            className="accent-accent-500"
          />
          I'm an Audible subscriber
        </label>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Hides “grab it free on Audible” prompts across the site.
        </p>
      </div>

      {/* ---- account ---- */}
      <div className={section}>
        <div className={labelCls}>Account</div>
        <div className="flex items-center justify-between text-sm">
          <span className="truncate text-zinc-600 dark:text-zinc-400">{session.user.email}</span>
          <button onClick={onSignOut} className={`${btnSecondary} !py-1.5 text-xs`}>Sign out</button>
        </div>
      </div>

      {/* Convenience close button at the bottom of the settings page. */}
      <div className={`${section} flex justify-end`}>
        <button onClick={onClose} className={btnPrimary}>OK</button>
      </div>

      {triage && (
        <Dialog title="Where to start" onClose={() => setTriage(null)}>
          <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
            {triage.imported} books imported. Of the ones you haven't listened to yet, the crowd loves these most:
          </p>
          <div className="mb-4 space-y-2">
            {triage.top.map((b, i) => (
              <div key={i} className="flex items-baseline justify-between gap-2 rounded-lg border border-zinc-300/90 px-3 py-2 text-sm dark:border-zinc-800">
                <span className="truncate font-medium">{i + 1}. {b.title}</span>
                <span className="shrink-0 text-xs font-semibold text-accent-600">★ {Number(b.goodreads_rating)}</span>
              </div>
            ))}
          </div>
          <button onClick={() => setTriage(null)} className={`${btnPrimary} w-full`}>Got it</button>
        </Dialog>
      )}

      {pendingImport && (
        <ImportConfirm result={pendingImport} onConfirm={confirmPendingImport} onCancel={() => setPendingImport(null)} />
      )}

    </Dialog>
  );
}

// Settings dialog: library (profile) management, Goodreads import,
// CSV/JSON export, and account info.
import { useState, useRef } from "react";
import { Dialog, btnPrimary, btnSecondary, btnDanger, inputCls, labelCls, Spinner, ConfirmRow } from "./shared.jsx";
import { parseGoodreadsCSV, booksToCSV, download } from "../lib/csv.js";
import { searchBooks, resultToBook } from "../lib/metadata.js";

const AGE_GROUPS = [
  { value: "adult", label: "Adult" },
  { value: "teens", label: "Teens" },
  { value: "children", label: "Children" },
];

export default function Settings({
  profile, profiles, books, session,
  onRenameProfile, onAgeGroupChange, onDeleteProfile, onImportBooks, onClose, onSignOut, onToast,
}) {
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const [importing, setImporting] = useState(null); // {total, done, enrich} during import
  const [enrich, setEnrich] = useState(true);
  const fileRef = useRef(null);
  const lastProfile = profiles.length <= 1;

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const { books: parsed, errors } = parseGoodreadsCSV(text);
    if (!parsed.length) {
      onToast?.({ text: errors[0] ?? "No books found in file", isError: true });
      return;
    }
    const existing = new Set(books.map((b) => b.title.toLowerCase()));
    const fresh = parsed.filter((b) => !existing.has(b.title.toLowerCase()));
    if (!fresh.length) {
      onToast?.({ text: "All books in the file are already in this library" });
      return;
    }

    setImporting({ total: fresh.length, done: 0 });
    const toCreate = [];
    for (const b of fresh) {
      let enriched = {};
      if (enrich) {
        try {
          const { results } = await searchBooks(`${b.title} ${b.author ?? ""}`, 2);
          if (results[0]) {
            const meta = resultToBook(results[0]);
            enriched = {
              narrator: meta.narrator || null,
              duration_minutes: meta.duration_minutes,
              cover_url: meta.cover_url,
              asin: meta.asin,
              year: b.year ?? meta.year,
            };
          }
        } catch { /* enrichment is best-effort */ }
      }
      toCreate.push({ ...b, ...enriched, genre: b.genre ?? "Other" });
      setImporting((p) => ({ ...p, done: p.done + 1 }));
    }
    try {
      await onImportBooks(toCreate);
      onToast?.({ text: `Imported ${toCreate.length} books${errors.length ? ` (${errors.length} rows skipped)` : ""}` });
    } catch (err) {
      onToast?.({ text: `Import failed: ${err.message}`, isError: true });
    }
    setImporting(null);
  };

  const section = "border-t border-zinc-100 pt-4 mt-4 dark:border-zinc-800";

  return (
    <Dialog title="Settings" onClose={onClose}>
      {/* ---- library ---- */}
      <div>
        <label className={labelCls}>Library name</label>
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
                  : "border-zinc-200 text-zinc-500 hover:border-zinc-300 dark:border-zinc-700"
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
        {importing ? (
          <div className="flex items-center gap-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-700">
            <Spinner />
            <span>Importing… {importing.done}/{importing.total}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full bg-accent-500 transition-all" style={{ width: `${(importing.done / importing.total) * 100}%` }} />
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => fileRef.current?.click()} className={btnSecondary}>↑ Import Goodreads CSV</button>
              <button onClick={() => download(`${profile.name}-library.csv`, booksToCSV(books), "text/csv")} className={btnSecondary}>↓ Export CSV</button>
              <button onClick={() => download(`${profile.name}-library.json`, JSON.stringify(books, null, 2), "application/json")} className={btnSecondary}>↓ Export JSON</button>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleImport} className="hidden" />
            </div>
            <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} className="accent-accent-500" />
              Enrich imports with covers, narrators & durations (slower)
            </label>
            <p className="mt-1 text-xs text-zinc-400">Import is additive — books already in this library are skipped.</p>
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
            Delete this library{lastProfile ? " (create another first)" : ""}
          </button>
        )}
      </div>

      {/* ---- account ---- */}
      <div className={`${section} flex items-center justify-between text-sm`}>
        <span className="truncate text-zinc-500">{session.user.email}</span>
        <button onClick={onSignOut} className={`${btnSecondary} !py-1.5 text-xs`}>Sign out</button>
      </div>
    </Dialog>
  );
}

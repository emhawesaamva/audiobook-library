// Settings dialog: library (profile) management, Goodreads import,
// CSV/JSON export, and account info. The library dropdown at the top selects
// which library the panel configures (it also switches the active library).
import { useState, useEffect, useRef } from "react";
import { Dialog, btnPrimary, btnSecondary, btnDanger, inputCls, labelCls, Spinner, ConfirmRow, StatusChip } from "./shared.jsx";
import { parseGoodreadsCSV, parseLibbyCSV, parseLibbyJSON, detectImportFormat, booksToCSV, download } from "../lib/csv.js";
import { identifyBookList } from "../lib/ai.js";
import { Upload, Download, ClipboardList } from "lucide-react";
import { searchBooks, resultToBook } from "../lib/metadata.js";

const AGE_GROUPS = [
  { value: "adult", label: "Adult" },
  { value: "teens", label: "Teens" },
  { value: "children", label: "Children" },
];

export default function Settings({
  profile, profiles, books, session, libbyKey, welcome = false,
  onSelectProfile, onRenameProfile, onAgeGroupChange, onDeleteProfile, onImportBooks,
  onLibbyKeyChange, onClose, onSignOut, onToast,
}) {
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const [libby, setLibby] = useState(libbyKey ?? "");

  // Keep the rename field in sync when a different library is selected.
  useEffect(() => { setName(profile.name); setConfirming(false); }, [profile.id, profile.name]);
  const [importing, setImporting] = useState(null); // {total, done, enrich} during import
  const [enrich, setEnrich] = useState(true);
  const [paste, setPaste] = useState(null); // null | {step:"input",text} | {step:"review",items,note}
  const [identifying, setIdentifying] = useState(false);
  const fileRef = useRef(null);
  const lastProfile = profiles.length <= 1;

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
      toCreate.push({ ...b, ...enriched, genre: b.genre ?? enriched.genre ?? "Other", _series: series });
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
    } catch (err) {
      onToast?.({ text: `Import failed: ${err.message}`, isError: true });
    }
    setImporting(null);
  };

  // ---- paste-anything import (Haiku parses, user confirms) ----
  const identifyPasted = async () => {
    if (!paste?.text?.trim()) return;
    setIdentifying(true);
    try {
      const { books: found, note } = await identifyBookList(paste.text);
      if (!found.length) {
        onToast?.({ text: note || "No books found in that text", isError: true });
      } else {
        setPaste({
          step: "review",
          text: paste.text,
          note,
          items: found.map((b) => ({ ...b, checked: true })),
        });
      }
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    }
    setIdentifying(false);
  };

  const confirmPasted = async (defaultStatus) => {
    const selected = paste.items.filter((i) => i.checked);
    setPaste(null);
    await importParsed(
      selected.map((i) => ({ title: i.title, author: i.author ?? null, status: i.status ?? defaultStatus })),
      "your list"
    );
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();

    const format = detectImportFormat(text, file.name.toLowerCase());
    const parsedResult =
      format === "goodreads" ? parseGoodreadsCSV(text)
      : format === "libby" ? parseLibbyCSV(text)
      : format === "libby-json" ? parseLibbyJSON(text)
      : { books: [], errors: ["Unrecognized file — expected a Goodreads CSV or a Libby timeline export (CSV or JSON)"] };
    const { books: parsed, errors, note } = parsedResult;
    if (!parsed.length) {
      onToast?.({ text: errors[0] ?? "No books found in file", isError: true });
      return;
    }
    await importParsed(parsed, format === "goodreads" ? "Goodreads" : "Libby", {
      note, skippedRows: errors.length,
    });
  };

  const section = "border-t border-zinc-100 pt-4 mt-4 dark:border-zinc-800";

  return (
    <Dialog title={welcome ? `Welcome — set up "${profile.name}"` : "Library settings"} onClose={onClose}>
      {welcome && (
        <div className="mb-4 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2.5 text-sm dark:border-accent-700/40 dark:bg-accent-700/10">
          <p className="font-medium">Your library is ready! Two things worth doing right away:</p>
          <ol className="mt-1 list-decimal pl-5 text-zinc-600 dark:text-zinc-300">
            <li>Pick who this library is for — it tunes the AI recommendations.</li>
            <li><strong>Bring your books in</strong> — import a Goodreads or Libby export, or just paste any list of titles from your notes.</li>
          </ol>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">All of this stays available later under the ⚙ settings icon.</p>
        </div>
      )}

      {/* ---- which library ---- */}
      <div>
        <label className={labelCls}>Library</label>
        <select
          value={profile.id}
          onChange={(e) => onSelectProfile(e.target.value)}
          className={inputCls}
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
        {importing ? (
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
              <button onClick={() => fileRef.current?.click()} className={btnSecondary}><Upload className="h-4 w-4" /> Import (Goodreads / Libby)</button>
              <button onClick={() => setPaste({ step: "input", text: "" })} className={btnSecondary}><ClipboardList className="h-4 w-4" /> Paste a list</button>
              <button onClick={() => download(`${profile.name}-library.csv`, booksToCSV(books), "text/csv")} className={btnSecondary}><Download className="h-4 w-4" /> Export CSV</button>
              <button onClick={() => download(`${profile.name}-library.json`, JSON.stringify(books, null, 2), "application/json")} className={btnSecondary}><Download className="h-4 w-4" /> Export JSON</button>
              <input ref={fileRef} type="file" accept=".csv,.json" onChange={handleImport} className="hidden" />
            </div>
            <label className="mt-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} className="accent-accent-500" />
              Enrich imports with covers, narrators & durations (slower)
            </label>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Accepts a Goodreads library export (CSV) or a Libby timeline export (CSV or JSON) — the format is detected
              automatically. Imports are additive, duplicates are skipped, and books from the same series are grouped together.
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

      {/* ---- account ---- */}
      <div className={section}>
        <div className={labelCls}>Account</div>
        <div className="flex items-center justify-between text-sm">
          <span className="truncate text-zinc-600 dark:text-zinc-400">{session.user.email}</span>
          <button onClick={onSignOut} className={`${btnSecondary} !py-1.5 text-xs`}>Sign out</button>
        </div>
      </div>

      {paste && (
        <PasteImportDialog
          paste={paste}
          setPaste={setPaste}
          identifying={identifying}
          onIdentify={identifyPasted}
          onConfirm={confirmPasted}
        />
      )}
    </Dialog>
  );
}

// Two-step paste importer: paste anything -> Haiku identifies the books ->
// user confirms the list -> shared import pipeline takes over.
function PasteImportDialog({ paste, setPaste, identifying, onIdentify, onConfirm }) {
  const [defaultStatus, setDefaultStatus] = useState("wanttoread");
  const items = paste.items ?? [];
  const selectedCount = items.filter((i) => i.checked).length;

  const toggle = (idx) =>
    setPaste({ ...paste, items: items.map((it, i) => (i === idx ? { ...it, checked: !it.checked } : it)) });

  return (
    <Dialog title="Import from a pasted list" onClose={() => setPaste(null)} wide={paste.step === "review"}>
      {paste.step === "input" ? (
        <>
          <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
            Paste any list of books — from Apple Notes, a text message, an email, anywhere. Numbering, typos,
            and stray comments are fine; the librarian will sort it out.
          </p>
          <textarea
            autoFocus
            rows={10}
            value={paste.text}
            onChange={(e) => setPaste({ ...paste, text: e.target.value })}
            placeholder={"e.g.\n1. project hail mary\n2. The Martian - andy weir (loved it!)\nmurderbot??\nfinish blood over bright haven"}
            className={inputCls}
          />
          <button onClick={onIdentify} disabled={identifying || !paste.text.trim()} className={`${btnPrimary} mt-3 w-full`}>
            {identifying ? <><Spinner /> Reading your list…</> : "Identify books"}
          </button>
        </>
      ) : (
        <>
          <p className="mb-1 text-sm text-zinc-600 dark:text-zinc-400">
            Found <strong>{items.length}</strong> book{items.length === 1 ? "" : "s"} — uncheck anything that looks wrong, then import.
          </p>
          {paste.note && <p className="mb-2 text-xs italic text-zinc-500 dark:text-zinc-400">{paste.note}</p>}
          <div className="mb-3 max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
            {items.map((it, i) => (
              <label key={i} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                <input type="checkbox" checked={it.checked} onChange={() => toggle(i)} className="accent-accent-500" />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{it.title}</span>
                  {it.author && <span className="text-zinc-500 dark:text-zinc-400"> — {it.author}</span>}
                </span>
                {it.status && <StatusChip status={it.status} />}
              </label>
            ))}
          </div>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Import unmarked books as</span>
            <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)} className={`${inputCls} !w-auto !py-1.5`}>
              <option value="wanttoread">Want to Listen</option>
              <option value="read">Read</option>
              <option value="reading">Listening</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onConfirm(defaultStatus)} disabled={!selectedCount} className={`${btnPrimary} flex-1`}>
              Looks right — import {selectedCount} book{selectedCount === 1 ? "" : "s"}
            </button>
            <button onClick={() => setPaste({ step: "input", text: paste.text })} className={btnSecondary}>← Edit text</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

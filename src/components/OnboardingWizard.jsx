// First-run setup wizard, shown after a library is created (replaces the old
// "welcome mode" Settings panel). Three focused steps: name, who it's for, and
// bringing in books. Reuses the shared import pipeline and export guides.
import { useState, useRef } from "react";
import { Dialog, btnPrimary, btnSecondary, inputCls, labelCls, Spinner } from "./shared.jsx";
import ImportGuides from "./ImportGuides.jsx";
import PasteImport from "./PasteImport.jsx";
import { runImport } from "../lib/importBooks.js";
import {
  detectImportFormat, parseGoodreadsCSV, parseLibbyCSV, parseLibbyJSON,
  parseAudibleJSON, parseAudibleCSV,
} from "../lib/csv.js";
import { Upload, ArrowRight, ArrowLeft, Check, Sparkles } from "lucide-react";

const AGE_GROUPS = [
  { value: "adult", label: "Adult", hint: "No content limits on recommendations." },
  { value: "teens", label: "Teens", hint: "Young-adult picks; skips explicit content." },
  { value: "children", label: "Children", hint: "Kid-friendly picks only." },
];

const STEP_TITLES = ["Name your library", "Who's it for?", "Bring in your books"];

export default function OnboardingWizard({ profile, books, onRename, onAgeGroupChange, onImportBooks, onToast, onClose }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState(profile.name);
  const [ageGroup, setAgeGroup] = useState(profile.age_group ?? "adult");
  const [enrich, setEnrich] = useState(true);
  const [importing, setImporting] = useState(null); // { total, done }
  const [importedCount, setImportedCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const next1 = async () => {
    const clean = name.trim();
    if (!clean) return;
    setSaving(true);
    try { if (clean !== profile.name) await onRename(clean); setStep(2); }
    catch (e) { onToast?.({ text: e.message, isError: true }); }
    setSaving(false);
  };

  const next2 = async () => {
    setSaving(true);
    try { if (ageGroup !== (profile.age_group ?? "adult")) await onAgeGroupChange(ageGroup); setStep(3); }
    catch (e) { onToast?.({ text: e.message, isError: true }); }
    setSaving(false);
  };

  const doImport = async (parsed, sourceLabel, note = null) => {
    if (!parsed.length) return;
    try {
      const r = await runImport(parsed, { books, enrich, onImportBooks, onProgress: setImporting });
      setImporting(null);
      if (r.allExisting) { onToast?.({ text: `All ${sourceLabel} books are already in this library` }); return; }
      setImportedCount((n) => n + r.imported);
      onToast?.({
        text: `Imported ${r.imported} books from ${sourceLabel}`
          + (r.seriesCount ? `, organized ${r.seriesCount} series` : "")
          + (note ? ` (${note})` : ""),
      });
    } catch (err) {
      setImporting(null);
      onToast?.({ text: `Import failed: ${err.message}`, isError: true });
    }
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const format = detectImportFormat(text, file.name.toLowerCase());
    const { books: parsed, errors, note } =
      format === "goodreads" ? parseGoodreadsCSV(text)
      : format === "libby" ? parseLibbyCSV(text)
      : format === "libby-json" ? parseLibbyJSON(text)
      : format === "audible" ? parseAudibleJSON(text)
      : format === "audible-csv" ? parseAudibleCSV(text)
      : { books: [], errors: ["Unrecognized file — expected a Goodreads CSV, Libby export, or Audible Library Extractor export"] };
    if (!parsed.length) {
      onToast?.({ text: errors[0] ?? "No books found in file", isError: true });
      return;
    }
    const sourceLabel = format === "goodreads" ? "Goodreads" : (format === "audible" || format === "audible-csv") ? "Audible" : "Libby";
    await doImport(parsed, sourceLabel, note);
  };

  return (
    <Dialog title={STEP_TITLES[step - 1]} onClose={onClose}>
      {/* step indicator */}
      <div className="mb-4 flex items-center gap-1.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`h-1.5 flex-1 rounded-full transition-colors ${n <= step ? "bg-accent-500" : "bg-zinc-200 dark:bg-zinc-800"}`} />
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            What should we call this shelf? It's the name you'll see and can share with others.
          </p>
          <div>
            <label className={labelCls}>Library name</label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && next1()}
              placeholder="e.g. Sam's Audiobooks" className={inputCls}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={next1} disabled={!name.trim() || saving} className={btnPrimary}>
              {saving ? <Spinner /> : <>Next <ArrowRight className="h-4 w-4" /></>}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Who's this library for? This tunes the AI librarian's recommendations and filters content. You can change it anytime in Settings.
          </p>
          <div className="space-y-2">
            {AGE_GROUPS.map((ag) => (
              <button
                key={ag.value} onClick={() => setAgeGroup(ag.value)}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition cursor-pointer ${
                  ageGroup === ag.value
                    ? "border-accent-500 bg-accent-50 dark:bg-accent-700/15"
                    : "border-zinc-300/90 hover:border-zinc-400 dark:border-zinc-700"
                }`}
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${ageGroup === ag.value ? "border-accent-500 bg-accent-500 text-white" : "border-zinc-400"}`}>
                  {ageGroup === ag.value && <Check className="h-3 w-3" />}
                </span>
                <span>
                  <span className="block text-sm font-medium">{ag.label}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">{ag.hint}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <button onClick={() => setStep(1)} className={btnSecondary}><ArrowLeft className="h-4 w-4" /> Back</button>
            <button onClick={next2} disabled={saving} className={btnPrimary}>
              {saving ? <Spinner /> : <>Next <ArrowRight className="h-4 w-4" /></>}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Bring your books over from Audible, Goodreads, or Libby — or skip for now and the AI librarian will
            add a couple of popular titles to get you started.
          </p>

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
              <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} className="accent-accent-500" />
                Enrich imports with covers, narrators &amp; durations (slower)
              </label>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => fileRef.current?.click()} className={btnSecondary}>
                  <Upload className="h-4 w-4" /> Import a file
                </button>
                <PasteImport onConfirm={(rows) => doImport(rows, "your list")} onToast={onToast} />
              </div>
              <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" onChange={handleFile} className="hidden" />
              {importedCount > 0 && (
                <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="h-4 w-4" /> {importedCount} book{importedCount === 1 ? "" : "s"} imported — import more or finish below.
                </p>
              )}
              <ImportGuides />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No rush — you can import a file or paste a list anytime later from the <strong>⚙ Settings</strong> menu in the top bar.
              </p>
            </>
          )}

          <div className="flex items-center justify-between gap-2 pt-2">
            <button onClick={() => setStep(2)} className={btnSecondary}><ArrowLeft className="h-4 w-4" /> Back</button>
            <button onClick={onClose} disabled={!!importing} className={btnPrimary}>
              {importedCount > 0 ? "Finish" : <><Sparkles className="h-4 w-4" /> Skip &amp; explore</>}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// Add/edit book dialog. New books get search-as-you-type metadata autofill
// (Audible catalog via our proxy) that prefills every field including narrator,
// runtime, cover, and series. When a result belongs to a series, one click
// fetches all volumes for a bulk "add entire series".
import { useState, useEffect, useRef, useCallback } from "react";
import { Dialog, Stars, Cover, Spinner, btnPrimary, btnSecondary, inputCls, labelCls } from "./shared.jsx";
import { searchBooks, seriesVolumes, resultToBook } from "../lib/metadata.js";
import { GENRE_GROUPS, STATUS_LABEL } from "../lib/bookUtils.js";
import { Heart } from "lucide-react";

const EMPTY = {
  title: "", author: "", narrator: "", genre: "Science Fiction", subgenre: "",
  status: "wanttoread", rating: null, loved: false, notes: "", year: null,
  duration_minutes: null, cover_url: null, asin: null, isbn: null, description: null,
  date_started: null, date_finished: null, dnf_reason: "", recommended_by: "",
  tags: [], is_series: false,
};

function Field({ label, children }) {
  return <div><label className={labelCls}>{label}</label>{children}</div>;
}

// Chip-style tag editor with suggestions drawn from tags used elsewhere in
// the library. Enter or comma commits the current text; Backspace on an
// empty input removes the last chip.
function TagInput({ value, onChange, suggestions = [] }) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const chosen = new Set(value.map((t) => t.toLowerCase()));
  const matches = text.trim()
    ? suggestions.filter((t) => !chosen.has(t.toLowerCase()) && t.toLowerCase().includes(text.trim().toLowerCase())).slice(0, 6)
    : suggestions.filter((t) => !chosen.has(t.toLowerCase())).slice(0, 6);

  const commit = (raw) => {
    const t = raw.trim();
    if (t && !chosen.has(t.toLowerCase())) onChange([...value, t]);
    setText("");
  };

  return (
    <div className="relative">
      <div className={`${inputCls} flex min-h-[38px] flex-wrap items-center gap-1 !py-1.5`}>
        {value.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-medium dark:bg-zinc-800">
            {t}
            <button
              onClick={() => onChange(value.filter((x) => x !== t))}
              className="text-zinc-400 hover:text-zinc-600 cursor-pointer"
              aria-label={`Remove ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(text); }
            if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1));
          }}
          placeholder={value.length ? "" : "cozy, slow-burn, found family…"}
          className="min-w-[80px] flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      {focused && matches.length > 0 && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-zinc-300/90 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {matches.map((t) => (
            <button
              key={t}
              onMouseDown={(e) => { e.preventDefault(); commit(t); }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BookForm({
  book, isSub = false, seriesList = [], recommenders = [], onSave, onSaveSeries, onClose, onToast,
}) {
  const isNew = !book?.id;
  const [f, setF] = useState(book ? { ...EMPTY, ...book } : { ...EMPTY });
  const [targetSeriesId, setTargetSeriesId] = useState("");
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);

  // -- metadata search state --
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null); // last picked result (for series banner)
  const [seriesPanel, setSeriesPanel] = useState(null); // {title, volumes, checked:Set}
  const [loadingSeries, setLoadingSeries] = useState(false);
  const searchRef = useRef(null);
  const debounceRef = useRef(null);

  const s = (k, v) => setF((p) => ({ ...p, [k]: v }));

  // Debounced search
  useEffect(() => {
    if (!isNew) return;
    clearTimeout(debounceRef.current);
    if (q.trim().length < 3) { setResults(null); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const { results: r } = await searchBooks(q.trim());
        setResults(r);
      } catch { setResults([]); }
      setSearching(false);
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [q, isNew]);

  const pick = (r) => {
    setPicked(r);
    setResults(null);
    setQ("");
    setSeriesPanel(null);
    // Only spread non-empty values so a sparse result never clears fields.
    const patch = Object.fromEntries(
      Object.entries(resultToBook(r)).filter(([, v]) => v != null && v !== "")
    );
    setF((p) => ({ ...p, ...patch }));
  };

  const loadSeries = async () => {
    if (!picked?.series?.asin) return;
    setLoadingSeries(true);
    try {
      const { series, volumes } = await seriesVolumes(picked.series.asin);
      if (!volumes.length) { onToast?.({ text: "Couldn't list series volumes", isError: true }); }
      else setSeriesPanel({ title: series ?? picked.series.title, volumes, checked: new Set(volumes.map((v) => v.asin)) });
    } catch {
      onToast?.({ text: "Series lookup failed", isError: true });
    }
    setLoadingSeries(false);
  };

  const toggleVolume = (asin) => {
    setSeriesPanel((p) => {
      const checked = new Set(p.checked);
      checked.has(asin) ? checked.delete(asin) : checked.add(asin);
      return { ...p, checked };
    });
  };

  const resetForNext = useCallback(() => {
    setF({ ...EMPTY, genre: f.genre, status: f.status });
    setPicked(null);
    setSeriesPanel(null);
    setQ("");
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [f.genre, f.status]);

  const save = async () => {
    if (!f.title.trim()) return;
    setSaving(true);
    try {
      if (seriesPanel) {
        const volumes = seriesPanel.volumes.filter((v) => seriesPanel.checked.has(v.asin));
        await onSaveSeries(
          {
            title: seriesPanel.title,
            author: f.author, genre: f.genre, subgenre: f.subgenre,
            loved: f.loved, notes: f.notes, recommended_by: f.recommended_by || null,
            cover_url: volumes[0]?.cover_url ?? f.cover_url,
          },
          volumes.map((v) => ({
            ...resultToBook(v),
            genre: f.genre, subgenre: f.subgenre, status: "wanttoread",
          }))
        );
        onToast?.({ text: `Added ${seriesPanel.title} (${volumes.length} books)` });
      } else {
        await onSave({ ...f, recommended_by: f.recommended_by || null }, { targetSeriesId });
        onToast?.({ text: isNew ? `Added "${f.title}"` : "Saved" });
      }
      if (isNew) resetForNext();
      else onClose();
    } catch (e) {
      onToast?.({ text: `Save failed: ${e.message}`, isError: true });
    }
    setSaving(false);
  };

  const showRating = f.status === "read" && !f.is_series;
  const showDnf = f.status === "dnf";

  return (
    <Dialog title={isNew ? "Add Book" : `Edit ${f.is_series ? "Series" : "Book"}`} onClose={onClose} wide={!!seriesPanel}>
      {/* ---- metadata search (new books only) ---- */}
      {isNew && !seriesPanel && (
        <div className="relative mb-4">
          <label className={labelCls}>Search Audible</label>
          <div className="relative">
            <input
              ref={searchRef}
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Title, author, or series…"
              className={inputCls}
            />
            {searching && <span className="absolute right-3 top-2.5 text-zinc-500 dark:text-zinc-400"><Spinner /></span>}
          </div>
          {results && (
            <div className="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-zinc-300/90 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              {results.length === 0 && (
                <div className="px-3 py-2.5 text-sm text-zinc-500 dark:text-zinc-400">No matches — fill the form manually below.</div>
              )}
              {results.map((r) => (
                <button
                  key={r.asin ?? r.title}
                  onClick={() => pick(r)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <Cover book={r} className="h-12 w-8 shrink-0" rounded="rounded" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {r.title}
                      {r.public_rating && (
                        <span className="ml-1.5 text-xs font-semibold text-accent-600">★ {r.public_rating.average}</span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {r.author}{r.narrator ? ` · ${r.narrator}` : ""}{r.year ? ` · ${r.year}` : ""}
                      {r.series ? ` · ${r.series.title}${r.series.position ? ` #${r.series.position}` : ""}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- series banner after picking a series volume ---- */}
      {picked?.series && !seriesPanel && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2.5 dark:border-accent-700/40 dark:bg-accent-700/10">
          <span className="text-sm">
            Part of <strong>{picked.series.title}</strong>
            {picked.series.position ? ` (#${picked.series.position})` : ""}
          </span>
          <button onClick={loadSeries} disabled={loadingSeries} className={`${btnSecondary} shrink-0 !py-1.5 !px-2.5 text-xs`}>
            {loadingSeries ? <Spinner className="h-3 w-3" /> : "Add entire series"}
          </button>
        </div>
      )}

      {/* ---- bulk series panel ---- */}
      {seriesPanel ? (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-base font-semibold">{seriesPanel.title}</h3>
            <button onClick={() => setSeriesPanel(null)} className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 cursor-pointer">← single book instead</button>
          </div>
          <div className="mb-3 max-h-72 space-y-1 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
            {seriesPanel.volumes.map((v) => (
              <label key={v.asin} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                <input
                  type="checkbox"
                  checked={seriesPanel.checked.has(v.asin)}
                  onChange={() => toggleVolume(v.asin)}
                  className="accent-accent-500"
                />
                <Cover book={v} className="h-11 w-7 shrink-0" rounded="rounded" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    <span className="mr-1.5 text-xs text-zinc-500 dark:text-zinc-400">#{v.position}</span>{v.title}
                  </span>
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {v.narrator ? `${v.narrator}` : ""}{v.duration_minutes ? ` · ${Math.round(v.duration_minutes / 60)}h` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Field label="Genre">
              <select value={f.genre} onChange={(e) => s("genre", e.target.value)} className={inputCls}>
                {Object.entries(GENRE_GROUPS).map(([group, list]) => group ? <optgroup key={group} label={group}>{list.map((g) => <option key={g}>{g}</option>)}</optgroup> : list.map((g) => <option key={g}>{g}</option>))}
              </select>
            </Field>
            <Field label="Subgenre">
              <input value={f.subgenre ?? ""} onChange={(e) => s("subgenre", e.target.value)} className={inputCls} />
            </Field>
          </div>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            {seriesPanel.checked.size} of {seriesPanel.volumes.length} volumes selected — added as a series, all marked Want to Listen.
          </p>
        </div>
      ) : (
        /* ---- regular form ---- */
        <div className="space-y-3">
          <div className="flex gap-3">
            {(f.cover_url || f.title) && <Cover book={f} className="h-24 w-16 shrink-0" />}
            <div className="flex-1 space-y-3">
              <Field label="Title">
                <input value={f.title} onChange={(e) => s("title", e.target.value)} className={inputCls} />
              </Field>
              <Field label="Author">
                <input value={f.author ?? ""} onChange={(e) => s("author", e.target.value)} className={inputCls} />
              </Field>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Genre">
              <select value={f.genre ?? "Other"} onChange={(e) => s("genre", e.target.value)} className={inputCls}>
                {Object.entries(GENRE_GROUPS).map(([group, list]) => group ? <optgroup key={group} label={group}>{list.map((g) => <option key={g}>{g}</option>)}</optgroup> : list.map((g) => <option key={g}>{g}</option>))}
              </select>
            </Field>
            <Field label="Subgenre">
              <input value={f.subgenre ?? ""} onChange={(e) => s("subgenre", e.target.value)} className={inputCls} placeholder="Space Opera, Grimdark…" />
            </Field>
          </div>

          {!f.is_series && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Status">
                <select value={f.status ?? "wanttoread"} onChange={(e) => s("status", e.target.value)} className={inputCls}>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Narrator">
                <input value={f.narrator ?? ""} onChange={(e) => s("narrator", e.target.value)} className={inputCls} />
              </Field>
            </div>
          )}

          {showRating && (
            <Field label="Rating">
              <Stars rating={f.rating} onChange={(v) => s("rating", v)} size="text-2xl" />
              {f.rating > 0 && (
                <button onClick={() => s("rating", null)} className="ml-2 text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 cursor-pointer">clear</button>
              )}
            </Field>
          )}

          {showDnf && (
            <div className="grid grid-cols-[1fr_110px] gap-3">
              <Field label="Why did you stop?">
                <input value={f.dnf_reason ?? ""} onChange={(e) => s("dnf_reason", e.target.value)} className={inputCls} />
              </Field>
              <Field label="% reached">
                <input type="number" min="0" max="100" value={f.progress_percent ?? ""} onChange={(e) => s("progress_percent", e.target.value ? Number(e.target.value) : null)} className={inputCls} />
              </Field>
            </div>
          )}

          {(f.is_series || f.status === "read") && (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={!!f.loved} onChange={(e) => s("loved", e.target.checked)} className="accent-accent-500" />
              Loved <Heart className="h-4 w-4 fill-accent-500 text-accent-500" />
            </label>
          )}

          {isNew && !isSub && !f.is_series && seriesList.length > 0 && (
            <Field label="Add to existing series">
              <select value={targetSeriesId} onChange={(e) => setTargetSeriesId(e.target.value)} className={inputCls}>
                <option value="">— Library (top level) —</option>
                {seriesList.map((sr) => <option key={sr.id} value={sr.id}>{sr.title}</option>)}
              </select>
            </Field>
          )}

          <button onClick={() => setMore(!more)} className="text-xs font-medium text-accent-600 hover:text-accent-700 cursor-pointer">
            {more ? "− Fewer details" : "+ More details"}
          </button>

          {more && (
            <div className="space-y-3 rounded-lg border border-zinc-100 p-3 dark:border-zinc-800">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Started">
                  <input type="date" value={f.date_started ?? ""} onChange={(e) => s("date_started", e.target.value || null)} className={inputCls} />
                </Field>
                <Field label="Finished">
                  <input type="date" value={f.date_finished ?? ""} onChange={(e) => s("date_finished", e.target.value || null)} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Length">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number" min="0"
                      value={f.duration_minutes ? Math.floor(f.duration_minutes / 60) : ""}
                      onChange={(e) => {
                        const h = Number(e.target.value) || 0;
                        const m = (f.duration_minutes ?? 0) % 60;
                        s("duration_minutes", h * 60 + m || null);
                      }}
                      className={inputCls}
                      aria-label="Hours"
                    />
                    <span className="text-xs text-zinc-500">h</span>
                    <input
                      type="number" min="0" max="59"
                      value={f.duration_minutes ? f.duration_minutes % 60 : ""}
                      onChange={(e) => {
                        const m = Math.min(59, Number(e.target.value) || 0);
                        const h = Math.floor((f.duration_minutes ?? 0) / 60);
                        s("duration_minutes", h * 60 + m || null);
                      }}
                      className={inputCls}
                      aria-label="Minutes"
                    />
                    <span className="text-xs text-zinc-500">m</span>
                  </div>
                </Field>
                <Field label="Year">
                  <input type="number" value={f.year ?? ""} onChange={(e) => s("year", e.target.value ? Number(e.target.value) : null)} className={inputCls} />
                </Field>
              </div>
              <Field label="Recommended by">
                <input
                  list="recommenders-list"
                  value={f.recommended_by ?? ""}
                  onChange={(e) => s("recommended_by", e.target.value)}
                  className={inputCls}
                  placeholder="Friend, podcast, Claude…"
                />
                <datalist id="recommenders-list">
                  {recommenders.map((r) => <option key={r} value={r} />)}
                </datalist>
              </Field>
              <Field label="Tags">
                <TagInput value={f.tags ?? []} onChange={(tags) => s("tags", tags)} suggestions={allTags} />
              </Field>
              <Field label="Notes">
                <textarea rows={3} value={f.notes ?? ""} onChange={(e) => s("notes", e.target.value)} className={inputCls} />
              </Field>
              <Field label="Cover URL">
                <input value={f.cover_url ?? ""} onChange={(e) => s("cover_url", e.target.value || null)} className={inputCls} />
              </Field>
            </div>
          )}
        </div>
      )}

      <div className="mt-5 flex gap-2">
        <button onClick={save} disabled={saving || (!seriesPanel && !f.title.trim())} className={`${btnPrimary} flex-1`}>
          {saving ? <Spinner /> : seriesPanel ? `Add ${seriesPanel.checked.size} books` : isNew ? "Add" : "Save"}
        </button>
        <button onClick={onClose} className={btnSecondary}>{isNew ? "Done" : "Cancel"}</button>
      </div>
    </Dialog>
  );
}

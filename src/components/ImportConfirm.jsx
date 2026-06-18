// Confirmation preview shown whenever AI was involved in an import (tier 2
// column mapping or tier 3 row repair). The user sees how the file was
// interpreted — the inferred column mapping and a sample of parsed rows —
// before anything is committed. See docs/DESIGN-ai-assisted-imports.md.
import { Dialog, btnPrimary, btnSecondary, StatusChip } from "./shared.jsx";
import { Sparkles } from "lucide-react";

// Field name -> friendly label for the mapping table.
const FIELD_LABELS = {
  title: "Title", author: "Author", status: "Status", rating: "Your rating",
  date_finished: "Date finished", date_started: "Date started", year: "Year",
  isbn: "ISBN", asin: "ASIN", narrator: "Narrator", duration_minutes: "Duration",
  series_title: "Series", series_position: "Series #", notes: "Notes/review",
  tags: "Tags", read_count: "Times read", goodreads_rating: "Avg rating",
};

export default function ImportConfirm({ result, onConfirm, onCancel }) {
  const { books, sourceLabel, aiMapped, mapping, repairedCount } = result;
  const sample = books.slice(0, 12);

  return (
    <Dialog title="Review before importing" onClose={onCancel} wide>
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-accent-200 bg-accent-50 p-3 text-sm dark:border-accent-700/40 dark:bg-accent-700/10">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent-600 dark:text-accent-400" />
        <div className="text-zinc-700 dark:text-zinc-300">
          {aiMapped ? (
            <>This file wasn't one of the formats we recognize, so we used AI to figure out its columns. Please confirm it looks right before importing.</>
          ) : (
            <>We imported your file, but {repairedCount} row{repairedCount === 1 ? "" : "s"} had data we had to clean up with AI. Please confirm the result looks right.</>
          )}
        </div>
      </div>

      {aiMapped && mapping?.mapping && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">Detected columns</p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {Object.entries(mapping.mapping).map(([field, col]) => (
              <div key={field} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-zinc-500 dark:text-zinc-400">{FIELD_LABELS[field] ?? field}</span>
                <span className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={col}>← {col}</span>
              </div>
            ))}
          </div>
          {mapping.note && <p className="mt-2 text-xs italic text-zinc-500 dark:text-zinc-400">{mapping.note}</p>}
        </div>
      )}

      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
        Preview — {books.length} book{books.length === 1 ? "" : "s"}
      </p>
      <div className="mb-4 max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
        {sample.map((b, i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{b.title}</span>
              {b.author && <span className="text-zinc-500 dark:text-zinc-400"> — {b.author}</span>}
            </span>
            {b.rating ? <span className="text-xs text-zinc-400">★{b.rating}</span> : null}
            {b.status && <StatusChip status={b.status} />}
          </div>
        ))}
        {books.length > sample.length && (
          <p className="px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">…and {books.length - sample.length} more</p>
        )}
      </div>

      <div className="flex gap-2">
        <button onClick={onConfirm} className={`${btnPrimary} flex-1`}>
          Looks right — import {books.length} book{books.length === 1 ? "" : "s"} from {sourceLabel}
        </button>
        <button onClick={onCancel} className={btnSecondary}>Cancel</button>
      </div>
    </Dialog>
  );
}

// Holds tab: every book with a recorded Libby hold, soonest first, grouped by
// weeks remaining. Editing or clearing a hold lives only here — the rest of the
// app just records them.
import { Cover, StatusChip } from "./shared.jsx";
import {
  getStatus, hasHold, holdWeeksLeft, holdGroupLabel, libbySearchUrl,
} from "../lib/bookUtils.js";
import { Clock, Pencil, Library, BookCheck } from "lucide-react";

export default function Holds({ books, libbyKey, onEditHold, onBorrowed }) {
  // Series members can carry their own hold, so walk headers and children
  // alike; a header itself never has one (its status is derived).
  const held = books
    .flatMap((b) => (b.is_series ? (b.books ?? []).map((c) => ({ ...c, _parentSeries: b })) : [b]))
    .filter(hasHold)
    .map((b) => ({ book: b, weeksLeft: holdWeeksLeft(b) }))
    .sort((a, z) => a.weeksLeft - z.weeksLeft || (a.book.title ?? "").localeCompare(z.book.title ?? ""));

  if (!held.length) {
    return (
      <div className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
        <Clock className="mx-auto mb-3 h-8 w-8 text-zinc-300 dark:text-zinc-700" />
        <p className="mx-auto max-w-md leading-relaxed">
          No holds recorded yet. Open a Libby link on a book you want or that&rsquo;s been recommended,
          and you&rsquo;ll be asked how long the wait is — holds you record show up here, counting down.
        </p>
      </div>
    );
  }

  // Headings are emitted on change; the sort above keeps equal weeks adjacent.
  let prev;
  const rows = [];
  for (const entry of held) {
    if (entry.weeksLeft !== prev) {
      rows.push({ type: "heading", weeksLeft: entry.weeksLeft, key: `h-${entry.weeksLeft}` });
      prev = entry.weeksLeft;
    }
    rows.push({ type: "book", ...entry });
  }

  const ready = held.filter((h) => h.weeksLeft === 0).length;

  return (
    <>
      <div className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
        {held.length} book{held.length === 1 ? "" : "s"} on hold
        {ready > 0 && <> · <strong className="text-accent-600">{ready}</strong> may be ready</>}
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-300/90 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {rows.map((row) =>
          row.type === "heading" ? (
            <div
              key={row.key}
              className={`border-b px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider ${
                row.weeksLeft === 0
                  ? "border-accent-200/70 bg-accent-50/70 text-accent-700 dark:border-accent-700/30 dark:bg-accent-700/10 dark:text-accent-400"
                  : "border-zinc-100 bg-zinc-50/70 text-zinc-400 dark:border-zinc-800/60 dark:bg-zinc-900/40 dark:text-zinc-500"
              }`}
            >
              {holdGroupLabel(row.weeksLeft)}
            </div>
          ) : (
            <HoldRow
              key={row.book.id}
              book={row.book}
              weeksLeft={row.weeksLeft}
              libbyKey={libbyKey}
              onEditHold={() => onEditHold(row.book)}
              onBorrowed={() => onBorrowed(row.book)}
            />
          )
        )}
      </div>
    </>
  );
}

function HoldRow({ book, weeksLeft, libbyKey, onEditHold, onBorrowed }) {
  const placed = new Date(`${book.hold_date}T00:00:00`);
  const elapsed = Math.max(0, Math.round((Date.now() - placed) / 86_400_000 / 7));

  return (
    <div className="group flex items-center gap-3 border-b border-zinc-100 px-2 py-2 transition last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-900/60">
      <Cover book={book} className="h-14 w-9 shrink-0" rounded="rounded" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{book.title}</div>
        <div className="truncate text-xs text-zinc-600 dark:text-zinc-400">
          {book.author}
          {book._parentSeries && <span className="text-accent-600"> · {book._parentSeries.title}</span>}
        </div>
        <div className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
          {book.hold_weeks}-week hold · placed {elapsed === 0 ? "this week" : `${elapsed} week${elapsed === 1 ? "" : "s"} ago`}
        </div>
      </div>

      <div className="hidden shrink-0 sm:block"><StatusChip status={getStatus(book)} /></div>

      <div className="w-24 shrink-0 text-right">
        {weeksLeft === 0 ? (
          <span className="text-xs font-bold uppercase tracking-wide text-accent-600">Maybe ready</span>
        ) : (
          <>
            <div className="text-sm font-bold leading-none">{weeksLeft}</div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              week{weeksLeft === 1 ? "" : "s"} left
            </div>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {/* Labelled, not another icon: a hold coming through is the only reason
            anyone opens this page, and this is the action that resolves it. */}
        <button
          onClick={onBorrowed}
          className="rounded-md border border-accent-500/60 px-2 py-1 text-xs font-semibold text-accent-700 transition hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-700/10 cursor-pointer"
          title="Clear the hold and start listening to it now"
        >
          <BookCheck className="mr-1 inline h-3.5 w-3.5" />Borrowed
        </button>
        <a
          href={libbySearchUrl(book, libbyKey)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          aria-label={`Open ${book.title} in Libby`}
          title="Open in Libby"
        >
          <Library className="h-4 w-4" />
        </a>
        <button
          onClick={onEditHold}
          className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 cursor-pointer"
          aria-label={`Edit hold on ${book.title}`}
          title="Edit hold"
        >
          <Pencil className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

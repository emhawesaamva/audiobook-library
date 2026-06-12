// Book renderers for the three library views: cover grid, card grid, list row.
// All three share the same action menu (edit / delete / queue / links).
import { useState, useRef, useEffect } from "react";
import { Stars, StatusChip, Cover, ConfirmRow } from "./shared.jsx";
import {
  getStatus, calcSeriesRating, fmtDuration, audibleSearchUrl, goodreadsSearchUrl,
} from "../lib/bookUtils.js";

function ActionMenu({ book, onEdit, onDelete, onQueueToggle, onClose }) {
  const [confirming, setConfirming] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer";
  const queued = book.queue_position != null;

  return (
    <div ref={ref} onClick={(e) => e.stopPropagation()}
      className="absolute right-1 top-8 z-20 w-48 animate-fade-up rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      {confirming ? (
        <div className="p-2">
          <ConfirmRow message="Delete?" onConfirm={() => { onClose(); onDelete(); }} onCancel={() => setConfirming(false)} />
        </div>
      ) : (
        <>
          <button className={item} onClick={() => { onClose(); onEdit(); }}>✏️ Edit</button>
          {!book.is_series && onQueueToggle && (
            <button className={item} onClick={() => { onClose(); onQueueToggle(); }}>
              {queued ? "➖ Remove from Up Next" : "🎯 Add to Up Next"}
            </button>
          )}
          <a className={item} href={audibleSearchUrl(book)} target="_blank" rel="noopener noreferrer" onClick={onClose}>🎧 Audible ↗</a>
          <a className={item} href={goodreadsSearchUrl(book)} target="_blank" rel="noopener noreferrer" onClick={onClose}>📖 Goodreads ↗</a>
          <button className={`${item} text-red-600 dark:text-red-400`} onClick={() => setConfirming(true)}>🗑 Delete</button>
        </>
      )}
    </div>
  );
}

function MenuButton({ open, setOpen }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      className="rounded-md p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 data-[open=true]:opacity-100 cursor-pointer"
      data-open={open}
      aria-label="Book actions"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
    </button>
  );
}

function LovedCorner() {
  return <div className="absolute right-0 top-0 h-0 w-0 border-r-[18px] border-t-[18px] border-r-transparent border-t-accent-500" style={{ borderRightColor: "transparent" }} />;
}

function seriesMeta(book) {
  const n = book.books?.length ?? 0;
  return `${n} book${n === 1 ? "" : "s"}`;
}

// ---- view: card grid ----
export function BookCardGrid({ book, onEdit, onDelete, onOpen, onQueueToggle }) {
  const [menu, setMenu] = useState(false);
  const status = getStatus(book);
  const rating = calcSeriesRating(book);
  return (
    <div
      onClick={book.is_series && onOpen ? onOpen : undefined}
      className={`group relative rounded-xl border border-zinc-200 bg-white p-3 shadow-sm transition hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900 ${book.is_series && onOpen ? "cursor-pointer" : ""}`}
    >
      {book.loved && <LovedCorner />}
      <div className="flex gap-3">
        <Cover book={book} className="h-24 w-16 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-[15px] font-semibold leading-snug">
            {book.title}
            {book.is_series && <span className="ml-1.5 text-xs font-sans font-medium text-accent-600">series ›</span>}
          </div>
          <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">{book.author}</div>
          {book.narrator && (
            <div className="truncate text-xs text-zinc-400 dark:text-zinc-500">🎙 {book.narrator}</div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusChip status={status} />
            {rating > 0 && <Stars rating={rating} size="text-sm" />}
            {book.is_series
              ? <span className="text-xs text-zinc-400">{seriesMeta(book)}</span>
              : book.duration_minutes && <span className="text-xs text-zinc-400">{fmtDuration(book.duration_minutes)}</span>}
          </div>
          {book.subgenre && <div className="mt-1 truncate text-xs text-zinc-400">{book.subgenre}</div>}
        </div>
        <div className="relative shrink-0">
          <MenuButton open={menu} setOpen={setMenu} />
          {menu && <ActionMenu book={book} onEdit={onEdit} onDelete={onDelete} onQueueToggle={onQueueToggle} onClose={() => setMenu(false)} />}
        </div>
      </div>
    </div>
  );
}

// ---- view: cover grid ----
export function BookCoverTile({ book, onEdit, onDelete, onOpen, onQueueToggle }) {
  const [menu, setMenu] = useState(false);
  const status = getStatus(book);
  const rating = calcSeriesRating(book);
  return (
    <div
      onClick={book.is_series && onOpen ? onOpen : onEdit}
      className="group relative cursor-pointer"
      title={`${book.title}${book.author ? ` — ${book.author}` : ""}`}
    >
      <div className="relative overflow-hidden rounded-lg shadow-sm transition group-hover:shadow-lg group-hover:-translate-y-0.5">
        <Cover book={book} className="aspect-[1/1.5] w-full" rounded="rounded-lg" />
        <div className="absolute left-1.5 top-1.5 flex flex-col gap-1">
          <StatusChip status={status} className="shadow" />
          {book.is_series && (
            <span className="rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow">
              Series
            </span>
          )}
        </div>
        {book.loved && <span className="absolute right-1.5 top-1.5 drop-shadow">⭐</span>}
        <div className="absolute right-1 bottom-1" onClick={(e) => e.stopPropagation()}>
          <span className="rounded-md bg-black/55 text-white [&>button]:opacity-100 [&>button]:text-white/90 inline-block">
            <MenuButton open={menu} setOpen={setMenu} />
          </span>
          {menu && <ActionMenu book={book} onEdit={onEdit} onDelete={onDelete} onQueueToggle={onQueueToggle} onClose={() => setMenu(false)} />}
        </div>
      </div>
      <div className="mt-1.5 truncate text-xs font-medium">{book.title}</div>
      <div className="flex items-center justify-between">
        <span className="truncate text-[11px] text-zinc-400">{book.author}</span>
        {rating > 0 && <span className="text-[11px] text-accent-600 font-semibold shrink-0 ml-1">★ {rating}</span>}
      </div>
    </div>
  );
}

// ---- view: list row ----
export function BookListRow({ book, onEdit, onDelete, onOpen, onQueueToggle }) {
  const [menu, setMenu] = useState(false);
  const status = getStatus(book);
  const rating = calcSeriesRating(book);
  return (
    <div
      onClick={book.is_series && onOpen ? onOpen : undefined}
      className={`group relative flex items-center gap-3 border-b border-zinc-100 px-2 py-2 transition hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-900 ${book.is_series && onOpen ? "cursor-pointer" : ""}`}
    >
      <Cover book={book} className="h-14 w-9 shrink-0" rounded="rounded" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-serif text-sm font-semibold">
          {book.title}
          {book.loved && <span className="ml-1 text-accent-500">⭐</span>}
          {book.is_series && <span className="ml-1.5 text-xs font-sans font-medium text-accent-600">series · {seriesMeta(book)} ›</span>}
        </div>
        <div className="truncate text-xs text-zinc-500">{book.author}</div>
      </div>
      <div className="hidden w-40 truncate text-xs text-zinc-400 md:block">{book.narrator}</div>
      <div className="hidden w-16 text-right text-xs text-zinc-400 sm:block">
        {book.is_series ? "" : fmtDuration(book.duration_minutes) ?? ""}
      </div>
      <div className="w-20 text-right">{rating > 0 && <Stars rating={rating} size="text-xs" />}</div>
      <div className="w-14 text-right"><StatusChip status={status} /></div>
      <div className="relative w-7 shrink-0">
        <MenuButton open={menu} setOpen={setMenu} />
        {menu && <ActionMenu book={book} onEdit={onEdit} onDelete={onDelete} onQueueToggle={onQueueToggle} onClose={() => setMenu(false)} />}
      </div>
    </div>
  );
}

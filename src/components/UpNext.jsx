// "Up Next": a small ordered queue of what to listen to next, separate from the
// full Want-to-Listen list, shown above whatever is being listened to right now.
// On desktop it lives in a drawer pinned to the left edge — hover the handle to
// peek, click it to pin open. There's no hover on touch, and a fixed-position
// edge drawer has no good touch equivalent, so phones instead get an accordion
// that sits in the normal page flow and reflows the library below it when
// opened. Reorder with the arrows either way.
//
// Now Reading leads because it answers the more immediate question ("where was
// I?"), and it is display only: the rows carry no controls, and their order is
// whatever the library gives us — there is nothing to arrange in a list you are
// already partway through.
import { useState, useEffect, useRef } from "react";
import { Cover } from "./shared.jsx";
import { ListMusic, ChevronUp, ChevronDown, Play, X, Headphones } from "lucide-react";
import { fmtDuration } from "../lib/bookUtils.js";

export default function UpNext({ queue, reading = [], onReorder, onRemove, onStart }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const ref = useRef(null);
  const open = hovered || pinned;

  // Pinned open is a mode, so it needs the usual ways out: Escape, or a click
  // anywhere else. Hover-open closes itself and needs neither.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e) => e.key === "Escape" && setPinned(false);
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setPinned(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [pinned]);

  if (!queue.length && !reading.length) return null;

  const move = (i, dir) => {
    const next = [...queue];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    // Shuffle the books between the slots the queue already occupies rather
    // than renumbering from 1: a borrowed book keeps its position while it
    // shows under Now Reading, and renumbering would land on top of it.
    const slots = queue.map((b) => b.queue_position);
    onReorder(next.map((b, idx) => ({ id: b.id, queue_position: slots[idx] })));
  };

  // Shared between the two sections: same cover, same two lines. What differs is
  // the leading marker and whether there are controls on the right.
  const line = (b, marker, controls = null) => (
    <div
      key={b.id}
      className="group/q flex items-center gap-2 rounded-lg p-1.5 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
    >
      {marker}
      <Cover book={b} className="h-12 w-8 shrink-0" rounded="rounded" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{b.title}</div>
        <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          {b.duration_minutes ? fmtDuration(b.duration_minutes) : b.author}
        </div>
      </div>
      {controls}
    </div>
  );

  const row = (b, i) => line(
    b,
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500 text-[11px] font-bold text-zinc-900">
      {i + 1}
    </span>,
    /* Always visible on touch; hover-revealed where hover exists. */
    <div className="flex shrink-0 items-center opacity-100 transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/q:opacity-100">
      <div className="flex flex-col">
        <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-25 dark:hover:bg-zinc-700 dark:hover:text-zinc-200 cursor-pointer" aria-label="Move earlier"><ChevronUp className="h-3.5 w-3.5" /></button>
        <button onClick={() => move(i, 1)} disabled={i === queue.length - 1} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-25 dark:hover:bg-zinc-700 dark:hover:text-zinc-200 cursor-pointer" aria-label="Move later"><ChevronDown className="h-3.5 w-3.5" /></button>
      </div>
      <button onClick={() => onStart(b)} className="rounded p-1.5 text-zinc-500 hover:bg-accent-100 hover:text-accent-700 dark:hover:bg-accent-700/20 dark:hover:text-accent-400 cursor-pointer" aria-label={`Start listening to ${b.title}`} title="Start listening"><Play className="h-3.5 w-3.5 fill-current" /></button>
      <button onClick={() => onRemove(b)} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 cursor-pointer" aria-label={`Remove ${b.title} from Up Next`} title="Remove from queue"><X className="h-3.5 w-3.5" /></button>
    </div>,
  );

  const readingRow = (b) => line(
    b,
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500/20 text-accent-700 dark:text-accent-400">
      <Headphones className="h-3 w-3" />
    </span>,
  );

  const heading = (text, n) => (
    <div className="flex items-center gap-1.5 px-1.5 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
      {text}
      <span className="font-semibold normal-case tracking-normal">{n}</span>
    </div>
  );

  // Headings only earn their space when there are two sections to tell apart.
  // With one, the bar above already names it, and a heading directly under a
  // bar that says the same word is just noise.
  const dual = reading.length > 0 && queue.length > 0;

  // Both sections, in the order they matter. Each disappears when empty rather
  // than sitting there as an empty heading.
  const sections = (
    <>
      {reading.length > 0 && (
        <>
          {dual && heading("Now Reading", reading.length)}
          {reading.map(readingRow)}
        </>
      )}
      {queue.length > 0 && (
        <>
          {dual && heading("Up Next", queue.length)}
          {queue.map((b, i) => row(b, i))}
        </>
      )}
    </>
  );

  // The bar across the top names whatever is actually in there, so a drawer
  // holding only a queue still says "Up Next" the way it always has.
  const title = dual ? "Listening" : reading.length > 0 ? "Now Reading" : "Up Next";
  // Same two numbers on the bar and on the handle, so the drawer says the same
  // thing open or shut.
  const counts = [
    reading.length > 0 && `${reading.length} reading`,
    queue.length > 0 && `${queue.length} queued`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      {/* ---- desktop: drawer pinned to the left edge ---- */}
      {/* The panel and its handle slide as one unit, so when closed the handle is
          all that protrudes. Fixed positioning keeps it out of the page flow —
          opening the drawer never reflows the library behind it.

          The container stays panel-height even when only the handle shows, so
          pointer-events-none keeps the empty strip above and below the handle
          from opening the drawer — it used to, which made the hover target much
          taller than the tab looked. The panel and handle opt back in; enter and
          leave still fire up here, because they originate on those children. */}
      <div
        ref={ref}
        data-upnext-drawer=""
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={`pointer-events-none fixed left-0 top-1/2 z-40 hidden max-h-[88vh] -translate-y-1/2 items-center transition-transform duration-300 ease-out sm:flex ${
          open ? "translate-x-0" : "-translate-x-80"
        }`}
      >
        {/* panel */}
        <div className="pointer-events-auto flex max-h-[88vh] min-h-[22rem] w-80 flex-col overflow-hidden rounded-r-xl border border-l-0 border-accent-500/40 bg-white shadow-xl dark:bg-zinc-900">
          <div className="flex items-center gap-2 bg-accent-500 px-3.5 py-2.5">
            <span className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider text-zinc-900">
              <ListMusic className="h-4 w-4" /> {title}
            </span>
            <span className="text-xs font-medium text-zinc-900/70">{counts}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">{sections}</div>
        </div>

        {/* handle — the only part on screen when closed. It names both sections,
            in the order they appear inside, so it grows taller as it says more. */}
        <button
          onClick={() => setPinned((p) => !p)}
          aria-expanded={open}
          aria-label={`Now Reading and Up Next, ${counts}`}
          className="pointer-events-auto flex cursor-pointer items-center rounded-r-lg bg-accent-500 px-1 py-6 shadow-lg transition-colors hover:bg-accent-400"
        >
          <span className="flex items-center gap-2 text-sm font-bold uppercase leading-none tracking-wider text-zinc-900 [writing-mode:vertical-rl]">
            {reading.length > 0 && (
              <>
                <Headphones className="h-4 w-4 rotate-90" />
                Reading
                <span className="font-semibold text-zinc-900/70">{reading.length}</span>
              </>
            )}
            {reading.length > 0 && queue.length > 0 && (
              <span aria-hidden="true" className="h-4 w-px bg-zinc-900/30" />
            )}
            {queue.length > 0 && (
              <>
                <ListMusic className="h-4 w-4 rotate-90" />
                Up Next
                <span className="font-semibold text-zinc-900/70">{queue.length}</span>
              </>
            )}
          </span>
        </button>
      </div>

      {/* ---- mobile: inline accordion, part of the page flow ---- */}
      <div className="mb-4 overflow-hidden rounded-xl border border-accent-500/40 sm:hidden">
        <button
          onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen}
          className="flex w-full cursor-pointer items-center gap-2 bg-accent-500 px-3.5 py-2.5 text-left"
        >
          <ListMusic className="h-4 w-4 shrink-0 text-zinc-900" />
          <span className="text-sm font-bold uppercase tracking-wider text-zinc-900">{title}</span>
          <span className="text-xs font-medium text-zinc-900/70">{counts}</span>
          <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-zinc-900 transition-transform duration-200 ${mobileOpen ? "rotate-180" : ""}`} />
        </button>
        {mobileOpen && (
          <div className="max-h-[60vh] overflow-y-auto bg-white p-2 dark:bg-zinc-900">{sections}</div>
        )}
      </div>
    </>
  );
}

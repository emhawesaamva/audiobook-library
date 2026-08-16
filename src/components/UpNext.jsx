// "Up Next": a small ordered queue of what to listen to next, separate from the
// full Want-to-Listen list. Lives in a drawer pinned to the left edge — hover
// the handle to peek, click it to pin open. Reorder with the arrows.
import { useState, useEffect, useRef } from "react";
import { Cover } from "./shared.jsx";
import { ListMusic, ChevronUp, ChevronDown, Play, X, ChevronRight } from "lucide-react";
import { fmtDuration } from "../lib/bookUtils.js";

export default function UpNext({ queue, onReorder, onRemove, onStart }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
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

  if (!queue.length) return null;

  const move = (i, dir) => {
    const next = [...queue];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next.map((b, idx) => ({ id: b.id, queue_position: idx + 1 })));
  };

  return (
    // The panel and its handle slide as one unit, so when closed the handle is
    // all that protrudes. Fixed positioning keeps it out of the page flow —
    // opening the drawer never reflows the library behind it.
    <div
      ref={ref}
      data-upnext-drawer=""
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`fixed left-0 top-1/2 z-40 flex max-h-[80vh] -translate-y-1/2 items-center transition-transform duration-300 ease-out ${
        open ? "translate-x-0" : "-translate-x-72"
      }`}
    >
      {/* panel */}
      <div className="flex max-h-[80vh] w-72 flex-col overflow-hidden rounded-r-xl border border-l-0 border-accent-200/70 bg-white shadow-xl dark:border-accent-700/30 dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-accent-200/60 bg-accent-50/60 px-3 py-2 dark:border-accent-700/20 dark:bg-accent-700/10">
          <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-700 dark:text-accent-400">
            <ListMusic className="h-3.5 w-3.5" /> Up Next
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{queue.length} queued</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {queue.map((b, i) => (
            <div
              key={b.id}
              className="group/q flex items-center gap-2 rounded-lg p-1.5 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-500 text-[11px] font-bold text-zinc-900">
                {i + 1}
              </span>
              <Cover book={b} className="h-12 w-8 shrink-0" rounded="rounded" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{b.title}</div>
                <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  {b.duration_minutes ? fmtDuration(b.duration_minutes) : b.author}
                </div>
              </div>
              {/* Always visible on touch; hover-revealed where hover exists. */}
              <div className="flex shrink-0 items-center opacity-100 transition [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/q:opacity-100">
                <div className="flex flex-col">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-25 dark:hover:bg-zinc-700 dark:hover:text-zinc-200 cursor-pointer" aria-label="Move earlier"><ChevronUp className="h-3.5 w-3.5" /></button>
                  <button onClick={() => move(i, 1)} disabled={i === queue.length - 1} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 disabled:opacity-25 dark:hover:bg-zinc-700 dark:hover:text-zinc-200 cursor-pointer" aria-label="Move later"><ChevronDown className="h-3.5 w-3.5" /></button>
                </div>
                <button onClick={() => onStart(b)} className="rounded p-1.5 text-zinc-500 hover:bg-accent-100 hover:text-accent-700 dark:hover:bg-accent-700/20 dark:hover:text-accent-400 cursor-pointer" aria-label={`Start listening to ${b.title}`} title="Start listening"><Play className="h-3.5 w-3.5 fill-current" /></button>
                <button onClick={() => onRemove(b)} className="rounded p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 cursor-pointer" aria-label={`Remove ${b.title} from Up Next`} title="Remove from queue"><X className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* handle — the only part on screen when closed */}
      <button
        onClick={() => setPinned((p) => !p)}
        aria-expanded={open}
        aria-label={`Up Next, ${queue.length} queued`}
        className="flex cursor-pointer items-center gap-1.5 rounded-r-lg border border-l-0 border-accent-200/70 bg-accent-50 py-3 pl-1 pr-1.5 shadow-md transition-colors hover:bg-accent-100 dark:border-accent-700/30 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      >
        <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent-700 [writing-mode:vertical-rl] dark:text-accent-400">
          <ListMusic className="h-3.5 w-3.5 rotate-90" />
          Up Next
          <span className="text-zinc-500 dark:text-zinc-400">{queue.length}</span>
        </span>
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-accent-600 transition-transform duration-300 dark:text-accent-500 ${open ? "rotate-180" : ""}`} />
      </button>
    </div>
  );
}

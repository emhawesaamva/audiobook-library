// "Up Next" strip: a small ordered queue of what to listen to next,
// separate from the full Want-to-Listen list. Reorder with arrows.
import { Cover } from "./shared.jsx";
import { fmtDuration } from "../lib/bookUtils.js";

export default function UpNext({ queue, onReorder, onRemove, onStart }) {
  if (!queue.length) return null;
  const move = (i, dir) => {
    const next = [...queue];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onReorder(next.map((b, idx) => ({ id: b.id, queue_position: idx + 1 })));
  };

  return (
    <div className="mb-5 rounded-xl border border-accent-200/70 bg-accent-50/50 p-3 dark:border-accent-700/30 dark:bg-accent-700/5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-accent-700 dark:text-accent-400">🎯 Up Next</span>
        <span className="text-xs text-zinc-400">{queue.length} queued</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {queue.map((b, i) => (
          <div key={b.id} className="group/q relative w-28 shrink-0">
            <div className="relative">
              <Cover book={b} className="aspect-[1/1.5] w-full" rounded="rounded-lg" />
              <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent-500 text-[11px] font-bold text-white shadow">
                {i + 1}
              </span>
              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 rounded-b-lg bg-black/60 py-1 opacity-0 transition group-hover/q:opacity-100">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1 text-xs text-white/90 hover:bg-white/20 disabled:opacity-30 cursor-pointer" aria-label="Move earlier">←</button>
                <button onClick={() => onStart(b)} className="rounded px-1 text-xs text-white/90 hover:bg-white/20 cursor-pointer" title="Start listening">▶</button>
                <button onClick={() => onRemove(b)} className="rounded px-1 text-xs text-white/90 hover:bg-white/20 cursor-pointer" title="Remove from queue">✕</button>
                <button onClick={() => move(i, 1)} disabled={i === queue.length - 1} className="rounded px-1 text-xs text-white/90 hover:bg-white/20 disabled:opacity-30 cursor-pointer" aria-label="Move later">→</button>
              </div>
            </div>
            <div className="mt-1 truncate text-xs font-medium">{b.title}</div>
            <div className="truncate text-[11px] text-zinc-400">
              {b.duration_minutes ? fmtDuration(b.duration_minutes) : b.author}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

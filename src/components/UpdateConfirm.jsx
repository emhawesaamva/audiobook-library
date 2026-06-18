// Preview shown when a re-imported export overlaps the existing library — i.e.
// the user is *updating* rather than importing fresh. Lays out what will change
// (new books, field changes, and books no longer in the export) so they can
// confirm before anything is applied. The diff comes from diffImport(); applying
// runs the same importParsed() path as a normal import. See plan: "Update a
// user's library from imported services".
import { Dialog, btnPrimary, btnSecondary, StatusChip } from "./shared.jsx";
import { RefreshCw } from "lucide-react";

const CAP = 12; // rows shown per section before "…and N more"

function MoreLine({ shown, total }) {
  return total > shown
    ? <p className="px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">…and {total - shown} more</p>
    : null;
}

export default function UpdateConfirm({ diff, sourceLabel, onConfirm, onCancel }) {
  const { create = [], update = [], unchanged = 0, missing = [] } = diff;
  const nothingToDo = !create.length && !update.length;

  return (
    <Dialog title={`Update from ${sourceLabel}`} onClose={onCancel} wide>
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-accent-200 bg-accent-50 p-3 text-sm dark:border-accent-700/40 dark:bg-accent-700/10">
        <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-accent-600 dark:text-accent-400" />
        <div className="text-zinc-700 dark:text-zinc-300">
          {nothingToDo ? (
            <>Your library is already up to date with this {sourceLabel} export — nothing to add or change.</>
          ) : (
            <>
              We compared this {sourceLabel} export against your library:{" "}
              <strong>{create.length} new</strong>, <strong>{update.length} changed</strong>
              {unchanged ? <>, {unchanged} unchanged</> : null}. Review before applying.
            </>
          )}
        </div>
      </div>

      {create.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            New — {create.length} book{create.length === 1 ? "" : "s"}
          </p>
          <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
            {create.slice(0, CAP).map((b, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{b.title}</span>
                  {b.author && <span className="text-zinc-500 dark:text-zinc-400"> — {b.author}</span>}
                </span>
                {b.rating ? <span className="text-xs text-zinc-400">★{b.rating}</span> : null}
                {b.status && <StatusChip status={b.status} />}
              </div>
            ))}
            <MoreLine shown={CAP} total={create.length} />
          </div>
        </div>
      )}

      {update.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            Changed — {update.length} book{update.length === 1 ? "" : "s"}
          </p>
          <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
            {update.slice(0, CAP).map((u, i) => (
              <div key={i} className="rounded-md px-2 py-1.5">
                <span className="truncate text-sm font-medium">{u.title}</span>
                <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">{u.changes.join(" · ")}</span>
              </div>
            ))}
            <MoreLine shown={CAP} total={update.length} />
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
            No longer in this export — {missing.length} book{missing.length === 1 ? "" : "s"}
          </p>
          <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
            {missing.slice(0, CAP).map((b, i) => (
              <div key={i} className="truncate px-2 py-1 text-sm text-zinc-600 dark:text-zinc-400">{b.title}</div>
            ))}
            <MoreLine shown={CAP} total={missing.length} />
          </div>
          <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-400">Left untouched — nothing is deleted.</p>
        </div>
      )}

      <div className="flex gap-2">
        {nothingToDo ? (
          <button onClick={onCancel} className={`${btnPrimary} flex-1`}>Done</button>
        ) : (
          <>
            <button onClick={onConfirm} className={`${btnPrimary} flex-1`}>
              Apply update — {create.length} new, {update.length} changed
            </button>
            <button onClick={onCancel} className={btnSecondary}>Cancel</button>
          </>
        )}
      </div>
    </Dialog>
  );
}

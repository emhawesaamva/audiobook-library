// Asked after a Libby link is opened for a Recommended / Want book, and reused
// as the editor on the Holds tab. Same form either way — the only differences
// are the framing copy and whether "Clear hold" is offered.
import { useState, useEffect, useRef } from "react";
import { Dialog, btnPrimary, btnSecondary, inputCls, labelCls } from "./shared.jsx";
import { hasHold, holdWeeksLeft } from "../lib/bookUtils.js";
import { libbyAvailability } from "../lib/metadata.js";
import { Clock } from "lucide-react";

// Common Libby quotes, so the usual answer is one click rather than typing.
const PRESETS = [1, 2, 4, 8, 12, 20];

export default function HoldModal({ book, editing = false, suggestWeeks = null, willAdd = false, libbyKey = null, onSave, onClear, onClose }) {
  const existing = hasHold(book);
  const [weeks, setWeeks] = useState(
    existing ? String(book.hold_weeks) : suggestWeeks ? String(suggestWeeks) : ""
  );
  const [busy, setBusy] = useState(false);

  // Live wait from the library, so the usual case needs no typing. The Recommend
  // tab already has this cached and passes it as suggestWeeks; everywhere else
  // (library cards, series volumes, the Holds tab) had no estimate at all, so
  // fetch it here rather than making the user read it off the Libby page.
  const [avail, setAvail] = useState(null);
  const [availState, setAvailState] = useState(libbyKey && !existing ? "loading" : "idle");
  // Never overwrite a number the user has touched, however late the fetch lands.
  const touched = useRef(false);

  useEffect(() => {
    if (!libbyKey || existing) return;
    let cancelled = false;
    libbyAvailability(libbyKey, book.title, book.author)
      .then((s) => {
        if (cancelled) return;
        setAvail(s);
        setAvailState("done");
        if (!touched.current && s?.owned && s.waitDays != null) {
          setWeeks(String(Math.max(1, Math.ceil(s.waitDays / 7))));
        }
      })
      .catch(() => !cancelled && setAvailState("error"));
    return () => { cancelled = true; };
  }, [libbyKey, existing, book.title, book.author]);

  const n = Number(weeks);
  const valid = Number.isInteger(n) && n > 0 && n <= 104;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try { await onSave(n); } finally { setBusy(false); }
  };

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    try { await onClear(); } finally { setBusy(false); }
  };

  return (
    <Dialog title={editing ? "Edit hold" : "Did you put this book on hold?"} onClose={onClose}>
      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{book.title}</div>
          {book.author && <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{book.author}</div>}
          {existing && editing && (
            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {book.hold_weeks}-week hold placed {new Date(`${book.hold_date}T00:00:00`).toLocaleDateString()}
              {" · "}
              {holdWeeksLeft(book) === 0 ? "may be ready now" : `${holdWeeksLeft(book)} left`}
            </div>
          )}
        </div>
      </div>

      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
        {editing
          ? "Update the wait Libby quoted, or clear the hold if it came through or you cancelled it."
          : "If you placed a hold, record the wait Libby quoted and this book moves to your Holds tab, counting down from today."}
        {willAdd && !editing && (
          <> It&rsquo;ll be added to your library as <strong>Want to Listen</strong>.</>
        )}
      </p>
      {!existing && <AvailabilityNote state={availState} avail={avail} seeded={suggestWeeks != null} />}

      <label className={labelCls} htmlFor="hold-weeks">About how many weeks wait?</label>
      <div className="mb-2.5 flex items-center gap-2">
        <input
          id="hold-weeks"
          autoFocus
          type="number"
          min="1"
          max="104"
          value={weeks}
          onChange={(e) => { touched.current = true; setWeeks(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="e.g. 8"
          className={`${inputCls} !w-28`}
        />
        <span className="text-sm text-zinc-500 dark:text-zinc-400">weeks</span>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => { touched.current = true; setWeeks(String(p)); }}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
              n === p
                ? "border-accent-500 bg-accent-500 text-zinc-900"
                : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {p}w
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={!valid || busy} className={btnPrimary}>
          {editing ? "Save hold" : "Yes, save hold"}
        </button>
        <button onClick={onClose} disabled={busy} className={btnSecondary}>
          {editing ? "Cancel" : "No, I didn't"}
        </button>
        {existing && onClear && (
          <button
            onClick={clear}
            disabled={busy}
            className="ml-auto rounded-lg px-2.5 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/50 cursor-pointer"
          >
            Clear hold
          </button>
        )}
      </div>
    </Dialog>
  );
}

// What the library currently reports for this book. The wait is OverDrive's own
// estimate from the holds queue, so it is a guess that moves — say so rather
// than presenting it as the answer.
function AvailabilityNote({ state, avail, seeded }) {
  const cls = "mb-3 text-xs";
  if (state === "loading") {
    return <p className={`${cls} text-zinc-400 dark:text-zinc-500`}>Checking your library&rsquo;s wait time…</p>;
  }
  if (state === "error") {
    return (
      <p className={`${cls} text-zinc-400 dark:text-zinc-500`}>
        Couldn&rsquo;t reach your library just now — enter the wait from the Libby page.
      </p>
    );
  }
  if (state === "idle") {
    return seeded ? (
      <p className={`${cls} text-zinc-500 dark:text-zinc-400`}>
        Libby reported roughly this wait — adjust it if the hold screen said otherwise.
      </p>
    ) : null;
  }
  if (!avail?.owned) {
    return <p className={`${cls} text-zinc-400 dark:text-zinc-500`}>Your library doesn&rsquo;t appear to carry this one.</p>;
  }
  if (avail.available) {
    return (
      <p className={`${cls} text-emerald-600 dark:text-emerald-400`}>
        Available now at your library — you may be able to borrow it instead of holding.
      </p>
    );
  }
  const detail = [
    avail.holds ? `${avail.holds} hold${avail.holds === 1 ? "" : "s"}` : null,
    avail.copies ? `${avail.copies} cop${avail.copies === 1 ? "y" : "ies"}` : null,
  ].filter(Boolean).join(" on ");
  return (
    <p className={`${cls} text-zinc-500 dark:text-zinc-400`}>
      Your library estimates{" "}
      <strong className="text-zinc-700 dark:text-zinc-300">
        {avail.waitDays != null ? `~${avail.waitDays} days` : "a wait"}
      </strong>
      {detail ? ` (${detail})` : ""} — it&rsquo;s an estimate, so adjust if the hold screen said otherwise.
    </p>
  );
}

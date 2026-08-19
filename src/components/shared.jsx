// Small shared UI primitives: stars, chips, dialogs, toasts, covers, buttons.
import { useState, useEffect } from "react";
import { placeholderHue, STATUS_SHORT } from "../lib/bookUtils.js";

// ---- half-star rating widget ----
export function Stars({ rating, onChange, size = "text-base" }) {
  const [hover, setHover] = useState(0);
  const value = hover || Number(rating) || 0;
  const star = (i) => {
    const fill = Math.max(0, Math.min(1, value - (i - 1)));
    return (
      <span key={i} className={`relative inline-block ${size} leading-none select-none`}>
        <span className="text-zinc-300 dark:text-zinc-700">★</span>
        <span
          className="absolute inset-0 overflow-hidden text-accent-500"
          style={{ width: `${fill * 100}%` }}
        >★</span>
        {onChange && (
          <>
            <span
              className="absolute inset-y-0 left-0 w-1/2 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); onChange(i - 0.5); }}
              onMouseEnter={() => setHover(i - 0.5)}
              onMouseLeave={() => setHover(0)}
            />
            <span
              className="absolute inset-y-0 right-0 w-1/2 cursor-pointer"
              onClick={(e) => { e.stopPropagation(); onChange(i); }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(0)}
            />
          </>
        )}
      </span>
    );
  };
  return <span className="inline-flex gap-px items-center">{[1, 2, 3, 4, 5].map(star)}</span>;
}

// ---- status chip ----
const CHIP_STYLES = {
  read: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  reading: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400",
  wanttoread: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-400",
  recommended: "bg-accent-100 text-accent-700 dark:bg-accent-700/20 dark:text-accent-400",
  dnf: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export function StatusChip({ status, className = "" }) {
  if (!status) return null;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase ${CHIP_STYLES[status] ?? CHIP_STYLES.dnf} ${className}`}>
      {STATUS_SHORT[status] ?? status}
    </span>
  );
}

// ---- cover image with placeholder fallback ----
export function Cover({ book, className = "", rounded = "rounded-md" }) {
  const [failed, setFailed] = useState(false);
  if (book.cover_url && !failed) {
    return (
      <img
        src={book.cover_url}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={`object-cover ${rounded} ${className}`}
      />
    );
  }
  const hue = placeholderHue(book.title);
  return (
    <div
      className={`flex items-center justify-center ${rounded} ${className}`}
      style={{ background: `linear-gradient(145deg, hsl(${hue} 35% 38%), hsl(${hue} 45% 22%))` }}
    >
      <span className="text-white/85 text-center text-[11px] leading-tight px-1.5 line-clamp-4">
        {book.title}
      </span>
    </div>
  );
}

// ---- modal dialog ----
export function Dialog({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`animate-fade-up w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-zinc-300/90 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900`}>
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

// ---- buttons & inputs ----
export const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent-500 px-3.5 py-2 text-sm font-semibold text-zinc-900 shadow-sm transition hover:bg-accent-400 disabled:opacity-50 disabled:cursor-default cursor-pointer";
export const btnSecondary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3.5 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50 cursor-pointer";
export const btnDanger =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950 cursor-pointer";
export const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
export const labelCls = "mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-600 dark:text-zinc-400";

// <select> needs appearance-none (Safari's native control box doesn't honor
// padding/line-height the way <input>'s does, so it renders a different
// height than a same-classed input) plus a hand-drawn arrow to replace the
// one that removes. Pair with `style={selectArrowStyle}` on every <select>.
export const selectCls = `${inputCls} appearance-none pr-8 cursor-pointer`;
export const selectArrowStyle = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20fill='none'%20viewBox='0%200%2020%2020'%3E%3Cpath%20stroke='%2371717a'%20stroke-linecap='round'%20stroke-linejoin='round'%20stroke-width='1.5'%20d='M6%208l4%204%204-4'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 0.6rem center",
  backgroundSize: "1rem",
};

// Small amber toggle pill used by the "How to ..." disclosures in Settings and
// the onboarding wizard. Amber in both states so it reads as an offer of help
// rather than disabled chrome; the open state fills in.
export function pillToggle(active) {
  return `rounded-full border px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
    active
      ? "border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-700/15 dark:text-accent-400"
      : "border-accent-500/50 text-accent-700 hover:border-accent-500 hover:bg-accent-50 dark:text-accent-400 dark:hover:bg-accent-700/10"
  }`;
}

export function Spinner({ className = "h-4 w-4" }) {
  return (
    <span className={`inline-block ${className} rounded-full border-2 border-current border-t-transparent`} style={{ animation: "spin 0.7s linear infinite" }} />
  );
}

// ---- toast ----
export function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 animate-fade-up rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${
      toast.isError
        ? "bg-red-600 text-white"
        : "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
    }`}>
      {toast.text}
    </div>
  );
}

// ---- inline confirm ----
// confirmLabel defaults to DELETE because that is what every existing caller is
// confirming; pass it when the action is something else (revoking a token, say)
// so the button names the thing it actually does.
export function ConfirmRow({ message, onConfirm, onCancel, confirmLabel = "DELETE" }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="flex-1 text-red-600 dark:text-red-400">{message}</span>
      <button onClick={onConfirm} className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-bold text-white hover:bg-red-700 cursor-pointer">{confirmLabel}</button>
      <button onClick={onCancel} className="rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700 cursor-pointer">Cancel</button>
    </div>
  );
}

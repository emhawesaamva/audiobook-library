// Libby availability caching: which books need a lookup, and how an OverDrive
// response becomes the three states we store. See the migration comment for why
// there are three and not four.
import { hasHold } from "./bookUtils.js";

export const LIBBY_STATES = ["available", "wait", "absent"];

// A day. Availability moves as copies are returned and holds placed, but not so
// fast that a fresher number would change any decision the user makes.
export const LIBBY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Only these statuses get looked up: a book you have finished or are listening
// to raises no "can I borrow this?" question.
export const LIBBY_TRACKED_STATUSES = ["recommended", "wanttoread"];

// Maps the OverDrive response our /api/metadata returns. `null`/absent result
// means the search matched nothing, which is the 'absent' state.
export function toLibbyState(avail) {
  if (!avail?.owned) return { libby_state: "absent", libby_wait_days: null };
  if (avail.available) return { libby_state: "available", libby_wait_days: 0 };
  // Their estimate is occasionally absent even when copies are all out; the
  // state still tells the user what they need, so keep it and drop the number.
  // Guard null/"" explicitly — Number(null) is 0, which is finite, and would
  // render a missing estimate as "~0d wait", i.e. available now.
  const raw = avail.waitDays;
  const days = raw == null || raw === "" ? NaN : Number(raw);
  return {
    libby_state: "wait",
    libby_wait_days: Number.isFinite(days) ? days : null,
  };
}

export function isLibbyStale(book, now = Date.now(), maxAgeMs = LIBBY_MAX_AGE_MS) {
  if (!book?.libby_checked_at) return true;
  const t = new Date(book.libby_checked_at).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t >= maxAgeMs;
}

// Books worth a lookup right now: tracked status, stale, and not a series
// header (headers have no status of their own).
export function booksNeedingLibbyCheck(books, { now = Date.now(), limit = Infinity } = {}) {
  const out = [];
  for (const b of books) {
    const candidates = b.is_series ? (b.books ?? []) : [b];
    for (const c of candidates) {
      if (!LIBBY_TRACKED_STATUSES.includes(c.status)) continue;
      if (!isLibbyStale(c, now)) continue;
      out.push(c);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Short label for the badge. Days rather than weeks under a fortnight, because
// "3 days" and "13 days" are different decisions; beyond that weeks read better.
export function libbyBadge(book) {
  // A recorded hold outranks whatever the catalogue says: you have already
  // acted, so "available" or "12w wait" is no longer the useful fact.
  if (hasHold(book)) return { tone: "hold", text: "Libby on hold" };
  switch (book?.libby_state) {
    case "available":
      return { tone: "available", text: "Libby · available" };
    case "wait": {
      const d = book.libby_wait_days;
      if (d == null) return { tone: "wait", text: "Libby · wait" };
      if (d < 14) return { tone: "wait", text: `Libby · ~${d}d wait` };
      return { tone: "wait", text: `Libby · ~${Math.round(d / 7)}w wait` };
    }
    case "absent":
      // The library doesn't carry it (and OverDrive search cannot tell us
      // whether anyone does), so the actionable read is: buy it instead.
      return { tone: "absent", text: "Audible only" };
    default:
      return null;
  }
}

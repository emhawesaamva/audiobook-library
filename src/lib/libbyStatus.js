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

// Weeks to prefill the hold form with, from a live availability response — null
// meaning "don't answer for them".
//
// Available now is the case worth spelling out: OverDrive reports it as
// estimatedWaitDays 0, which is a number, so it passes a null check and then
// rounds up through the >0 floor that hold_weeks needs into a suggested 1-week
// hold. The form would sit there primed to record a hold on a book that is on
// the shelf, one keystroke away, directly under a note saying borrow it instead.
export function suggestedHoldWeeks(avail) {
  if (!avail?.owned || avail.available) return null;
  // Same coercion as toLibbyState: a missing estimate can arrive as null or "",
  // and Number(null) is 0, which would read as "available" all over again.
  const raw = avail.waitDays;
  const days = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(days)) return null;
  // Whole weeks, and hold_weeks has to be > 0 — so a genuine wait shorter than
  // a week is a one-week hold rather than none.
  return Math.max(1, Math.ceil(days / 7));
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

// Short label for the badge, split in two. `base` is what the pill always says;
// `wait` is the estimate, which the pill only has room for on wider screens —
// below the `sm` breakpoint it moves into the card's action menu instead.
// Days rather than weeks under a fortnight, because "3 days" and "13 days" are
// different decisions; beyond that weeks read better.
export function libbyBadge(book) {
  // Same gate as the lookup itself: borrowing is only a live question for books
  // you are still deciding on. Once one is being listened to, finished or
  // abandoned, whatever we last cached about it says nothing worth showing —
  // including a leftover hold, which borrowing has already resolved. Series
  // headers are never looked up either; availability belongs to each volume.
  if (!book || book.is_series) return null;
  if (!LIBBY_TRACKED_STATUSES.includes(book.status)) return null;
  // A recorded hold outranks whatever the catalogue says: you have already
  // acted, so "available" or "12w wait" is no longer the useful fact.
  if (hasHold(book)) return { tone: "hold", base: "Libby on hold", wait: null };
  switch (book?.libby_state) {
    case "available":
      // No qualifier: the tone already says available, and on a phone-width card
      // the extra word is the difference between fitting and not.
      return { tone: "available", base: "Libby", wait: null };
    case "wait": {
      const d = book.libby_wait_days;
      if (d == null) return { tone: "wait", base: "Libby", wait: "wait" };
      if (d < 14) return { tone: "wait", base: "Libby", wait: `~${d}d wait` };
      return { tone: "wait", base: "Libby", wait: `~${Math.round(d / 7)}w wait` };
    }
    case "absent":
      // The library doesn't carry it (and OverDrive search cannot tell us
      // whether anyone does), so the actionable read is: buy it instead.
      return { tone: "absent", base: "Audible only", wait: null };
    default:
      return null;
  }
}

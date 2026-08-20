// Libby availability caching: state mapping, staleness, badge text. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  toLibbyState, isLibbyStale, booksNeedingLibbyCheck, libbyBadge, suggestedHoldWeeks, LIBBY_MAX_AGE_MS,
} from "../src/lib/libbyStatus.js";

test("toLibbyState maps the three OverDrive outcomes", () => {
  assert.deepEqual(
    toLibbyState({ owned: true, available: true, waitDays: 0 }),
    { libby_state: "available", libby_wait_days: 0 }
  );
  assert.deepEqual(
    toLibbyState({ owned: true, available: false, waitDays: 19 }),
    { libby_state: "wait", libby_wait_days: 19 }
  );
  // Search matched nothing — the library does not own it. Indistinguishable
  // from "not in OverDrive at all" via this endpoint, hence one state.
  assert.deepEqual(
    toLibbyState({ owned: false }),
    { libby_state: "absent", libby_wait_days: null }
  );
  assert.deepEqual(toLibbyState(null), { libby_state: "absent", libby_wait_days: null });
});

test("toLibbyState keeps the wait state when the estimate is missing", () => {
  assert.deepEqual(
    toLibbyState({ owned: true, available: false, waitDays: null }),
    { libby_state: "wait", libby_wait_days: null }
  );
});

test("isLibbyStale treats never-checked and day-old as stale", () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  assert.equal(isLibbyStale({}, now), true, "never checked");
  assert.equal(isLibbyStale({ libby_checked_at: "not a date" }, now), true, "unparseable");
  assert.equal(isLibbyStale({ libby_checked_at: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(isLibbyStale({ libby_checked_at: new Date(now - LIBBY_MAX_AGE_MS).toISOString() }, now), true);
});

test("booksNeedingLibbyCheck picks only tracked, stale, non-header books", () => {
  const fresh = new Date().toISOString();
  const books = [
    { id: "a", status: "wanttoread" },                              // stale, tracked
    { id: "b", status: "recommended", libby_checked_at: fresh },    // fresh
    { id: "c", status: "read" },                                    // untracked
    { id: "d", status: "reading" },                                 // untracked
    { id: "e", is_series: true, books: [
      { id: "e1", status: "wanttoread" },                           // tracked child
      { id: "e2", status: "read" },
    ] },
  ];
  assert.deepEqual(booksNeedingLibbyCheck(books).map((b) => b.id), ["a", "e1"]);
});

test("booksNeedingLibbyCheck honours the per-visit cap", () => {
  const books = Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, status: "wanttoread" }));
  assert.equal(booksNeedingLibbyCheck(books, { limit: 4 }).length, 4);
});

// Every badge case below is a book still up for grabs; `waiting` supplies the
// status the pill is gated on so each test can speak about availability alone.
const waiting = (extra) => ({ status: "wanttoread", ...extra });

test("libbyBadge switches from days to weeks at a fortnight", () => {
  assert.equal(libbyBadge(waiting({ libby_state: "wait", libby_wait_days: 3 })).wait, "~3d wait");
  assert.equal(libbyBadge(waiting({ libby_state: "wait", libby_wait_days: 13 })).wait, "~13d wait");
  assert.equal(libbyBadge(waiting({ libby_state: "wait", libby_wait_days: 14 })).wait, "~2w wait");
  assert.equal(libbyBadge(waiting({ libby_state: "wait", libby_wait_days: 160 })).wait, "~23w wait");
  assert.equal(libbyBadge(waiting({ libby_state: "wait", libby_wait_days: null })).wait, "wait");
});

// The pill renders `base` at every width and appends `wait` only from `sm` up,
// so a waiting book must carry the estimate in `wait` and nowhere else —
// otherwise a phone-width card would still show it.
test("libbyBadge keeps the wait estimate out of the always-shown label", () => {
  for (const d of [3, 13, 14, 160, null]) {
    assert.equal(libbyBadge(waiting({ libby_state: "wait", libby_wait_days: d })).base, "Libby");
  }
});

test("libbyBadge covers the other states, and nothing when unchecked", () => {
  assert.deepEqual(libbyBadge(waiting({ libby_state: "available" })), { tone: "available", base: "Libby", wait: null });
  assert.deepEqual(libbyBadge(waiting({ libby_state: "absent" })), { tone: "absent", base: "Audible only", wait: null });
  assert.equal(libbyBadge(waiting({})), null);
  assert.equal(libbyBadge({}), null);
  assert.equal(libbyBadge(null), null);
});

// "Can I borrow this?" is only a live question while you are still choosing.
// Cached availability outlives the decision, so the pill has to be gated on
// status rather than on whether a state was ever stored.
test("libbyBadge says nothing once the book leaves the deciding statuses", () => {
  for (const status of ["reading", "read", "dnf"]) {
    assert.equal(libbyBadge({ status, libby_state: "available" }), null, status);
    assert.equal(libbyBadge({ status, libby_state: "wait", libby_wait_days: 30 }), null, status);
    assert.equal(libbyBadge({ status, libby_state: "absent" }), null, status);
    // Borrowing clears the hold, but a stale one must not resurrect the pill.
    assert.equal(libbyBadge({ status, hold_weeks: 8, hold_date: "2026-08-01" }), null, status);
  }
  assert.equal(libbyBadge({ status: "recommended", libby_state: "available" }).base, "Libby");
});

// A series header has no status of its own — it inherits from its volumes, and
// is never looked up, so it has nothing to show either way.
test("libbyBadge stays quiet on series headers", () => {
  const series = { is_series: true, status: null, libby_state: "available", books: [{ status: "wanttoread" }] };
  assert.equal(libbyBadge(series), null);
});

test("a recorded hold outranks whatever the catalogue says", () => {
  const held = { status: "wanttoread", hold_weeks: 8, hold_date: "2026-08-01" };
  assert.equal(libbyBadge(held).base, "Libby on hold");
  assert.equal(libbyBadge({ ...held, libby_state: "available" }).base, "Libby on hold");
  const stillHeld = libbyBadge({ ...held, libby_state: "wait", libby_wait_days: 30 });
  assert.equal(stillHeld.base, "Libby on hold");
  assert.equal(stillHeld.wait, null); // the catalogue's estimate is dropped, not carried into the menu
  assert.equal(libbyBadge({ ...held, libby_state: "absent" }).base, "Libby on hold");
});

test("a half-written or cleared hold does not claim one", () => {
  assert.equal(libbyBadge(waiting({ hold_weeks: 8, hold_date: null, libby_state: "absent" })).base, "Audible only");
  assert.equal(libbyBadge(waiting({ hold_weeks: null, hold_date: "2026-08-01", libby_state: "available" })).base, "Libby");
});

// ---- suggestedHoldWeeks ----

// The one that bit: OverDrive reports a copy on the shelf as estimatedWaitDays 0.
// It is a number, so it survives a null check, and the >0 floor hold_weeks needs
// then turns it into a suggested one-week hold — on a book you could just borrow.
test("suggestedHoldWeeks suggests nothing for a book that is available now", () => {
  assert.equal(suggestedHoldWeeks({ owned: true, available: true, waitDays: 0 }), null);
});

test("suggestedHoldWeeks suggests nothing when the library has not got it", () => {
  assert.equal(suggestedHoldWeeks({ owned: false }), null);
  assert.equal(suggestedHoldWeeks(null), null);
  assert.equal(suggestedHoldWeeks(undefined), null);
});

test("suggestedHoldWeeks rounds a real wait up to whole weeks", () => {
  const weeks = (waitDays) => suggestedHoldWeeks({ owned: true, available: false, waitDays });
  assert.equal(weeks(19), 3);
  assert.equal(weeks(14), 2);
  assert.equal(weeks(84), 12);
});

// A wait shorter than a week is still a wait, and hold_weeks cannot be 0.
test("suggestedHoldWeeks floors a sub-week wait at one week", () => {
  assert.equal(suggestedHoldWeeks({ owned: true, available: false, waitDays: 3 }), 1);
  assert.equal(suggestedHoldWeeks({ owned: true, available: false, waitDays: 1 }), 1);
});

// No estimate is not the same as no wait — leave the field for the user rather
// than inventing a number. Guard the coercion too: Number(null) is 0.
test("suggestedHoldWeeks suggests nothing when the estimate is missing", () => {
  assert.equal(suggestedHoldWeeks({ owned: true, available: false, waitDays: null }), null);
  assert.equal(suggestedHoldWeeks({ owned: true, available: false, waitDays: "" }), null);
  assert.equal(suggestedHoldWeeks({ owned: true, available: false }), null);
  assert.equal(suggestedHoldWeeks({ owned: true, available: false, waitDays: "not a number" }), null);
});

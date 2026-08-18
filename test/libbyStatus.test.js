// Libby availability caching: state mapping, staleness, badge text. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  toLibbyState, isLibbyStale, booksNeedingLibbyCheck, libbyBadge, LIBBY_MAX_AGE_MS,
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

test("libbyBadge switches from days to weeks at a fortnight", () => {
  assert.equal(libbyBadge({ libby_state: "wait", libby_wait_days: 3 }).text, "Libby · ~3d wait");
  assert.equal(libbyBadge({ libby_state: "wait", libby_wait_days: 13 }).text, "Libby · ~13d wait");
  assert.equal(libbyBadge({ libby_state: "wait", libby_wait_days: 14 }).text, "Libby · ~2w wait");
  assert.equal(libbyBadge({ libby_state: "wait", libby_wait_days: 160 }).text, "Libby · ~23w wait");
  assert.equal(libbyBadge({ libby_state: "wait", libby_wait_days: null }).text, "Libby · wait");
});

test("libbyBadge covers the other states, and nothing when unchecked", () => {
  assert.equal(libbyBadge({ libby_state: "available" }).text, "Libby · available");
  assert.equal(libbyBadge({ libby_state: "absent" }).text, "Audible only");
  assert.equal(libbyBadge({}), null);
  assert.equal(libbyBadge(null), null);
});

test("a recorded hold outranks whatever the catalogue says", () => {
  const held = { hold_weeks: 8, hold_date: "2026-08-01" };
  assert.equal(libbyBadge(held).text, "Libby on hold");
  assert.equal(libbyBadge({ ...held, libby_state: "available" }).text, "Libby on hold");
  assert.equal(libbyBadge({ ...held, libby_state: "wait", libby_wait_days: 30 }).text, "Libby on hold");
  assert.equal(libbyBadge({ ...held, libby_state: "absent" }).text, "Libby on hold");
});

test("a half-written or cleared hold does not claim one", () => {
  assert.equal(libbyBadge({ hold_weeks: 8, hold_date: null, libby_state: "absent" }).text, "Audible only");
  assert.equal(libbyBadge({ hold_weeks: null, hold_date: "2026-08-01", libby_state: "available" }).text, "Libby · available");
});

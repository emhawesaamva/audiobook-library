// Hold countdown math for the Holds tab. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { hasHold, holdWeeksLeft, holdGroupLabel } from "../src/lib/bookUtils.js";

// Local-midnight ISO date `days` from today, matching how holds are stamped.
function daysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const held = (weeks, placedDaysAgo) => ({ hold_weeks: weeks, hold_date: daysAgo(placedDaysAgo) });

test("hasHold requires both columns", () => {
  assert.equal(hasHold(held(10, 0)), true);
  assert.equal(hasHold({ hold_weeks: 10, hold_date: null }), false);
  assert.equal(hasHold({ hold_weeks: null, hold_date: "2026-01-01" }), false);
  assert.equal(hasHold({ hold_weeks: 0, hold_date: "2026-01-01" }), false);
  assert.equal(hasHold({}), false);
  assert.equal(hasHold(null), false);
});

test("holdWeeksLeft counts down from the date the hold was placed", () => {
  // The spec's example: 10 weeks, placed 2 weeks ago, reads 8.
  assert.equal(holdWeeksLeft(held(10, 14)), 8);
  assert.equal(holdWeeksLeft(held(10, 0)), 10);
  assert.equal(holdWeeksLeft(held(1, 0)), 1);
});

test("holdWeeksLeft rounds partial weeks up so a wait never reads short", () => {
  // 10 weeks placed 10 days ago = 60 days left, which is 8.57 weeks.
  assert.equal(holdWeeksLeft(held(10, 10)), 9);
  // One day into a 4-week hold still has 4 weeks to go, not 3.
  assert.equal(holdWeeksLeft(held(4, 1)), 4);
});

test("holdWeeksLeft floors at zero once the estimate elapses", () => {
  assert.equal(holdWeeksLeft(held(10, 70)), 0);
  assert.equal(holdWeeksLeft(held(10, 200)), 0, "long-expired holds stay at zero, never negative");
});

test("holdWeeksLeft is null without a hold", () => {
  assert.equal(holdWeeksLeft({}), null);
  assert.equal(holdWeeksLeft({ hold_weeks: 5, hold_date: null }), null);
});

test("holdGroupLabel names each Holds-tab section", () => {
  assert.equal(holdGroupLabel(0), "These may be ready now");
  assert.equal(holdGroupLabel(1), "1 week");
  assert.equal(holdGroupLabel(8), "8 weeks");
});

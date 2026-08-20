import test from "node:test";
import assert from "node:assert/strict";
import {
  getStatus,
  calcSeriesRating,
  fmtDuration,
  fmtHours,
  listenedMinutes,
  flattenBooks,
  titleKey,
  sameTitle,
  audibleSearchUrl,
  libbySearchUrl,
  goodreadsSearchUrl,
  placeholderHue,
  cleanBookFields,
  withStatusEffects,
} from "../src/lib/bookUtils.js";

// ---- getStatus ----

test("getStatus returns the book's own status for a non-series row", () => {
  assert.equal(getStatus({ status: "read" }), "read");
});

test("getStatus returns the book's own status for a series with no children", () => {
  assert.equal(getStatus({ is_series: true, status: "wanttoread", books: [] }), "wanttoread");
});

test("getStatus derives from children in priority order: reading > all-read > wanttoread > recommended > dnf", () => {
  const series = (statuses) => ({ is_series: true, status: "fallback", books: statuses.map((status) => ({ status })) });
  assert.equal(getStatus(series(["read", "reading", "dnf"])), "reading");
  assert.equal(getStatus(series(["read", "read"])), "read");
  assert.equal(getStatus(series(["read", "wanttoread"])), "wanttoread");
  assert.equal(getStatus(series(["dnf", "recommended"])), "recommended");
  assert.equal(getStatus(series(["dnf"])), "dnf");
});

test("getStatus falls back to the series row's own status when no child matches any rule", () => {
  assert.equal(getStatus({ is_series: true, status: "fallback", books: [{ status: undefined }] }), "fallback");
});

// ---- calcSeriesRating ----

test("calcSeriesRating returns the row's own rating for a non-series book", () => {
  assert.equal(calcSeriesRating({ rating: 4.5 }), 4.5);
  assert.equal(calcSeriesRating({ rating: null }), 0);
});

test("calcSeriesRating averages only rated children, rounded to one decimal", () => {
  assert.equal(calcSeriesRating({ is_series: true, books: [{ rating: 4 }, { rating: 5 }, { rating: 0 }] }), 4.5);
  assert.equal(calcSeriesRating({ is_series: true, books: [{ rating: 4 }, { rating: 4 }, { rating: 5 }] }), 4.3);
});

test("calcSeriesRating is 0 for a series with no children or no rated children", () => {
  assert.equal(calcSeriesRating({ is_series: true, books: [] }), 0);
  assert.equal(calcSeriesRating({ is_series: true, books: [{ rating: null }, { rating: 0 }] }), 0);
});

// ---- fmtDuration / fmtHours ----

test("fmtDuration formats hours and minutes, omitting whichever is zero", () => {
  assert.equal(fmtDuration(125), "2h 5m");
  assert.equal(fmtDuration(60), "1h");
  assert.equal(fmtDuration(45), "45m");
  assert.equal(fmtDuration(0), null);
  assert.equal(fmtDuration(null), null);
});

test("fmtHours rounds to whole numbers past 600 minutes, one decimal below", () => {
  assert.equal(fmtHours(0), "0");
  assert.equal(fmtHours(125), "2.1");
  assert.equal(fmtHours(700), "12");
});

// ---- listenedMinutes ----

test("listenedMinutes only counts finished, timed books", () => {
  assert.equal(listenedMinutes({ status: "read", duration_minutes: 600 }), 600);
  assert.equal(listenedMinutes({ status: "wanttoread", duration_minutes: 600 }), 0);
  assert.equal(listenedMinutes({ status: "read", duration_minutes: null }), 0);
});

test("listenedMinutes sums read children of a series", () => {
  const series = {
    is_series: true,
    books: [
      { status: "read", duration_minutes: 600 },
      { status: "wanttoread", duration_minutes: 500 },
      { status: "read", duration_minutes: 300 },
    ],
  };
  assert.equal(listenedMinutes(series), 900);
});

test("listenedMinutes filters by the finish year when given one", () => {
  const book = { status: "read", duration_minutes: 600, date_finished: "2025-03-01" };
  assert.equal(listenedMinutes(book, 2025), 600);
  assert.equal(listenedMinutes(book, 2024), 0);
});

test("listenedMinutes multiplies by re-listens", () => {
  assert.equal(listenedMinutes({ status: "read", duration_minutes: 100, reread_count: 2 }), 300);
});

// ---- flattenBooks ----

test("flattenBooks expands series into their children and leaves standalone books alone", () => {
  const standalone = { title: "Dune" };
  const series = { title: "Mistborn", is_series: true, books: [{ title: "Vol 1" }, { title: "Vol 2" }] };
  assert.deepEqual(flattenBooks([standalone, series]), [standalone, { title: "Vol 1" }, { title: "Vol 2" }]);
});

// ---- titleKey / sameTitle ----

test("titleKey lowercases, drops subtitles and leading articles, strips punctuation", () => {
  assert.equal(titleKey("The Hobbit"), "hobbit");
  assert.equal(titleKey("Mistborn: The Final Empire"), "mistborn");
  assert.equal(titleKey("A Wizard of Earthsea"), "wizard of earthsea");
  assert.equal(titleKey(null), "");
  assert.equal(titleKey(undefined), "");
});

test("sameTitle matches equal keys and long prefixes, not short ones", () => {
  assert.equal(sameTitle("Dune", "Dune: Part Two"), true);
  assert.equal(sameTitle("Mistborn", "Mistborn Trilogy"), true);
  assert.equal(sameTitle("Emma", "Emily"), false);
  assert.equal(sameTitle("Dune", "Doon"), false);
  assert.equal(sameTitle("", "Dune"), false);
});

// ---- URL builders ----

test("audibleSearchUrl builds a keyword search, plus-encoded, with an optional affiliate tag", () => {
  const book = { title: "Dune", author: "Frank Herbert" };
  assert.equal(audibleSearchUrl(book), "https://www.audible.com/search?keywords=Dune+Frank+Herbert");
  assert.equal(
    audibleSearchUrl(book, "mytag-20"),
    "https://www.audible.com/search?keywords=Dune+Frank+Herbert&tag=mytag-20"
  );
});

test("audibleSearchUrl tolerates a missing author", () => {
  assert.equal(audibleSearchUrl({ title: "Dune" }), "https://www.audible.com/search?keywords=Dune");
});

test("libbySearchUrl targets a specific library when given a key, else OverDrive's universal search", () => {
  const book = { title: "Dune", author: "Frank Herbert" };
  assert.equal(
    libbySearchUrl(book, "lapl"),
    "https://libbyapp.com/search/lapl/search/scope-auto/audiobooks/query-Dune%20Frank%20Herbert/language-en/page-1"
  );
  assert.equal(libbySearchUrl(book, null), "https://www.overdrive.com/search?q=Dune%20Frank%20Herbert");
});

test("goodreadsSearchUrl prefers a stored URL over building a search link", () => {
  assert.equal(goodreadsSearchUrl({ goodreads_url: "https://www.goodreads.com/book/123" }), "https://www.goodreads.com/book/123");
  assert.equal(
    goodreadsSearchUrl({ title: "Dune", author: "Frank Herbert" }),
    "https://www.goodreads.com/search?q=Dune%20Frank%20Herbert"
  );
});

// ---- placeholderHue ----

test("placeholderHue is deterministic for the same title", () => {
  assert.equal(placeholderHue("Dune"), placeholderHue("Dune"));
  assert.notEqual(placeholderHue("Dune"), undefined);
});

test("placeholderHue falls back to the first hue for an empty/missing title", () => {
  assert.equal(placeholderHue(""), placeholderHue(null));
  assert.equal(placeholderHue(null), placeholderHue(undefined));
});

// ---- cleanBookFields (write-path shaping used by db.js before every insert/update) ----

test("cleanBookFields drops keys outside the known book columns", () => {
  const out = cleanBookFields({ title: "Dune", not_a_column: "x", id: "ignored-here" });
  assert.deepEqual(out, { title: "Dune" });
});

test("cleanBookFields coerces empty strings to null", () => {
  const out = cleanBookFields({ title: "Dune", narrator: "", notes: "" });
  assert.deepEqual(out, { title: "Dune", narrator: null, notes: null });
});

test("cleanBookFields forces rating and status to null on series headers", () => {
  const out = cleanBookFields({ is_series: true, title: "The Malazan Book of the Fallen", rating: 4.5, status: "read" });
  assert.equal(out.rating, null);
  assert.equal(out.status, null);
});

test("cleanBookFields nulls out non-positive or non-numeric ratings on non-series rows", () => {
  assert.equal(cleanBookFields({ rating: 0 }).rating, null);
  assert.equal(cleanBookFields({ rating: -1 }).rating, null);
  assert.equal(cleanBookFields({ rating: "not a number" }).rating, null);
  assert.equal(cleanBookFields({ rating: 4.5 }).rating, 4.5);
});

// ---- withStatusEffects ----

const NOW = "2026-08-20";

test("withStatusEffects stamps a start date on a book that has just begun", () => {
  assert.equal(withStatusEffects({ status: "reading" }, null, NOW).date_started, NOW);
});

test("withStatusEffects leaves dates the caller supplied alone", () => {
  const out = withStatusEffects({ status: "reading", date_started: "2026-07-01" }, null, NOW);
  assert.equal(out.date_started, "2026-07-01");
});

test("withStatusEffects finishing a book keeps the start date it already had", () => {
  const out = withStatusEffects({ status: "read" }, { date_started: "2026-07-01" }, NOW);
  assert.equal(out.date_finished, NOW);
  assert.equal(out.date_started, "2026-07-01", "carried over from the previous row");
});

// Up Next is what you have yet to start. Moving past that point drops the slot,
// whichever write path did it — otherwise a finished book keeps sitting in the
// queue, because nothing else clears queue_position.
test("withStatusEffects drops the queue slot once a book is started, finished or abandoned", () => {
  const queued = { status: "wanttoread", queue_position: 3 };
  for (const status of ["reading", "read", "dnf"]) {
    assert.equal(withStatusEffects({ ...queued, status }, queued, NOW).queue_position, null, status);
    // Also on a partial patch that never mentioned the queue, as the MCP write
    // tools send: the key has to be added for the slot to actually clear.
    const patch = withStatusEffects({ status }, queued, NOW);
    assert.ok("queue_position" in patch, `${status} patch clears the slot`);
    assert.equal(patch.queue_position, null, status);
  }
});

test("withStatusEffects keeps the queue slot for statuses that are still ahead of you", () => {
  for (const status of ["wanttoread", "recommended"]) {
    assert.equal(withStatusEffects({ status, queue_position: 3 }, null, NOW).queue_position, 3, status);
    assert.ok(!("queue_position" in withStatusEffects({ status }, null, NOW)), `${status} adds no key`);
  }
});

// Queueing a book you have already read is a re-listen — deliberate, and not
// something an unrelated edit should undo. The form round-trips the whole row,
// so every save of that book re-sends status "read" alongside the slot.
test("withStatusEffects keeps the slot when the status was already there", () => {
  const relisten = { status: "read", queue_position: 2, date_finished: "2026-01-01" };
  const out = withStatusEffects({ ...relisten, notes: "worth another go" }, relisten, NOW);
  assert.equal(out.queue_position, 2);
});

// A patch that says nothing about status says nothing about the queue either.
test("withStatusEffects leaves the queue alone when the patch carries no status", () => {
  const out = withStatusEffects({ rating: 5, queue_position: 2 }, { status: "read" }, NOW);
  assert.equal(out.queue_position, 2);
});

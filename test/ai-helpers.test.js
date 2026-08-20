// Pure-helper tests for the AI import functions (no network). The Claude calls
// themselves are thin wrappers; these cover the parsing/validation/merge logic.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { parseMappingResponse, mergeRepairedRows, friendlyAiError } from "../src/lib/ai.js";

test("parseMappingResponse keeps valid fields and drops unknown ones", () => {
  const text = `Here is the mapping:
  {"mapping":{"title":"Book","author":"Writer","status":"Shelf","bogus_field":"X","rating":""},
   "statusMap":{"Done":"read","DNF":"dnf","Mystery":"not-a-status"},
   "note":"status column was ambiguous"}`;
  const { mapping, statusMap, note } = parseMappingResponse(text);
  assert.deepEqual(mapping, { title: "Book", author: "Writer", status: "Shelf" });
  assert.equal(mapping.bogus_field, undefined); // unknown field dropped
  assert.equal(mapping.rating, undefined);       // empty column dropped
  assert.deepEqual(statusMap, { done: "read", dnf: "dnf" }); // lowercased keys, invalid target dropped
  assert.equal(note, "status column was ambiguous");
});

test("parseMappingResponse throws when title is missing or response has no JSON", () => {
  assert.throws(() => parseMappingResponse('{"mapping":{"author":"A"}}'), /title/i);
  assert.throws(() => parseMappingResponse("no json here"), /structure|read/i);
});

test("parseMappingResponse tolerates markdown-fenced JSON", () => {
  const text = "```json\n{\"mapping\":{\"title\":\"T\"}}\n```";
  const { mapping } = parseMappingResponse(text);
  assert.deepEqual(mapping, { title: "T" });
});

test("mergeRepairedRows overlays fixes by flagged index and clears _unparsed", () => {
  const books = [
    { title: "Good", status: "read" },
    { title: "Broken", status: "read", date_finished: null, _unparsed: { date_finished: "13/05/2024" } },
    { title: "AlsoBroken", rating: 99, _unparsed: {} },
  ];
  const flagged = [
    { index: 1, book: books[1], reasons: ["unparseable date_finished"] },
    { index: 2, book: books[2], reasons: ["rating out of range"] },
  ];
  const repaired = [
    { date_finished: "2024-05-13" },
    { rating: null }, // null should NOT overwrite; field stays as-is
  ];
  const out = mergeRepairedRows(books, flagged, repaired);
  assert.equal(out[0].title, "Good");            // untouched
  assert.equal(out[1].date_finished, "2024-05-13");
  assert.equal(out[1]._unparsed, undefined);     // cleared
  assert.equal(out[2].rating, 99);               // null fix ignored (keeps original)
  assert.equal(out[2]._unparsed, undefined);
});

test("mergeRepairedRows ignores null/garbage repaired entries", () => {
  const books = [{ title: "X", _unparsed: { year: "abcd" } }];
  const flagged = [{ index: 0, book: books[0], reasons: ["unparseable year"] }];
  const out = mergeRepairedRows(books, flagged, [null]);
  assert.equal(out[0].title, "X");
  assert.equal(out[0]._unparsed, undefined); // still cleared even with no fix
});

// friendlyAiError: the raw strings below are real ones seen in production. The
// point of the helper is that none of this vendor detail reaches a user, so the
// assertions are as much about what is absent as what is present.
const VENDOR_LEAKS = [/gemini/i, /anthropic/i, /claude/i, /quota/i, /http/i, /gemini-[\d.]+-flash/i, /googleapis/i];

function assertNoVendorDetail(text) {
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0 && text.length < 140, `expected short friendly copy, got: ${text}`);
  for (const re of VENDOR_LEAKS) assert.ok(!re.test(text), `leaked vendor detail (${re}) in: ${text}`);
}

test("friendlyAiError turns an overloaded-model error into busy-service copy", () => {
  const { text, retryable } = friendlyAiError(
    "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later."
  );
  assertNoVendorDetail(text);
  assert.match(text, /busy/i);
  assert.equal(retryable, true);
});

test("friendlyAiError hides the free-tier quota dump behind a wait-a-minute line", () => {
  const raw =
    "You exceeded your current quota, please check your plan and billing details. " +
    "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
    "limit: 5, model: gemini-3.7-flash Please retry in 54.4s.";
  const { text, retryable } = friendlyAiError(raw);
  assertNoVendorDetail(text);
  assert.ok(!text.includes("54.4"), "leaked the vendor's retry-after value");
  assert.match(text, /minute/i);
  assert.equal(retryable, true);
});

test("friendlyAiError never mentions billing when Anthropic credit runs out", () => {
  const { text, retryable } = friendlyAiError(
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
  );
  assertNoVendorDetail(text);
  assert.ok(!/billing|credit|balance/i.test(text), `leaked billing detail: ${text}`);
  assert.match(text, /later/i);
  assert.equal(retryable, true);
});

test("friendlyAiError treats a bad API key as our problem, not a retry", () => {
  const { text, retryable } = friendlyAiError("API key not valid. Please pass a valid API key.");
  assertNoVendorDetail(text);
  assert.ok(!/key/i.test(text), `leaked key detail: ${text}`);
  assert.equal(retryable, false);
});

test("friendlyAiError rewrites our own empty-fallback message", () => {
  const { text, retryable } = friendlyAiError(
    "Gemini fallback returned no content — the whole token budget went on thinking before any answer was written"
  );
  assertNoVendorDetail(text);
  assert.equal(retryable, true);
});

test("friendlyAiError degrades gracefully on unknown, empty, and missing messages", () => {
  for (const input of ["<!DOCTYPE html><title>502 Bad Gateway</title>", "", null, undefined]) {
    const { text, retryable } = friendlyAiError(input);
    assertNoVendorDetail(text);
    assert.ok(!text.includes("DOCTYPE"), "echoed the unknown string verbatim");
    assert.equal(retryable, true);
  }
});

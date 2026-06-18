// Pure-helper tests for the AI import functions (no network). The Claude calls
// themselves are thin wrappers; these cover the parsing/validation/merge logic.
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { parseMappingResponse, mergeRepairedRows } from "../src/lib/ai.js";

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

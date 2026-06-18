// Orchestration tests for the import cascade that do NOT require network:
// the tier-1 (recognized format) happy path and the early error paths.
// The AI-dependent tiers 2/3 are covered by their pure helpers (ai-helpers.test.js)
// and the gated live smoke test (ai-live.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { parseImportFile } from "../src/lib/importPipeline.js";

test("tier 1: a recognized StoryGraph CSV imports without AI", async () => {
  const csv = [
    "Title,Authors,ISBN/UID,Read Status,Last Date Read,Read Count,Star Rating,Tags",
    "Dune,Frank Herbert,9780441013593,read,2024/02/01,1,4.5,classic",
    "Pixelnix,Luna May,B08ZYQT962,to-read,,0,,",
  ].join("\n");
  const r = await parseImportFile(csv, "storygraph_export.csv");
  assert.equal(r.aiUsed, false);
  assert.equal(r.aiMapped, false);
  assert.equal(r.format, "storygraph");
  assert.equal(r.sourceLabel, "StoryGraph");
  assert.equal(r.books.length, 2);
  assert.equal(r.repairedCount, 0);
});

test("tier 1: a recognized Goodreads CSV is labeled correctly", async () => {
  const csv = "Title,Author,Exclusive Shelf,My Rating\nDune,Frank Herbert,read,5";
  const r = await parseImportFile(csv, "goodreads_library_export.csv");
  assert.equal(r.aiUsed, false);
  assert.equal(r.format, "goodreads");
  assert.equal(r.sourceLabel, "Goodreads");
  assert.equal(r.books[0].title, "Dune");
});

test("an unrecognized JSON file fails deterministically without an AI call", async () => {
  // Any JSON is attempted as a Libby/Audible export (detectImportFormat's
  // catch-all). AI mapping is CSV-only, so unknown JSON errors out, no network.
  const r = await parseImportFile('{"something":"else"}', "weird.json");
  assert.equal(r.books.length, 0);
  assert.equal(r.aiUsed, false);
  assert.ok(r.errors[0]); // surfaced a readable error
});

test("an empty file returns a readable error", async () => {
  const r = await parseImportFile("", "empty.csv");
  assert.equal(r.books.length, 0);
  assert.equal(r.aiUsed, false);
  assert.ok(r.errors[0]);
});

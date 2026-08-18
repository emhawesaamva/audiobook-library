// Pure-function tests for the library-update reconciliation core (no network).
// Covers the smart-merge policy (mergeBook) and the classification of a fresh
// import against an existing library (diffImport). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mergeBook, diffImport, formatToSource, runImport } from "../src/lib/importBooks.js";

// ---------- mergeBook ----------

test("mergeBook advances status forward and fills a finish date", () => {
  const { patch, changes } = mergeBook(
    { status: "wanttoread", date_finished: null },
    { status: "read", date_finished: "2026-01-02" },
  );
  assert.equal(patch.status, "read");
  assert.equal(patch.date_finished, "2026-01-02");
  assert.ok(changes.some((c) => c.includes("status")));
});

test("mergeBook never regresses status", () => {
  const { patch, changes } = mergeBook({ status: "read" }, { status: "reading" });
  assert.equal(patch.status, undefined);
  assert.equal(changes.length, 0);
});

test("mergeBook fills empty fields but never overwrites existing ones", () => {
  const { patch } = mergeBook(
    { narrator: "Real Narrator", cover_url: null },
    { narrator: "Wrong Narrator", cover_url: "http://cover" },
  );
  assert.equal(patch.narrator, undefined);          // existing value preserved
  assert.equal(patch.cover_url, "http://cover");     // empty field filled
});

test("mergeBook fills rating only when not hand-set", () => {
  assert.equal(mergeBook({ rating: null }, { rating: 4 }).patch.rating, 4);
  assert.equal(mergeBook({ rating: 5 }, { rating: 3 }).patch.rating, undefined);
});

test("mergeBook takes the max progress and ignores a lower value", () => {
  assert.equal(mergeBook({ progress_percent: 20 }, { progress_percent: 60 }).patch.progress_percent, 60);
  assert.equal(mergeBook({ progress_percent: 80 }, { progress_percent: 30 }).patch.progress_percent, undefined);
});

test("mergeBook never touches user-owned fields", () => {
  const { patch } = mergeBook(
    { notes: "mine", loved: true, tags: ["x"], rating: null },
    { notes: "theirs", loved: false, tags: ["y"], rating: 4 },
  );
  assert.equal(patch.notes, undefined);
  assert.equal(patch.loved, undefined);
  assert.equal(patch.tags, undefined);
  assert.equal(patch.rating, 4); // rating still filled (was empty) — proves only the protected ones are skipped
});

test("mergeBook sets dnf only from an unread state", () => {
  assert.equal(mergeBook({ status: "wanttoread" }, { status: "dnf" }).patch.status, "dnf");
  assert.equal(mergeBook({ status: "read" }, { status: "dnf" }).patch.status, undefined);
});

test("mergeBook produces an empty patch when nothing changes", () => {
  const { patch, changes } = mergeBook(
    { status: "read", rating: 5, narrator: "N", progress_percent: 100 },
    { status: "read", rating: 4, narrator: "N", progress_percent: 100 },
  );
  assert.deepEqual(patch, {});
  assert.equal(changes.length, 0);
});

// ---------- diffImport ----------

const lib = [
  { id: "1", title: "The Hobbit", status: "wanttoread", source: "goodreads" },
  { id: "2", title: "Dune", status: "read", rating: 5, source: "goodreads" },
  {
    id: "s1", is_series: true, title: "Mistborn",
    books: [{ id: "3", title: "The Final Empire", status: "reading", source: "goodreads" }],
  },
];

test("diffImport classifies new, changed, and unchanged", () => {
  const parsed = [
    { title: "The Hobbit", status: "read" },        // changed (status advances)
    { title: "Dune", status: "read", rating: 4 },   // unchanged (rating hand-set, status same)
    { title: "A Brand New Book", status: "wanttoread" }, // new
  ];
  const diff = diffImport(parsed, lib, { source: "goodreads" });
  assert.equal(diff.create.length, 1);
  assert.equal(diff.create[0].title, "A Brand New Book");
  assert.equal(diff.update.length, 1);
  assert.equal(diff.update[0].id, "1");
  assert.equal(diff.unchanged, 1);
});

test("diffImport matches series children via flattenBooks", () => {
  const diff = diffImport([{ title: "The Final Empire", status: "read" }], lib, { source: "goodreads" });
  assert.equal(diff.create.length, 0);
  assert.equal(diff.update.length, 1);
  assert.equal(diff.update[0].id, "3"); // the series child, not the header
});

test("diffImport matches titles ignoring subtitle and articles", () => {
  const diff = diffImport([{ title: "Hobbit: There and Back Again", status: "read" }], lib, { source: "goodreads" });
  assert.equal(diff.update.length, 1);
  assert.equal(diff.update[0].id, "1");
});

test("diffImport reports source books missing from the export", () => {
  const diff = diffImport([{ title: "The Hobbit", status: "wanttoread" }], lib, { source: "goodreads" });
  const missingIds = diff.missing.map((b) => b.id).sort();
  assert.deepEqual(missingIds, ["2", "3"]); // Dune + The Final Empire absent from the export
});

test("diffImport reports no missing books when source is null", () => {
  const diff = diffImport([{ title: "The Hobbit" }], lib);
  assert.equal(diff.missing.length, 0);
});

test("diffImport silently restamps an unchanged book that has no source yet", () => {
  const legacy = [{ id: "9", title: "Old Import", status: "read", rating: 5 /* no source */ }];
  const diff = diffImport([{ title: "Old Import", status: "read", rating: 4 }], legacy, { source: "goodreads" });
  assert.equal(diff.update.length, 0);   // nothing the user sees changed
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.restamp, [{ id: "9", patch: { source: "goodreads" } }]);
});

test("diffImport folds source into a changed book's patch without listing it as a change", () => {
  const legacy = [{ id: "9", title: "Old Import", status: "wanttoread" /* no source */ }];
  const diff = diffImport([{ title: "Old Import", status: "read" }], legacy, { source: "goodreads" });
  assert.equal(diff.update.length, 1);
  assert.equal(diff.update[0].patch.source, "goodreads");           // applied
  assert.ok(!diff.update[0].changes.some((c) => c.includes("source"))); // but never shown
  assert.equal(diff.restamp.length, 0);
});

test("diffImport does not restamp books that already have a source", () => {
  const diff = diffImport([{ title: "Dune", status: "read" }], lib, { source: "goodreads" });
  assert.equal(diff.restamp.length, 0);
});

// ---------- runImport (orchestration, no network: enrich:false) ----------

// A library with one book mid-read (already sourced) and one legacy book with
// no source recorded yet.
const orchLib = [
  { id: "a", title: "In Progress", status: "reading", source: "goodreads" },
  { id: "b", title: "Legacy", status: "read", rating: 5 /* no source */ },
];

function recorder() {
  const calls = { created: null, updated: null };
  return {
    calls,
    onImportBooks: async (rows) => { calls.created = rows; return { seriesCount: 0 }; },
    onUpdateBooks: async (patches) => { calls.updated = patches; },
  };
}

test("runImport routes creates/updates/restamps and stamps source on new books", async () => {
  const { calls, onImportBooks, onUpdateBooks } = recorder();
  const parsed = [
    { title: "In Progress", status: "read" },     // changed (status advances)
    { title: "Legacy", status: "read", rating: 4 }, // unchanged → silent restamp
    { title: "Brand New", status: "wanttoread" },  // new
  ];

  const r = await runImport(parsed, {
    books: orchLib, enrich: false, source: "goodreads", onImportBooks, onUpdateBooks,
  });

  // Summary counts.
  assert.equal(r.imported, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 1);
  assert.equal(r.allExisting, false);

  // New book was created and stamped with the import's source.
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].title, "Brand New");
  assert.equal(calls.created[0].source, "goodreads");

  // Both the visible update and the silent restamp reached onUpdateBooks.
  assert.equal(calls.updated.length, 2);
  const byId = Object.fromEntries(calls.updated.map((u) => [u.id, u.patch]));
  assert.equal(byId.a.status, "read");        // visible field change
  assert.equal(byId.b.source, "goodreads");   // silent provenance backfill
  assert.equal(byId.b.status, undefined);     // and nothing else touched
});

test("runImport reports allExisting and skips callbacks when nothing changes", async () => {
  const { calls, onImportBooks, onUpdateBooks } = recorder();
  // Re-import an already-sourced, unchanged book: no create, no update, no restamp.
  const r = await runImport([{ title: "In Progress", status: "reading" }], {
    books: orchLib, enrich: false, source: "goodreads", onImportBooks, onUpdateBooks,
  });
  assert.equal(r.allExisting, true);
  assert.equal(r.imported, 0);
  assert.equal(r.updated, 0);
  assert.equal(calls.created, null); // onImportBooks not called with an empty set
  assert.equal(calls.updated, null); // onUpdateBooks not called with no patches
});

// ---------- formatToSource ----------

test("formatToSource maps detected formats to stable slugs", () => {
  assert.equal(formatToSource("goodreads"), "goodreads");
  assert.equal(formatToSource("audible-csv"), "audible");
  assert.equal(formatToSource("libby-json"), "libby");
  assert.equal(formatToSource("ai-mapped"), "other");
  assert.equal(formatToSource(null), "other");
});

// Deterministic parser + tier-2/3 primitive tests. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCSV, parseGoodreadsCSV, parseStorygraphCSV, detectImportFormat,
  parseWithMapping, detectMalformedRows, VALID_STATUSES, MAPPABLE_FIELDS,
} from "../src/lib/csv.js";

test("parseCSV handles quotes, escaped quotes, and CRLF", () => {
  const rows = parseCSV('a,b\r\n"x,y","he said ""hi"""\n');
  assert.deepEqual(rows, [["a", "b"], ["x,y", 'he said "hi"']]);
});

// ---- StoryGraph (regression for the import we added) ----
test("parseStorygraphCSV maps the documented columns", () => {
  const csv = [
    "Title,Authors,Contributors,ISBN/UID,Format,Read Status,Date Added,Last Date Read,Dates Read,Read Count,Moods,Pace,Star Rating,Review,Tags,Owned?",
    'Dune,Frank Herbert,,9780441013593,print,read,2024/01/01,2024/02/01,,2,"adventurous, tense",medium,4.5,"Loved it","sci-fi, classic",Yes',
    "Pixelnix,Luna May,,B08ZYQT962,digital,to-read,2026/06/17,,,0,,,,,,No",
  ].join("\n");
  const { books, errors } = parseStorygraphCSV(csv);
  assert.equal(errors.length, 0);
  assert.equal(books.length, 2);

  const dune = books[0];
  assert.equal(dune.title, "Dune");
  assert.equal(dune.author, "Frank Herbert");
  assert.equal(dune.isbn, "9780441013593");
  assert.equal(dune.asin, null);
  assert.equal(dune.status, "read");
  assert.equal(dune.rating, 4.5);
  assert.equal(dune.date_finished, "2024-02-01");
  assert.equal(dune.reread_count, 1); // read count 2 -> 1 reread
  assert.equal(dune.notes, "Loved it");
  assert.deepEqual(dune.tags, ["sci-fi", "classic", "adventurous", "tense"]);

  const pix = books[1];
  assert.equal(pix.status, "wanttoread");
  assert.equal(pix.asin, "B08ZYQT962"); // ISBN/UID that is an ASIN routes to asin
  assert.equal(pix.isbn, null);
  assert.equal(pix.rating, null);
  assert.equal(pix.reread_count, 0);
});

test("parseStorygraphCSV maps did-not-finish to dnf and unknown status to wanttoread", () => {
  const csv = [
    "Title,Read Status,Star Rating",
    "A,did-not-finish,",
    "B,weird-status,",
  ].join("\n");
  const { books } = parseStorygraphCSV(csv);
  assert.equal(books[0].status, "dnf");
  assert.equal(books[1].status, "wanttoread");
});

// ---- format detection ----
test("detectImportFormat recognizes known formats and rejects unknown", () => {
  assert.equal(detectImportFormat("Title,Read Status,Star Rating\nA,read,5"), "storygraph");
  assert.equal(detectImportFormat("Title,Author,Exclusive Shelf\nA,B,read"), "goodreads");
  assert.equal(detectImportFormat("Title,Narrators\nA,Bob"), "audible-csv");
  assert.equal(detectImportFormat("title,activity,timestamp\nA,Borrowed,2024"), "libby");
  // An unknown but tabular CSV must return null so the AI mapping tier triggers.
  assert.equal(detectImportFormat("Book Name,Who Wrote It,Shelf\nDune,Herbert,done"), null);
});

// ---- tier 2: parseWithMapping ----
test("parseWithMapping parses an unknown CSV via an inferred mapping", () => {
  const csv = [
    "Book,Writer,Shelf,Score,Finished,Pub,ID",
    "Dune,Frank Herbert,done,5,2024/01/15,1965,9780441013593",
    "Neuromancer,William Gibson,reading,4,bad-date,1984,B08ZYQT962",
  ].join("\n");
  const mapping = {
    title: "Book", author: "Writer", status: "Shelf", rating: "Score",
    date_finished: "Finished", year: "Pub", isbn: "ID",
  };
  const statusMap = { done: "read", reading: "reading" };
  const { books, errors } = parseWithMapping(csv, { mapping, statusMap });
  assert.equal(errors.length, 0);

  const dune = books[0];
  assert.equal(dune.title, "Dune");
  assert.equal(dune.author, "Frank Herbert");
  assert.equal(dune.status, "read");
  assert.equal(dune.rating, 5);
  assert.equal(dune.date_finished, "2024-01-15");
  assert.equal(dune.year, 1965);
  assert.equal(dune.isbn, "9780441013593");
  assert.equal(dune.asin, null);

  const neuro = books[1];
  assert.equal(neuro.status, "reading");
  assert.equal(neuro.date_finished, null); // "bad-date" couldn't parse
  assert.deepEqual(neuro._unparsed, { date_finished: "bad-date" });
  assert.equal(neuro.asin, "B08ZYQT962"); // ID value is an ASIN -> asin, not isbn
  assert.equal(neuro.isbn, null);
});

test("parseWithMapping coerces human-readable dates and accepts a single-digit month/day", () => {
  const csv = "Book,Done\nA,May 13 2024\nB,2024/3/5";
  const { books } = parseWithMapping(csv, { mapping: { title: "Book", date_finished: "Done" } });
  assert.equal(books[0].date_finished, "2024-05-13");
  assert.equal(books[1].date_finished, "2024-03-05");
});

test("parseWithMapping converts read_count to reread_count and skips empty titles", () => {
  const csv = "Book,Reads\nA,3\n,9\nB,1";
  const { books } = parseWithMapping(csv, { mapping: { title: "Book", read_count: "Reads" } });
  assert.equal(books.length, 2);
  assert.equal(books[0].reread_count, 2);
  assert.equal(books[1].reread_count, 0);
});

test("parseWithMapping errors when no title column is mapped", () => {
  const { books, errors } = parseWithMapping("A,B\n1,2", { mapping: { author: "A" } });
  assert.equal(books.length, 0);
  assert.match(errors[0], /title/i);
});

// ---- tier 3: detectMalformedRows ----
test("detectMalformedRows flags loud problems and leaves clean rows alone", () => {
  const books = [
    { title: "Clean Book", author: "Real Author", status: "read", rating: 4, year: 2010 },
    { title: "Garbled � title", status: "read" },
    { title: "Same", author: "Same", status: "read" },
    { title: "Bad Status", status: "finished-ish" },
    { title: "Bad Rating", rating: 99 },
    { title: "Bad Year", year: 99999 },
    { title: "Has Unparsed", _unparsed: { date_finished: "13/40/2024" } },
  ];
  const flagged = detectMalformedRows(books);
  const flaggedTitles = flagged.map((f) => f.book.title);
  assert.ok(!flaggedTitles.includes("Clean Book"));
  assert.ok(flaggedTitles.includes("Garbled � title"));
  assert.ok(flaggedTitles.includes("Same"));
  assert.ok(flaggedTitles.includes("Bad Status"));
  assert.ok(flaggedTitles.includes("Bad Rating"));
  assert.ok(flaggedTitles.includes("Bad Year"));
  assert.ok(flaggedTitles.includes("Has Unparsed"));
  // indices are preserved for merge-back
  assert.equal(flagged.find((f) => f.book.title === "Same").index, 2);
});

test("detectMalformedRows returns nothing for a fully clean StoryGraph parse", () => {
  const csv = [
    "Title,Authors,ISBN/UID,Read Status,Last Date Read,Read Count,Star Rating",
    "Dune,Frank Herbert,9780441013593,read,2024/02/01,1,4.5",
    "Pixelnix,Luna May,B08ZYQT962,to-read,,0,",
  ].join("\n");
  const { books } = parseStorygraphCSV(csv);
  assert.deepEqual(detectMalformedRows(books), []);
});

// ---- sanity on shared constants ----
test("exported constants are well-formed", () => {
  assert.ok(VALID_STATUSES.includes("read") && VALID_STATUSES.includes("dnf"));
  assert.ok(MAPPABLE_FIELDS.includes("title") && MAPPABLE_FIELDS.includes("read_count"));
});

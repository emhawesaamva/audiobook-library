import test from "node:test";
import assert from "node:assert/strict";
import { resultToBook } from "../src/lib/metadata.js";

test("resultToBook maps a full metadata result onto book-form fields", () => {
  const out = resultToBook({
    title: "Dune",
    author: "Frank Herbert",
    narrator: "Scott Brick",
    duration_minutes: 1260,
    cover_url: "https://covers/dune.jpg",
    year: 1965,
    asin: "B002V5CD24",
    isbn: "9780441013593",
    description: "A desert planet.",
  });
  assert.deepEqual(out, {
    title: "Dune",
    author: "Frank Herbert",
    narrator: "Scott Brick",
    duration_minutes: 1260,
    cover_url: "https://covers/dune.jpg",
    year: 1965,
    asin: "B002V5CD24",
    isbn: "9780441013593",
    description: "A desert planet.",
    series_position: null,
  });
});

test("resultToBook defaults missing string/number fields without throwing", () => {
  const out = resultToBook({});
  assert.equal(out.title, "");
  assert.equal(out.author, "");
  assert.equal(out.narrator, "");
  assert.equal(out.duration_minutes, null);
  assert.equal(out.cover_url, null);
  assert.equal(out.series_position, null);
});

test("resultToBook only sets genre/subgenre when the source detected them", () => {
  const withGenre = resultToBook({ title: "Dune", genre: "Science Fiction", subgenre: "Space Opera" });
  assert.equal(withGenre.genre, "Science Fiction");
  assert.equal(withGenre.subgenre, "Space Opera");

  const without = resultToBook({ title: "Dune" });
  assert.equal("genre" in without, false, "should not clobber an existing genre choice with null");
  assert.equal("subgenre" in without, false);
});

test("resultToBook prefers series.position, falls back to a top-level position, else null", () => {
  assert.equal(resultToBook({ series: { position: 3 } }).series_position, 3);
  assert.equal(resultToBook({ position: 2 }).series_position, 2);
  assert.equal(resultToBook({ series: { position: 3 }, position: 2 }).series_position, 3);
  assert.equal(resultToBook({}).series_position, null);
});

test("resultToBook maps a public rating average onto goodreads_rating, when present", () => {
  const withRating = resultToBook({ public_rating: { average: 4.6, count: 1000 } });
  assert.equal(withRating.goodreads_rating, 4.6);

  const without = resultToBook({});
  assert.equal("goodreads_rating" in without, false);
});

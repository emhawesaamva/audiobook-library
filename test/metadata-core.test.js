import test from "node:test";
import assert from "node:assert/strict";
import { searchBooks, seriesVolumes, libbyAvailability, handleMetadataRequest } from "../api/_lib/metadata-core.js";

function fakeReq(url) {
  return { url };
}
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b; },
    get json() { return JSON.parse(this.body); },
  };
}

// ---- searchBooks: Audible -> Open Library -> iTunes fallback chain ----

test("searchBooks maps an Audible hit, deriving genre/subgenre/rating and filtering non-English + titleless results", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.ok(url.includes("api.audible.com"));
      return {
        ok: true,
        json: async () => ({
          products: [
            {
              asin: "B0001",
              title: "The Fellowship of the Ring",
              authors: [{ name: "J.R.R. Tolkien" }],
              narrators: [{ name: "Rob Inglis" }],
              runtime_length_min: 660,
              product_images: { 500: "https://img/cover.jpg" },
              release_date: "1954-07-29",
              language: "english",
              category_ladders: [
                { ladder: [{ name: "Science Fiction & Fantasy" }, { name: "Fantasy" }, { name: "Epic Fantasy" }] },
              ],
              rating: {
                overall_distribution: {
                  average_rating: 4.789,
                  num_ratings: 5000,
                  num_one_star_ratings: 50,
                  num_two_star_ratings: 50,
                },
              },
              series: [{ asin: "SERIES1", title: "The Lord of the Rings", sequence: "1" }],
              publisher_summary: "<p>A hobbit's journey.</p>",
            },
            { asin: "B0002", title: "Non-English Edition", language: "french" },
            { asin: "B0003", title: null }, // no title -> filtered before it even reaches normalization
          ],
        }),
      };
    };
    const { source, results } = await searchBooks("fellowship");
    assert.equal(source, "audible");
    assert.equal(results.length, 1);
    const r = results[0];
    assert.equal(r.title, "The Fellowship of the Ring");
    assert.equal(r.author, "J.R.R. Tolkien");
    assert.equal(r.narrator, "Rob Inglis");
    assert.equal(r.duration_minutes, 660);
    assert.equal(r.year, 1954);
    assert.equal(r.genre, "Fantasy");
    assert.equal(r.subgenre, "Epic Fantasy");
    assert.deepEqual(r.series, { asin: "SERIES1", title: "The Lord of the Rings", position: 1 });
    assert.equal(r.public_rating.average, 4.8);
    assert.equal(r.public_rating.count, 5000);
    assert.equal(r.public_rating.polarizing, false); // low-star share is only 2%
    assert.equal(r.description, "A hobbit's journey.");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("searchBooks flags a polarizing book when the low-star share is high on a large sample", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        products: [{
          asin: "B0004", title: "Divisive Book", authors: [], narrators: [],
          rating: { overall_distribution: { average_rating: 3, num_ratings: 500, num_one_star_ratings: 40, num_two_star_ratings: 30 } },
        }],
      }),
    });
    const { results } = await searchBooks("divisive");
    assert.equal(results[0].public_rating.polarizing, true); // 70/500 = 14%
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("searchBooks falls back to Open Library when Audible errors", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("api.audible.com")) throw new Error("network down");
      if (url.includes("openlibrary.org")) {
        return {
          ok: true,
          json: async () => ({
            docs: [{ title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, cover_i: 12345, isbn: ["9780441013593"] }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const { source, results } = await searchBooks("dune");
    assert.equal(source, "openlibrary");
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Dune");
    assert.equal(results[0].author, "Frank Herbert");
    assert.equal(results[0].cover_url, "https://covers.openlibrary.org/b/id/12345-L.jpg");
    assert.equal(results[0].narrator, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("searchBooks falls through to Open Library on an empty Audible result, then to iTunes when that's also empty", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("api.audible.com")) return { ok: true, json: async () => ({ products: [] }) };
      if (url.includes("openlibrary.org")) return { ok: true, json: async () => ({ docs: [] }) };
      if (url.includes("itunes.apple.com")) {
        return {
          ok: true,
          json: async () => ({
            results: [{
              collectionName: "Recursion", artistName: "Blake Crouch",
              artworkUrl100: "https://art/100x100bb.jpg", releaseDate: "2019-06-11",
              description: "Memory is a weapon.",
            }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const { source, results } = await searchBooks("recursion");
    assert.equal(source, "itunes");
    assert.equal(results[0].title, "Recursion");
    assert.equal(results[0].author, "Blake Crouch");
    assert.equal(results[0].cover_url, "https://art/600x600bb.jpg");
    assert.equal(results[0].year, 2019);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("searchBooks returns source none when every catalog fails", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error("all catalogs down"); };
    const { source, results } = await searchBooks("anything");
    assert.equal(source, "none");
    assert.deepEqual(results, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- seriesVolumes: position dedup ----

test("seriesVolumes dedups per position, preferring English over a longer non-English runtime", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("/catalog/products/SERIESX?")) {
        return {
          ok: true,
          json: async () => ({
            product: {
              title: "My Series",
              relationships: [
                { relationship_type: "series", relationship_to_product: "child", asin: "A1", sort: "1" },
                { relationship_type: "series", relationship_to_product: "child", asin: "A2", sort: "1" },
                { relationship_type: "series", relationship_to_product: "child", asin: "A3", sort: "2" },
                { relationship_type: "other", relationship_to_product: "child", asin: "A4", sort: "3" },
              ],
            },
          }),
        };
      }
      if (url.includes("?asins=")) {
        return {
          ok: true,
          json: async () => ({
            products: [
              { asin: "A1", title: "Book One (French)", language: "french", runtime_length_min: 500 },
              { asin: "A2", title: "Book One", language: "english", runtime_length_min: 300 },
              { asin: "A3", title: "Book Two", language: "english", runtime_length_min: 400 },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const { series, volumes } = await seriesVolumes("SERIESX");
    assert.equal(series, "My Series");
    assert.equal(volumes.length, 2);
    assert.equal(volumes[0].title, "Book One"); // English beat the longer French runtime
    assert.equal(volumes[0].position, 1);
    assert.equal(volumes[1].title, "Book Two");
    assert.equal(volumes[1].position, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("seriesVolumes falls back to a volume's own series title when the series product lacks one", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("/catalog/products/SERIESY?")) {
        return {
          ok: true,
          json: async () => ({
            product: {
              title: null,
              relationships: [{ relationship_type: "series", relationship_to_product: "child", asin: "B1", sort: "1" }],
            },
          }),
        };
      }
      if (url.includes("?asins=")) {
        return {
          ok: true,
          json: async () => ({
            products: [{
              asin: "B1", title: "Book One", language: "english", runtime_length_min: 300,
              series: [{ asin: "SERIESY", title: "The Real Series Name", sequence: "1" }],
            }],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    const { series } = await seriesVolumes("SERIESY");
    assert.equal(series, "The Real Series Name");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("seriesVolumes returns no volumes, and skips the batch lookup, when there are no series/child relationships", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("/catalog/products/SOLO?")) {
        return { ok: true, json: async () => ({ product: { title: "Solo Book", relationships: [] } }) };
      }
      throw new Error(`unexpected fetch: ${url}`); // batch call must not happen
    };
    const { series, volumes } = await seriesVolumes("SOLO");
    assert.equal(series, "Solo Book");
    assert.deepEqual(volumes, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- libbyAvailability ----

test("libbyAvailability reports owned:false when nothing in the catalog matches", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) });
    const res = await libbyAvailability("lapl", "Dune", "Frank Herbert");
    assert.deepEqual(res, { owned: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("libbyAvailability matches on a normalized title prefix", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [{ title: "Dune: Deluxe Edition", isOwned: true, isAvailable: true, estimatedWaitDays: null, holdsCount: 0, ownedCopies: 5 }],
      }),
    });
    const res = await libbyAvailability("lapl", "Dune");
    assert.equal(res.owned, true);
    assert.equal(res.available, true);
    assert.equal(res.copies, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- handleMetadataRequest: routing + error shape ----

test("handleMetadataRequest routes ?q to searchBooks and returns 200 JSON", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.ok(url.includes("api.audible.com"));
      return { ok: true, json: async () => ({ products: [{ asin: "X", title: "Dune", authors: [], narrators: [] }] }) };
    };
    const res = fakeRes();
    await handleMetadataRequest(fakeReq("/api/metadata?q=dune"), res);
    assert.equal(res.headers["Content-Type"], "application/json");
    assert.equal(res.json.source, "audible");
    assert.equal(res.json.results[0].title, "Dune");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("handleMetadataRequest routes ?libby&q to libbyAvailability", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.ok(url.includes("thunder.api.overdrive.com"));
      return {
        ok: true,
        json: async () => ({ items: [{ title: "Dune", isOwned: true, isAvailable: false, estimatedWaitDays: 42, holdsCount: 10, ownedCopies: 3 }] }),
      };
    };
    const res = fakeRes();
    await handleMetadataRequest(fakeReq("/api/metadata?libby=lapl&q=Dune&author=Frank%20Herbert"), res);
    assert.equal(res.json.owned, true);
    assert.equal(res.json.waitDays, 42);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("handleMetadataRequest returns 400 when neither q nor series is given", async () => {
  const res = fakeRes();
  await handleMetadataRequest(fakeReq("/api/metadata"), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error, "q or series required");
});

test("handleMetadataRequest returns 502 with the upstream error message when a lookup throws", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    const res = fakeRes();
    await handleMetadataRequest(fakeReq("/api/metadata?series=SERIESX"), res);
    assert.equal(res.statusCode, 502);
    assert.ok(res.json.error.includes("503"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Live end-to-end smoke test of the AI import tiers against the real Claude API.
// SKIPPED by default so `npm test` stays offline and free. Run explicitly:
//   RUN_AI_TESTS=1 node --test test/ai-live.test.js
// It loads ANTHROPIC_API_KEY from .env and shims global fetch so the real
// inferImportMapping / parseImportFile code paths (which POST to /v1/messages)
// reach api.anthropic.com directly, mirroring the dev-proxy behavior.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const RUN = process.env.RUN_AI_TESTS === "1";

function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Redirect the relative /v1/messages calls (normally handled by the Vite proxy)
// to the real API with the key injected, so we exercise the actual code.
function installFetchShim(key) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    if (typeof url === "string" && url.startsWith("/v1/")) {
      return real("https://api.anthropic.com" + url, {
        ...opts,
        headers: {
          ...(opts.headers ?? {}),
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
      });
    }
    return real(url, opts);
  };
  return () => { globalThis.fetch = real; };
}

const UNKNOWN_CSV = [
  "Book Name,Penned By,My Shelf,Stars,Finished On,Published",
  "Project Hail Mary,Andy Weir,finished,5,May 13 2021,2021",
  "The Fifth Season,N. K. Jemisin,currently reading,4,,2015",
  "Piranesi,Susanna Clarke,want to read,,,2020",
].join("\n");

test("live: inferImportMapping maps an unknown CSV's columns", { skip: !RUN }, async () => {
  const key = loadKey();
  assert.ok(key, "ANTHROPIC_API_KEY must be available");
  const restore = installFetchShim(key);
  try {
    const { inferImportMapping } = await import("../src/lib/ai.js");
    const { parseCSV } = await import("../src/lib/csv.js");
    const rows = parseCSV(UNKNOWN_CSV);
    const { mapping } = await inferImportMapping({ header: rows[0], sampleRows: rows.slice(1) });
    assert.equal(mapping.title, "Book Name");
    assert.equal(mapping.author, "Penned By");
    assert.ok(mapping.status, "should map a status column");
  } finally {
    restore();
  }
});

test("live: parseImportFile end-to-end on an unknown CSV (tier 2 + confirmation)", { skip: !RUN }, async () => {
  const key = loadKey();
  const restore = installFetchShim(key);
  try {
    const { parseImportFile } = await import("../src/lib/importPipeline.js");
    const r = await parseImportFile(UNKNOWN_CSV, "my-weird-export.csv");
    assert.equal(r.aiUsed, true, "AI was involved -> confirmation required");
    assert.equal(r.aiMapped, true);
    assert.equal(r.books.length, 3);
    const phm = r.books.find((b) => /hail mary/i.test(b.title));
    assert.ok(phm, "Project Hail Mary parsed");
    assert.equal(phm.author, "Andy Weir");
    assert.equal(phm.status, "read");      // "finished" -> read
    assert.equal(phm.rating, 5);
    assert.equal(phm.date_finished, "2021-05-13"); // "May 13 2021" coerced
    assert.ok(r.mapping?.mapping?.title);  // mapping available for the preview UI
  } finally {
    restore();
  }
});

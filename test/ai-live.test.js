// Live end-to-end smoke test of the AI import tiers against the real AI provider.
// Forcing real AI in tests uses GEMINI (not Anthropic) — see api/_lib/messages-core.js
// and docs/TESTING.md. SKIPPED by default so `npm test` stays offline and free.
// Run explicitly:  RUN_AI_TESTS=1 node --test test/ai-live.test.js
// It loads GEMINI_API_KEY from .env and shims global fetch so the real
// inferImportMapping / parseImportFile code paths (which POST to /v1/messages)
// go through the same translation as the proxy and reach Gemini.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callGemini } from "../api/_lib/messages-core.js";

const RUN = process.env.RUN_AI_TESTS === "1";

function loadKey(name) {
  if (process.env[name]) return process.env[name];
  try {
    const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// Intercept the relative /v1/messages calls (normally handled by the Vite proxy)
// and serve them from Gemini via the same translation the proxy uses, so we
// exercise the real app code AND the Anthropic→Gemini mapping.
function installFetchShim(geminiKey) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (typeof url === "string" && url.startsWith("/v1/")) {
      const body = JSON.parse(opts.body ?? "{}");
      const gem = await callGemini(body, geminiKey); // calls the real Gemini API
      return new Response(JSON.stringify(gem), { status: gem?.error ? 502 : 200, headers: { "content-type": "application/json" } });
    }
    return real(url, opts);
  };
  return () => { globalThis.fetch = real; };
}

// The free Gemini tier intermittently returns "high demand"/overloaded errors.
// Retry those (only) a few times so the live test reflects code health, not the
// provider's transient load.
async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (!/high demand|overloaded|temporarily|try again|rate|quota|429|503/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw last;
}

const UNKNOWN_CSV = [
  "Book Name,Penned By,My Shelf,Stars,Finished On,Published",
  "Project Hail Mary,Andy Weir,finished,5,May 13 2021,2021",
  "The Fifth Season,N. K. Jemisin,currently reading,4,,2015",
  "Piranesi,Susanna Clarke,want to read,,,2020",
].join("\n");

test("live (gemini): inferImportMapping maps an unknown CSV's columns", { skip: !RUN }, async () => {
  const key = loadKey("GEMINI_API_KEY");
  assert.ok(key, "GEMINI_API_KEY must be available");
  const restore = installFetchShim(key);
  try {
    const { inferImportMapping } = await import("../src/lib/ai.js");
    const { parseCSV } = await import("../src/lib/csv.js");
    const rows = parseCSV(UNKNOWN_CSV);
    const { mapping } = await withRetry(() => inferImportMapping({ header: rows[0], sampleRows: rows.slice(1) }));
    assert.equal(mapping.title, "Book Name");
    assert.equal(mapping.author, "Penned By");
    assert.ok(mapping.status, "should map a status column");
  } finally {
    restore();
  }
});

test("live (gemini): parseImportFile end-to-end on an unknown CSV (tier 2 + confirmation)", { skip: !RUN }, async () => {
  const key = loadKey("GEMINI_API_KEY");
  const restore = installFetchShim(key);
  try {
    const { parseImportFile } = await import("../src/lib/importPipeline.js");
    const r = await withRetry(() => parseImportFile(UNKNOWN_CSV, "my-weird-export.csv"));
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

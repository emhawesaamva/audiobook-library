// Regression cover for the language scoping of Libby availability lookups.
// Run: npm test
//
// The bug this guards: without language=en the search matches a foreign-language
// edition of the same title and reports its availability. Fairfax owns the
// Spanish Piranesi (3 copies, ~19 day wait) but not the English one, so the app
// promised a three-week wait for a book the library cannot lend at all.
import test from "node:test";
import assert from "node:assert/strict";
import { libbyAvailability } from "../api/_lib/metadata-core.js";

// Captures the request URL and replies with a canned payload.
function stubFetch(items) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ items, totalItems: items.length }) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const english = { id: "en", name: "English" };
const spanish = { id: "es", name: "Spanish; Castilian" };

const owned = (languages) => ({
  title: "Piranesi", languages,
  isOwned: true, isAvailable: false, estimatedWaitDays: 19, holdsCount: 3, ownedCopies: 3,
});

test("the lookup is scoped to English at the API", async () => {
  const f = stubFetch([owned([english])]);
  try {
    await libbyAvailability("fairfax", "Piranesi", "Susanna Clarke");
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0], /[?&]language=en(&|$)/, "request must pin language=en");
    assert.match(f.calls[0], /libraries\/fairfax\/media/);
  } finally {
    f.restore();
  }
});

test("a wrong-language record is rejected even if the API returns one", async () => {
  // Belt and braces: if the language parameter is ever ignored or renamed,
  // the client-side check must still refuse the Spanish edition.
  const f = stubFetch([owned([spanish])]);
  try {
    assert.deepEqual(
      await libbyAvailability("fairfax", "Piranesi", "Susanna Clarke"),
      { owned: false },
      "Spanish edition must not be reported as this library's availability"
    );
  } finally {
    f.restore();
  }
});

test("an English record is reported normally", async () => {
  const f = stubFetch([owned([english])]);
  try {
    assert.deepEqual(
      await libbyAvailability("fairfax", "Piranesi", "Susanna Clarke"),
      { owned: true, available: false, waitDays: 19, holds: 3, copies: 3 }
    );
  } finally {
    f.restore();
  }
});

test("a record with no language list is allowed through", async () => {
  // Absence of a language list is not evidence of a foreign edition, and
  // dropping those would lose availability the library really does have.
  const f = stubFetch([owned(undefined)]);
  try {
    const r = await libbyAvailability("fairfax", "Piranesi", "Susanna Clarke");
    assert.equal(r.owned, true);
  } finally {
    f.restore();
  }
});

test("a multi-language record counts as English when English is among them", async () => {
  const f = stubFetch([owned([spanish, english])]);
  try {
    assert.equal((await libbyAvailability("fairfax", "Piranesi", "Susanna Clarke")).owned, true);
  } finally {
    f.restore();
  }
});

test("nothing matching the title still reports not owned", async () => {
  const f = stubFetch([{ ...owned([english]), title: "A Completely Different Book" }]);
  try {
    assert.deepEqual(await libbyAvailability("fairfax", "Piranesi", "Susanna Clarke"), { owned: false });
  } finally {
    f.restore();
  }
});

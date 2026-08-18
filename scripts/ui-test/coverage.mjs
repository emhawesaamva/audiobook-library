// Comprehensive functional E2E coverage for AudioLib.io.
// Self-provisions a fresh test account, stubs the two paid/external APIs
// (Claude at /v1/messages and Audible at /api/metadata) so the run is fast,
// free, and deterministic, then exercises every practical user flow with
// assertions. Set USE_REAL_AI=1 to hit the real APIs instead.
//
// Requires: dev server on :5173 and .env with Supabase + Anthropic keys.
// Run: node scripts/ui-test/coverage.mjs
//
// OUT OF SCOPE (cannot be automated reliably / safely, verified by other means):
//   - Google OAuth sign-in (external provider)
//   - Email-confirmation signup completion + password-reset emails (need inbox)
//   - Admin dashboard (needs an admin-flagged account)
//   - Live Audible search-prefill & metadata refresh (external; mobile-audit covers live)
//   - Live Claude recommendations (covered by test/ai-live.test.js + USE_REAL_AI here)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { authAdmin, findUserByEmail, assertNotProduction } from "../common.js";

assertNotProduction("the E2E coverage suite");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, "shots", "coverage");
const FIXTURES = path.join(__dirname, "fixtures");
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FIXTURES, { recursive: true });

const BASE = process.env.UI_TEST_BASE || "http://localhost:5173";
const EMAIL = "coverage-test@library-integration.test";
const PASSWORD = "coverage-test-1234";
const STUB = process.env.USE_REAL_AI !== "1";

const results = [];
const consoleErrors = [];
let current = "startup";
let fatal = null; // set when the suite body throws, so the report can exit non-zero

async function step(name, fn) {
  current = name;
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    results.push({ name, status: "PASS" });
    console.log("  PASS");
  } catch (e) {
    results.push({ name, status: "FAIL", detail: e.message.split("\n")[0] });
    console.log(`  FAIL: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: path.join(SHOTS, `FAIL-${name}.png`), fullPage: true }).catch(() => {});
    // Self-recover: a step that bailed mid-flow may have left a modal open, which
    // would cascade into every later step. Close any stray dialog before moving on.
    await page.keyboard.press("Escape").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
}

// ---- canned external responses ----
const msg = (text) => ({
  status: 200, contentType: "application/json",
  body: JSON.stringify({
    id: "msg_stub", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
  }),
});
function stubClaude(postData) {
  const p = postData || "";
  if (/recommendation engine/i.test(p)) {
    // Return several so that after the auto-recommender consumes a couple into
    // the library, the manual query still has fresh ones to display.
    const titles = [
      ["Leviathan Wakes", "James S. A. Corey"], ["A Fire Upon the Deep", "Vernor Vinge"],
      ["Hyperion", "Dan Simmons"], ["A Memory Called Empire", "Arkady Martine"],
      ["The Long Way to a Small, Angry Planet", "Becky Chambers"], ["Ancillary Justice", "Ann Leckie"],
    ];
    return msg(JSON.stringify({
      headline: "Great picks for you!",
      recommendations: titles.map(([title, author]) => ({ title, author, year: "2015", why: "Epic space opera.", similarity: "most like: Dune", genre: "Science Fiction", subgenre: "Space Opera" })),
      note: "",
    }));
  }
  if (/structured list of books/i.test(p))
    return msg(JSON.stringify({ books: [{ title: "The Martian", author: "Andy Weir", status: "read" }, { title: "Recursion", author: "Blake Crouch", status: null }], note: "" }));
  if (/map the columns/i.test(p))
    return msg(JSON.stringify({
      mapping: { title: "Book Name", author: "Penned By", status: "My Shelf", rating: "Stars", series_title: "Saga", series_position: "Vol" },
      statusMap: { finished: "read", reading: "reading", tbr: "wanttoread" }, note: "",
    }));
  if (/fix malformed/i.test(p)) return msg(JSON.stringify({ rows: [] }));
  return msg(JSON.stringify({ note: "" }));
}

// ---- AI-mapped import fixture (unknown headers + a 2-volume series) ----
const UNKNOWN_CSV = [
  "Book Name,Penned By,My Shelf,Stars,Saga,Vol",
  "Gardens of the Moon,Steven Erikson,finished,5,Malazan,1",
  "Deadhouse Gates,Steven Erikson,tbr,,Malazan,2",
  "Standalone Pick,Jane Doe,reading,4,,",
].join("\n");
const CSV_PATH = path.join(FIXTURES, "coverage-unknown.csv");
writeFileSync(CSV_PATH, UNKNOWN_CSV);

// ---- "Update" re-import fixture (recognized Goodreads format that overlaps
// the library) -> exercises the diff/UpdateConfirm flow. Re-lists two books
// already added via paste import (Recursion currently want-to-read; The Martian
// already read & unchanged) plus one brand-new title. Expect: 1 new, 1 changed.
const UPDATE_CSV = [
  "Title,Author,My Rating,Exclusive Shelf,Date Read,Average Rating",
  "Recursion,Blake Crouch,,read,2026/02/01,4.10",
  "The Martian,Andy Weir,,read,,",
  "The Three-Body Problem,Cixin Liu,,to-read,,",
].join("\n");
const UPDATE_CSV_PATH = path.join(FIXTURES, "coverage-update-goodreads.csv");
writeFileSync(UPDATE_CSV_PATH, UPDATE_CSV);

// ---- account ----
async function resetAccount() {
  const u = await findUserByEmail(EMAIL);
  if (u) await authAdmin(`users/${u.id}`, { method: "DELETE" });
  await authAdmin("users", { method: "POST", body: { email: EMAIL, password: PASSWORD, email_confirm: true } });
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[${current}] ${m.text().slice(0, 200)}`); });
page.on("pageerror", (e) => consoleErrors.push(`[${current}] PAGEERROR ${String(e).slice(0, 200)}`));

if (STUB) {
  await page.route("**/v1/messages", (r) => r.fulfill(stubClaude(r.request().postData())));
  await page.route("**/api/metadata**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) }));
  console.log("external APIs STUBBED (USE_REAL_AI=1 to run live)");
} else {
  // Forcing real AI in tests uses Gemini, not Anthropic — tag each AI request so
  // the proxy skips Anthropic entirely (see api/_lib/messages-core.js).
  await page.route("**/v1/messages", (r) =>
    r.continue({ headers: { ...r.request().headers(), "x-force-gemini": "1" } }));
  console.log("live AI forced via GEMINI");
}

// Outbound links (Libby, Audible, Goodreads) are target=_blank. Clicking one
// spawns a real tab that would try to load an external site; discard it so the
// suite stays offline and deterministic. The click still registers, which is
// what the hold prompt keys off.
ctx.on("page", (p) => p.close().catch(() => {}));

// The one-time "This book is on Audible" promo pops up asynchronously after the
// first add and overlays everything. Auto-dismiss it (permanently, via "Already
// a subscriber") whenever it appears so it never blocks a later action.
await page.addLocatorHandler(
  page.getByRole("button", { name: "Already a subscriber" }),
  async (btn) => { await btn.click(); }
);

// ---- helpers ----
const addBtn = () => page.getByRole("button", { name: "Add", exact: true }).first();
async function openSettings() {
  if (await page.getByText("Import & export").isVisible().catch(() => false)) return;
  await page.locator('button[aria-label="Settings"]').click();
  await page.getByText("Import & export").waitFor({ state: "visible" });
}
async function dismissWizard() {
  const skip = page.getByRole("button", { name: /Skip & explore|Finish/ });
  if (await skip.isVisible().catch(() => false)) { await skip.click().catch(() => {}); await page.waitForTimeout(300); }
  // Wizard is a dialog; Escape closes it if any step is still showing.
  if (await page.getByText(/Name your library|Who's it for|Bring in your books/).isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }
}
async function fillField(labelStart, value) {
  // Inputs are wrapped in <label> with the field name as leading text.
  await page.evaluate(({ labelStart, value }) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().startsWith(labelStart));
    const inp = l && (l.querySelector("input,textarea") || l.parentElement.querySelector("input,textarea"));
    if (inp) {
      // Use the setter matching the element type, or calling it throws "Illegal invocation".
      const proto = inp.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(inp, value);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, { labelStart, value });
}
async function addBookManually(title, { status } = {}) {
  await addBtn().click();
  await page.getByPlaceholder("Title, author, or series…").waitFor({ state: "visible" });
  await fillField("Title", title);
  if (status) await page.locator('select:has(option[value="wanttoread"])').first().selectOption(status);
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  // The Audible promo is auto-dismissed by the addLocatorHandler — no explicit
  // handling (doing both races the handler and hangs on the vanished button).
  await page.getByRole("button", { name: "Done", exact: true }).click().catch(() => {});
  await page.waitForTimeout(400);
}

try {
  await resetAccount();

  // ---------- AUTH ----------
  await step("landing-page", async () => {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    if (!(await page.getByText("AudioLib").first().isVisible())) throw new Error("landing brand not shown");
  });

  await step("signup-form-renders", async () => {
    await page.goto(BASE + "/signin", { waitUntil: "domcontentloaded" });
    await page.locator("input[type=email]").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Create account", exact: true }).click(); // toggle to signup
    // In signup mode the submit button becomes "Create account" and a back link appears.
    await page.getByText(/Back to sign in/i).waitFor({ state: "visible" });
  });

  await step("forgot-password-form-renders", async () => {
    await page.goto(BASE + "/signin", { waitUntil: "domcontentloaded" });
    await page.locator("input[type=email]").waitFor({ state: "visible" });
    await page.getByText(/Forgot password/i).click(); // toggle to reset
    if (!(await page.getByRole("button", { name: /Reset password/i }).isVisible())) throw new Error("reset submit missing");
  });

  await step("sign-in", async () => {
    await page.goto(BASE + "/signin", { waitUntil: "domcontentloaded" });
    await page.locator("input[type=email]").fill(EMAIL);
    await page.locator("input[type=password]").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText("Create your first library").waitFor({ state: "visible", timeout: 30000 });
  });

  // ---------- LIBRARY CREATE + ONBOARDING WIZARD ----------
  await step("create-library", async () => {
    await page.getByPlaceholder("e.g. My Library").fill("Coverage Shelf");
    await page.getByRole("button", { name: "Create library" }).click();
    await page.getByText("Name your library").waitFor({ state: "visible" });
  });

  await step("onboarding-wizard-walk", async () => {
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Who's it for?").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("Bring in your books").waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Skip & explore|Finish/ }).click();
    await addBtn().waitFor({ state: "visible" });
  });

  // ---------- ADD BOOKS (manual) ----------
  await step("add-book-want", async () => {
    await addBookManually("Dune", { status: "wanttoread" });
    await page.getByText("Dune").first().waitFor({ state: "visible" });
  });

  await step("add-book-with-details-and-rating", async () => {
    await addBtn().click();
    await fillField("Title", "Project Hail Mary");
    await page.locator('select:has(option[value="wanttoread"])').first().selectOption("read");
    // half-star rating: click right half of 5th star
    const stars = page.locator("span.relative.inline-block");
    await stars.last().waitFor({ state: "visible" });
    const box = await stars.nth(4).boundingBox();
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    // More details -> notes
    await page.getByRole("button", { name: /More details/ }).click().catch(() => {});
    await fillField("Notes", "Loved the narration.");
    await page.getByRole("button", { name: "Add", exact: true }).last().click();
    // Audible promo auto-dismissed by the addLocatorHandler (no explicit handling).
    await page.getByRole("button", { name: "Done", exact: true }).click().catch(() => {});
    await page.getByText("Project Hail Mary").first().waitFor({ state: "visible" });
  });

  // ---------- VIEWS ----------
  await step("view-toggles", async () => {
    for (const v of ["covers", "list", "cards"]) {
      await page.locator(`button[title="${v}"]`).click();
      await page.waitForTimeout(300);
    }
  });

  // Desktop keeps click-through: one click both dismisses the open menu and
  // opens the next card's. (Touch deliberately does not — see the mobile audit's
  // card-menu-dismiss step.) Guards the document-mousedown path in ActionMenu.
  await step("card-menu-switches-between-cards", async () => {
    await page.locator('button[title="cards"]').click();
    await page.waitForTimeout(300);
    const menus = page.locator("[data-book-menu]");
    const card = (t) => page.locator('[data-book-card="book"]').filter({ hasText: t }).first();

    await card("Dune").click();
    await menus.first().waitFor({ state: "visible" });
    if (!(await card("Dune").locator("[data-book-menu]").isVisible()))
      throw new Error("clicking a card did not open its own menu");

    await card("Project Hail Mary").click();
    await page.waitForTimeout(250);
    const open = await menus.count();
    if (open !== 1) throw new Error(`expected exactly 1 menu after switching cards, saw ${open}`);
    if (!(await card("Project Hail Mary").locator("[data-book-menu]").isVisible()))
      throw new Error("on desktop a click on a second card should open its menu, not just close the first");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    if ((await menus.count()) !== 0) throw new Error("Escape did not close the action menu");
  });

  // ---------- FILTERS / SEARCH / SORT ----------
  await step("filter-pills", async () => {
    await page.getByRole("button", { name: "Read", exact: true }).click();
    await page.getByText("Project Hail Mary").first().waitFor({ state: "visible" });
    if (await page.getByText(/^Dune$/).isVisible().catch(() => false)) throw new Error("Read filter should hide want-to-read Dune");
    await page.getByRole("button", { name: "All", exact: true }).click();
  });

  await step("search-box", async () => {
    await page.getByPlaceholder("Search title, author, narrator…").fill("hail");
    await page.getByText("Project Hail Mary").first().waitFor({ state: "visible" });
    await page.getByPlaceholder("Search title, author, narrator…").fill("");
  });

  await step("sort-and-rating-filter", async () => {
    await page.locator("select").filter({ hasText: /Sort:/ }).first().selectOption({ label: "Sort: Title A–Z" });
    await page.locator("select").filter({ hasText: "Any rating" }).first().selectOption("4");
    await page.getByText("Project Hail Mary").first().waitFor({ state: "visible" });
    // clear filters
    await page.getByRole("button", { name: "Clear filters" }).click().catch(() => {});
  });

  // ---------- EDIT + STATUS + DELETE ----------
  await step("edit-book-status-transition", async () => {
    await page.locator('button[title="cards"]').click();
    await page.getByText("Dune").first().click(); // opens action menu
    await page.getByRole("button", { name: /^Edit/ }).click();
    await page.locator('select:has(option[value="wanttoread"])').first().selectOption("reading");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Listening", exact: true }).click(); // filter to listening
    await page.getByText("Dune").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "All", exact: true }).click();
  });

  await step("up-next-add-and-start", async () => {
    await page.getByText("Project Hail Mary").first().click();
    await page.getByRole("button", { name: /Add to Up Next/ }).click();
    await page.getByText(/UP NEXT|queued/i).first().waitFor({ state: "visible" });
  });

  await step("delete-book", async () => {
    // Delete Dune (a grid card, not the queued PHM which also appears in the Up Next strip).
    await page.getByText("Dune", { exact: true }).first().click();
    await page.getByRole("button", { name: "Delete", exact: true }).click(); // menu -> confirm view
    await page.getByText(/Delete\s+"Dune"\?/).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Delete", exact: true }).click(); // confirm
    await page.waitForTimeout(700);
    if (await page.getByText("Dune", { exact: true }).first().isVisible().catch(() => false)) throw new Error("book still present after delete");
  });

  // ---------- STATS ----------
  // ---------- LIBBY HOLDS ----------
  // No library code is configured on a fresh account, so HoldModal makes no
  // availability call and the wait field starts empty — deterministic without
  // depending on the stubbed metadata endpoint.
  await step("hold-prompt-opens-from-libby-link", async () => {
    await addBookManually("Piranesi", { status: "wanttoread" });
    await page.getByText("Piranesi").first().waitFor({ state: "visible" });
    await page.getByText("Piranesi").first().click(); // opens the action menu
    await page.getByRole("link", { name: "Libby" }).click();
    await page.getByText("Did you put this book on hold?").waitFor({ state: "visible" });
  });

  await step("hold-save", async () => {
    await page.locator("#hold-weeks").fill("10");
    await page.getByRole("button", { name: /Yes, save hold/ }).click();
    await page.getByText("Did you put this book on hold?").waitFor({ state: "hidden" });
  });

  await step("holds-tab-lists-the-hold", async () => {
    await page.getByRole("button", { name: "Libby Holds" }).click();
    await page.getByText("Piranesi").first().waitFor({ state: "visible" });
    // Saved today, so the full 10 weeks should still be outstanding.
    await page.getByText("10", { exact: true }).first().waitFor({ state: "visible" });
    await page.getByText(/weeks left/i).first().waitFor({ state: "visible" });
  });

  await step("hold-edit-updates-the-countdown", async () => {
    await page.locator('button[aria-label^="Edit hold"]').first().click();
    await page.getByText("Edit hold").first().waitFor({ state: "visible" });
    await page.locator("#hold-weeks").fill("4");
    await page.getByRole("button", { name: "Save hold" }).click();
    await page.getByText("Edit hold").first().waitFor({ state: "hidden" });
    await page.getByText("4", { exact: true }).first().waitFor({ state: "visible" });
  });

  await step("hold-clear-empties-the-tab", async () => {
    await page.locator('button[aria-label^="Edit hold"]').first().click();
    await page.getByRole("button", { name: "Clear hold" }).click();
    await page.getByText(/No holds recorded yet/i).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Library", exact: true }).click();
  });

  await step("stats-goals", async () => {
    await page.getByRole("button", { name: "Stats", exact: true }).click();
    await page.getByPlaceholder("e.g. 24").first().waitFor({ state: "visible" });
    const goal = page.getByPlaceholder("e.g. 24").first();
    await goal.fill("12");
    await page.getByRole("button", { name: "Set", exact: true }).first().click();
    await page.getByText(/book goal/i).first().waitFor({ state: "visible" });
  });

  // ---------- RECOMMEND (stubbed AI) ----------
  await step("recommend-flow", async () => {
    await page.getByRole("button", { name: "Recommend", exact: true }).click();
    const q = page.getByPlaceholder(/looking for|What are you/i).first();
    await q.waitFor({ state: "visible" });
    await q.fill("space opera");
    await page.getByRole("button", { name: /Find|Get recommendation/i }).first().click();
    // Results rendered when the "More recommendations" button appears (robust to
    // which titles the auto-recommender already consumed into the library).
    await page.getByRole("button", { name: /More recommendations/ }).waitFor({ state: "visible", timeout: 40000 });
  });

  // ---------- IMPORT (Settings) ----------
  await step("open-settings", async () => {
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await openSettings();
  });

  await step("import-ai-mapped-with-series", async () => {
    await openSettings();
    // ensure enrichment off so no metadata dependency
    const enrich = page.locator('input[type="checkbox"]').first();
    if (await enrich.isChecked().catch(() => false)) await enrich.uncheck();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: /Import/ }).first().click(),
    ]);
    await chooser.setFiles(CSV_PATH);
    await page.getByText("Review before importing").waitFor({ state: "visible", timeout: 30000 });
    await page.getByRole("button", { name: /Looks right — import/ }).click();
    await page.getByText(/Imported \d+ books/).waitFor({ state: "visible", timeout: 30000 });
  });

  await step("series-grouped-from-import", async () => {
    // close settings, look for the Malazan series card
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {});
    await page.getByRole("button", { name: "All", exact: true }).click().catch(() => {});
    await page.getByText(/series ›/).first().waitFor({ state: "visible", timeout: 10000 });
  });

  await step("paste-import-stubbed", async () => {
    await openSettings();
    await page.getByRole("button", { name: /Paste a list/ }).click();
    await page.locator("textarea").first().waitFor({ state: "visible" });
    await page.locator("textarea").first().fill("the martian\nrecursion");
    await page.getByRole("button", { name: /Identify books/ }).click();
    await page.getByText(/The Martian/).first().waitFor({ state: "visible", timeout: 30000 });
    await page.getByRole("button", { name: /Looks right — import/ }).click();
    await page.waitForTimeout(600);
  });

  // ---------- UPDATE (re-import a recognized export that overlaps the library) ----------
  await step("update-reimport-shows-diff-and-applies", async () => {
    await openSettings();
    const enrich = page.locator('input[type="checkbox"]').first();
    if (await enrich.isChecked().catch(() => false)) await enrich.uncheck();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByRole("button", { name: /Import/ }).first().click(),
    ]);
    await chooser.setFiles(UPDATE_CSV_PATH);
    // A recognized format overlapping the library routes to the Update diff
    // (not a plain import and not the AI "Review before importing" preview).
    await page.getByText(/Update from Goodreads/).waitFor({ state: "visible", timeout: 30000 });
    await page.getByText(/1 new/).first().waitFor({ state: "visible" });
    await page.getByText(/1 changed/).first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: /Apply update/ }).click();
    // Toast reflects the create + the merge: "Imported 1 books from Goodreads, updated 1".
    await page.getByText(/updated 1/).waitFor({ state: "visible", timeout: 30000 });
  });

  await step("updated-book-status-advanced", async () => {
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {});
    await page.getByRole("button", { name: "Read", exact: true }).click(); // Recursion moved want-to-read -> read
    await page.getByText("Recursion").first().waitFor({ state: "visible", timeout: 10000 });
    await page.getByRole("button", { name: "All", exact: true }).click().catch(() => {});
  });

  // ---------- EXPORT ----------
  await step("export-csv-and-json", async () => {
    await openSettings();
    const dl1 = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export CSV/ }).click()]);
    if (!(await dl1[0].suggestedFilename()).endsWith(".csv")) throw new Error("CSV download missing");
    const dl2 = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Export JSON/ }).click()]);
    if (!(await dl2[0].suggestedFilename()).endsWith(".json")) throw new Error("JSON download missing");
  });

  // ---------- SETTINGS controls present ----------
  await step("settings-controls-present", async () => {
    await openSettings();
    await page.getByRole("button", { name: "Rename" }).waitFor({ state: "visible" });
    if (!(await page.getByRole("button", { name: "Sign out" }).isVisible())) throw new Error("sign out missing");
    await page.locator('button[aria-label="Close"]').first().click().catch(() => {});
    await page.waitForTimeout(300);
  });

  // ---------- second library: create + switch ----------
  await step("create-second-library-and-switch", async () => {
    await page.getByRole("button", { name: "+ new" }).click();
    await page.getByPlaceholder(/Name/).first().fill("Second Shelf");
    await page.getByRole("button", { name: "Add", exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(800);
    await dismissWizard(); // a fresh library opens the onboarding wizard
    if (!(await page.getByText("Second Shelf").first().isVisible())) throw new Error("second library not created");
    await addBtn().waitFor({ state: "visible" }); // confirm wizard is gone / app interactive
  });

  // ---------- PUBLIC PROFILE SHARING ----------
  await step("share-dialog", async () => {
    await page.locator('button[aria-label="Share library"]').click();
    // ShareModal is a custom modal (no Escape close); "Done" is unique to it.
    await page.getByRole("button", { name: "Done", exact: true }).waitFor({ state: "visible" });
    const url = await page.locator("span.font-mono").first().textContent();
    if (!/\/share\//.test(url || "")) throw new Error("share URL missing");
    await page.getByRole("button", { name: "Done", exact: true }).click(); // close it
    await page.waitForTimeout(300);
  });

  // ---------- THEME ----------
  await step("theme-toggle", async () => {
    const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    await page.locator('button[aria-label="Dark mode"], button[aria-label="Light mode"]').first().click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    if (before === after) throw new Error("theme did not toggle");
  });

  await step("sign-out", async () => {
    await page.locator('button[aria-label="Settings"]').click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.locator("input[type=email]").waitFor({ state: "visible", timeout: 15000 });
  });
} catch (e) {
  fatal = e;
  console.log(`\nFATAL: ${e.message}`);
  await page.screenshot({ path: path.join(SHOTS, "FATAL.png"), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  try { const u = await findUserByEmail(EMAIL); if (u) await authAdmin(`users/${u.id}`, { method: "DELETE" }); } catch { /* ignore */ }
}

// ---- report ----
const pass = results.filter((r) => r.status === "PASS").length;
console.log("\n\n========== COVERAGE RESULTS ==========");
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name}${r.detail ? " — " + r.detail : ""}`);
console.log(`\n${pass}/${results.length} steps passed`);
if (consoleErrors.length) { console.log(`\nConsole/page errors (${consoleErrors.length}):`); consoleErrors.slice(0, 20).forEach((e) => console.log("  " + e)); }

// A suite that aborted before running anything used to satisfy
// `pass === results.length` as 0 === 0 and exit 0, so CI reported a green E2E
// check for a run that tested nothing — the gate passed unconditionally for
// months while the test database was paused. Success now requires that steps
// actually ran and that nothing threw out of the suite body.
if (fatal) {
  console.log(`\nFAILED: suite aborted — ${fatal.message}`);
  process.exit(1);
}
if (!results.length) {
  console.log("\nFAILED: no steps ran. The suite reached the report without executing anything.");
  process.exit(1);
}
process.exit(pass === results.length ? 0 : 1);

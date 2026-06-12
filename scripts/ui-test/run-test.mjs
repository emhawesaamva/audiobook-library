// E2E UI test for the audiobook-library app at http://localhost:5173
// Run: node scripts/ui-test/run-test.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'shots');
mkdirSync(SHOTS, { recursive: true });

const BASE = 'http://localhost:5173';
const EMAIL = 'ui-test@library-integration.test';
const PASSWORD = 'ui-test-password-1234';
const T = 25000; // generous default timeout (metadata API can take seconds)

const results = [];   // { step, status, detail }
const consoleErrors = []; // { step, text }
let currentStep = 'startup';
const shots = [];

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    shots.push(file);
    console.log(`  [shot] ${file}`);
  } catch (e) {
    console.log(`  [shot FAILED] ${name}: ${e.message}`);
  }
}

async function step(name, page, fn) {
  currentStep = name;
  console.log(`\n=== STEP ${name} ===`);
  try {
    await fn();
    results.push({ step: name, status: 'PASS' });
    console.log(`  PASS`);
  } catch (e) {
    const msg = e.message.split('\n').slice(0, 4).join(' | ');
    results.push({ step: name, status: 'FAIL', detail: msg });
    console.log(`  FAIL: ${msg}`);
    await shot(page, `FAIL-${name.replace(/[^a-z0-9-]/gi, '_')}`);
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(T);

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push({ step: currentStep, text: msg.text().slice(0, 500) });
    console.log(`  [console error @ ${currentStep}] ${msg.text().slice(0, 300)}`);
  }
});
page.on('pageerror', (err) => {
  consoleErrors.push({ step: currentStep, text: `PAGEERROR: ${String(err).slice(0, 500)}` });
  console.log(`  [pageerror @ ${currentStep}] ${String(err).slice(0, 300)}`);
});

// ---------- helpers ----------
const searchInput = () => page.getByPlaceholder('Title, author, or series…');
const dropdownRows = () => page.locator('button.flex.w-full.items-center.gap-3:has(img)');

async function openAddDialog() {
  await page.getByRole('button', { name: '+ Add', exact: true }).click();
  await searchInput().waitFor({ state: 'visible' });
}

async function searchAndWaitDropdown(query) {
  await searchInput().fill(query);
  await dropdownRows().first().waitFor({ state: 'visible', timeout: 30000 });
  // let remaining results/covers settle
  await page.waitForTimeout(1500);
}

async function closeDialogIfOpen() {
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.waitForTimeout(400);
}

// ---------- 1. load login page ----------
await step('01-load-login', page, async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').waitFor({ state: 'visible' });
  await page.locator('input[type="password"]').waitFor({ state: 'visible' });
  await shot(page, '01-login-page');
});

// ---------- 2. sign in ----------
await step('02-sign-in', page, async () => {
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const firstLib = page.getByText('Create your first library');
  const addBtn = page.getByRole('button', { name: '+ Add', exact: true });
  await Promise.race([
    firstLib.waitFor({ state: 'visible', timeout: 30000 }),
    addBtn.waitFor({ state: 'visible', timeout: 30000 }),
  ]);
  if (await addBtn.isVisible().catch(() => false)) {
    throw new Error('Landed on main app shell instead of "Create your first library" — account is not fresh');
  }
  await shot(page, '02-create-first-library-prompt');
});

// ---------- 3. create library ----------
await step('03-create-library', page, async () => {
  await page.getByPlaceholder('e.g. My Library').fill('Test Shelf');
  await page.getByRole('button', { name: 'Create library' }).click();
  await page.getByRole('button', { name: '+ Add', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Library', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Stats', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Recommend', exact: true }).waitFor({ state: 'visible' });
  await page.getByText('Test Shelf').first().waitFor({ state: 'visible' });
  await page.getByText('finished').first().waitFor({ state: 'visible' }); // stats numbers
  await page.waitForTimeout(500);
  await shot(page, '03-main-app-shell');
});

// ---------- 4. add Project Hail Mary ----------
await step('04a-search-dropdown', page, async () => {
  await openAddDialog();
  await searchAndWaitDropdown('project hail mary');
  await shot(page, '04a-search-dropdown');
});

await step('04b-pick-result-prefill', page, async () => {
  await dropdownRows().first().click();
  const title = page.getByLabel('Title');
  await page.waitForFunction(
    () => {
      const labels = [...document.querySelectorAll('label')];
      const find = (t) => {
        const l = labels.find((x) => x.textContent.trim().startsWith(t));
        if (!l) return '';
        const inp = l.querySelector('input') || l.parentElement.querySelector('input');
        return inp ? inp.value : '';
      };
      return find('Title').length > 0 && find('Narrator').length > 0;
    },
    { timeout: 30000 }
  );
  // verify narrator is Ray Porter
  const narrVal = await page.getByLabel('Narrator').inputValue().catch(async () => {
    // fallback if label association is via wrapping label element
    return page.evaluate(() => {
      const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith('Narrator'));
      const inp = l && (l.querySelector('input') || l.parentElement.querySelector('input'));
      return inp ? inp.value : '';
    });
  });
  console.log(`  narrator field: "${narrVal}"`);
  if (!/ray porter/i.test(narrVal)) throw new Error(`Narrator not prefilled with Ray Porter (got "${narrVal}")`);
  await page.waitForTimeout(800); // cover image render
  await shot(page, '04b-form-prefilled');
});

await step('04c-status-rating-add', page, async () => {
  const statusSel = page.locator('select:has(option[value="wanttoread"])').first();
  await statusSel.selectOption('read');
  // rating row appears for status=read; click 5th star (right half = full star)
  const stars = page.locator('span.relative.inline-block');
  await stars.last().waitFor({ state: 'visible' });
  const n = await stars.count();
  console.log(`  star spans found: ${n}`);
  const target = stars.nth(Math.min(n, 5) - 1);
  const box = await target.boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // toast + form reset for rapid add
  await page.waitForFunction(
    () => {
      const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith('Title'));
      const inp = l && (l.querySelector('input') || l.parentElement.querySelector('input'));
      return inp && inp.value === '';
    },
    { timeout: 15000 }
  );
  await shot(page, '04c-after-add-toast-reset');
});

// ---------- 5. close dialog, card grid ----------
await step('05-book-in-grid', page, async () => {
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByText('Project Hail Mary').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(800); // covers load
  await shot(page, '05-book-in-grid');
});

// ---------- 6. series add: The Way of Kings ----------
await step('06a-series-banner-checklist', page, async () => {
  await openAddDialog();
  await searchAndWaitDropdown('the way of kings');
  await dropdownRows().first().click();
  await page.getByText('Part of').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: 'Add entire series' }).click();
  await page.locator('input[type="checkbox"]').first().waitFor({ state: 'visible', timeout: 45000 });
  const boxes = await page.locator('input[type="checkbox"]').count();
  console.log(`  series checkboxes: ${boxes}`);
  await page.waitForTimeout(1500); // covers in list
  await shot(page, '06a-series-checklist');
});

await step('06b-add-series', page, async () => {
  const addN = page.getByRole('button', { name: /^Add \d+ books?$/ });
  const label = await addN.textContent();
  console.log(`  clicking "${label}"`);
  await addN.click();
  await page.waitForTimeout(1500);
  await closeDialogIfOpen();
  await page.getByText('series ›').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(800);
  await shot(page, '06b-series-card-in-library');
});

// ---------- 7. series dialog ----------
await step('07-series-dialog', page, async () => {
  await page.getByText('series ›').first().click();
  await page.getByText('Books in series').waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  await shot(page, '07-series-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if (await page.getByText('Books in series').isVisible().catch(() => false)) {
    // fallback: click a close/✕ button
    const closeBtn = page.getByRole('button', { name: /✕|✖|×|Close|Done/ }).first();
    await closeBtn.click();
  }
  await page.getByText('Books in series').waitFor({ state: 'hidden', timeout: 5000 });
});

// ---------- 8. view toggles ----------
for (const [icon, name] of [['▦', 'covers'], ['▤', 'cards'], ['☰', 'list']]) {
  await step(`08-view-${name}`, page, async () => {
    await page.getByRole('button', { name: icon }).click();
    await page.waitForTimeout(900);
    await shot(page, `08-view-${name}`);
  });
}

// ---------- 9. stats tab + goal ----------
await step('09a-stats-tab', page, async () => {
  await page.getByRole('button', { name: 'Stats', exact: true }).click();
  await page.getByPlaceholder('e.g. 24').waitFor({ state: 'visible' });
  await page.waitForTimeout(800); // charts
  await shot(page, '09a-stats-tab');
});

await step('09b-books-goal', page, async () => {
  const goalInput = page.getByPlaceholder('e.g. 24');
  await goalInput.fill('12');
  await goalInput.locator('xpath=ancestor::*[.//button[normalize-space()="Set"]][1]//button[normalize-space()="Set"]').first().click();
  await page.locator('svg[viewBox="0 0 84 84"]').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.getByText('book goal').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await shot(page, '09b-goal-ring');
});

// ---------- 10. Up Next ----------
await step('10-up-next', page, async () => {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: '▤' }).click(); // cards view has the ⋮ menu
  await page.waitForTimeout(600);
  const card = page
    .getByText('Project Hail Mary')
    .first()
    .locator('xpath=ancestor::*[.//button[@aria-label="Book actions"]][1]');
  await card.hover();
  await card.locator('button[aria-label="Book actions"]').first().click();
  await page.getByRole('button', { name: /Add to Up Next/ }).click();
  await page.getByText('Up Next').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.getByText('queued').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  await shot(page, '10-up-next-strip');
});

// ---------- 11. theme toggle ----------
await step('11-theme-toggle', page, async () => {
  await page.locator('button[title="Toggle theme"]').click();
  await page.waitForTimeout(700);
  await shot(page, '11-light-mode');
});

// ---------- 12. settings dialog ----------
await step('12-settings', page, async () => {
  await page.locator('button[title="Settings"]').click();
  await page.getByText('Library name').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Rename' }).waitFor({ state: 'visible' });
  await page.getByText('Profile type', { exact: false }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Export CSV/ }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Delete this library/ }).waitFor({ state: 'visible' });
  await page.getByText(EMAIL).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ state: 'visible' });
  await shot(page, '12-settings-dialog');
});

// ---------- 13. sign out ----------
await step('13-sign-out', page, async () => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 15000 });
  await shot(page, '13-signed-out-login');
});

await browser.close();

// ---------- report ----------
console.log('\n\n========== RESULTS ==========');
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.step}${r.detail ? ' — ' + r.detail : ''}`);
console.log(`\nConsole errors: ${consoleErrors.length}`);
for (const c of consoleErrors) console.log(`  [${c.step}] ${c.text}`);
console.log(`\nScreenshots (${shots.length}):`);
for (const s of shots) console.log(`  ${s}`);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} steps passed`);
process.exit(0);

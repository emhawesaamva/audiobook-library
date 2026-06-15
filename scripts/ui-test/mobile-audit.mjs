// Mobile usability audit (iPhone portrait 390x844) for the audiobook-library app.
// Run: node scripts/ui-test/mobile-audit.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, 'mobile-shots');
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.UI_TEST_BASE || 'http://localhost:5173';
const EMAIL = 'mobile-test@library-integration.test';
const PASSWORD = 'mobile-test-1234';
const T = 30000;

// Supabase creds from .env, so the audit can self-provision its test account.
const env = Object.fromEntries(
  (() => { try { return readFileSync(path.resolve(process.cwd(), '.env'), 'utf8'); } catch { return ''; } })()
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const SUPA_URL = env.VITE_SUPABASE_URL;
const SECRET = env.SUPABASE_SECRET_KEY;

// Create the test account via the Supabase admin API if it doesn't exist yet.
// The on_auth_user_created trigger then creates the matching accounts row, so a
// first sign-in lands on the "Create your first library" / onboarding flow.
async function ensureTestAccount() {
  if (!SUPA_URL || !SECRET) {
    console.log('  [setup] no SUPABASE_SECRET_KEY in .env — assuming the test account already exists');
    return;
  }
  const h = { apikey: SECRET, Authorization: `Bearer ${SECRET}` };
  try {
    const existing = await fetch(`${SUPA_URL}/rest/v1/accounts?email=eq.${encodeURIComponent(EMAIL)}&select=id`, { headers: h }).then((r) => r.json());
    if (Array.isArray(existing) && existing.length) { console.log(`  [setup] test account ${EMAIL} already exists`); return; }
  } catch { /* fall through and try to create */ }
  const r = await fetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  if (r.ok) {
    console.log(`  [setup] created test account ${EMAIL}`);
    await new Promise((res) => setTimeout(res, 1500)); // let the signup trigger run
  } else {
    console.log(`  [setup] could not create test account: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

const results = [];
const findings = []; // { area, note }
const consoleErrors = [];
const shots = [];
let currentStep = 'startup';

function note(area, msg) {
  findings.push({ area, msg });
  console.log(`  [finding:${area}] ${msg}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
});
const page = await ctx.newPage();
page.setDefaultTimeout(T);

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push({ step: currentStep, text: m.text().slice(0, 300) });
});
page.on('pageerror', (e) => consoleErrors.push({ step: currentStep, text: `PAGEERROR: ${String(e).slice(0, 300)}` }));

async function shot(name, opts = {}) {
  const file = path.join(SHOTS, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: !!opts.fullPage });
    shots.push(file);
    console.log(`  [shot] ${name}.png${opts.fullPage ? ' (full)' : ''}`);
  } catch (e) {
    console.log(`  [shot FAILED] ${name}: ${e.message.split('\n')[0]}`);
  }
}

async function step(name, fn) {
  currentStep = name;
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    results.push({ step: name, status: 'PASS' });
    console.log('  PASS');
  } catch (e) {
    const msg = e.message.split('\n').slice(0, 3).join(' | ');
    results.push({ step: name, status: 'FAIL', detail: msg });
    console.log(`  FAIL: ${msg}`);
    await shot(`FAIL-${name.replace(/[^a-z0-9-]/gi, '_')}`);
  }
}

// ---- measurement helpers (run in page) ----
async function overflowCheck(label) {
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const sw = document.scrollingElement.scrollWidth;
    const all = [...document.querySelectorAll('body *')].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && (b.right > vw + 1 || b.left < -1);
    });
    // keep "leaf" offenders (no child also overflowing) for readable output
    const leaf = all
      .filter((el) => ![...el.children].some((c) => {
        const b = c.getBoundingClientRect();
        return b.right > vw + 1 || b.left < -1;
      }))
      .slice(0, 12)
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 90),
          text: (el.textContent || '').trim().slice(0, 50),
          left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width),
        };
      });
    return { vw, sw, overflowPx: sw - vw, offenders: leaf };
  });
  console.log(`  [overflow @ ${label}] scrollWidth=${r.sw} innerWidth=${r.vw} -> overflow=${r.overflowPx}px`);
  if (r.overflowPx > 1) {
    note(label, `HORIZONTAL OVERFLOW ${r.overflowPx}px (scrollWidth ${r.sw} vs innerWidth ${r.vw})`);
    for (const o of r.offenders) note(label, `  offender <${o.tag}> w=${o.width} left=${o.left} right=${o.right} "${o.text}" cls=${o.cls}`);
  } else if (r.offenders.length) {
    for (const o of r.offenders) note(label, `element extends past viewport (no page scroll, likely clipped): <${o.tag}> right=${o.right} "${o.text}"`);
  }
  return r;
}

async function dialogMetrics(label) {
  const m = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    // find topmost fixed overlay's panel: largest element inside a fixed-position ancestor
    const closeBtns = [...document.querySelectorAll('button[aria-label="Close"]')]
      .filter((b) => b.getBoundingClientRect().width > 0);
    const closeBtn = closeBtns[closeBtns.length - 1] || null;
    let panel = null;
    if (closeBtn) {
      let n = closeBtn.parentElement;
      while (n && n !== document.body) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) || cs.position === 'fixed') { panel = n; break; }
        n = n.parentElement;
      }
    }
    if (!panel) {
      const fixed = [...document.querySelectorAll('div')].filter((d) => getComputedStyle(d).position === 'fixed' && d.getBoundingClientRect().width > 200);
      panel = fixed[fixed.length - 1] || null;
    }
    const out = { vw, vh };
    if (panel) {
      const b = panel.getBoundingClientRect();
      out.panel = {
        top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right),
        width: Math.round(b.width), height: Math.round(b.height),
        scrollable: panel.scrollHeight > panel.clientHeight + 1,
        scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
        overflowY: getComputedStyle(panel).overflowY,
      };
    }
    if (closeBtn) {
      const b = closeBtn.getBoundingClientRect();
      out.close = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), inViewport: b.top >= 0 && b.bottom <= vh && b.left >= 0 && b.right <= vw };
    }
    return out;
  });
  console.log(`  [dialog @ ${label}] ${JSON.stringify(m)}`);
  if (m.panel) {
    if (m.panel.right > m.vw + 1 || m.panel.left < -1) note(label, `dialog panel exceeds viewport horizontally (left=${m.panel.left}, right=${m.panel.right}, vw=${m.vw})`);
    if (m.panel.bottom > m.vh + 1) note(label, `dialog panel bottom (${m.panel.bottom}) extends below viewport (${m.vh}); scrollable=${m.panel.scrollable}`);
    note(label, `dialog ${m.panel.width}x${m.panel.height}, scrollable=${m.panel.scrollable} (scrollH=${m.panel.scrollHeight} clientH=${m.panel.clientHeight}, overflowY=${m.panel.overflowY})`);
  }
  if (m.close) {
    note(label, `close button ${m.close.w}x${m.close.h} at (${m.close.x},${m.close.y}) inViewport=${m.close.inViewport}${m.close.w < 40 || m.close.h < 40 ? ' — UNDERSIZED tap target' : ''}`);
  }
  return m;
}

async function tapTargetScan(label) {
  const small = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('button, [role="button"], a, select, input[type="checkbox"]').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return;
      if (b.bottom < 0 || b.top > window.innerHeight) return; // only visible region
      if (b.width < 40 || b.height < 40) {
        const id = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 25)) + '|' + Math.round(b.width) + 'x' + Math.round(b.height);
        if (seen.has(id)) return;
        seen.add(id);
        out.push({
          label: el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().slice(0, 25) || el.tagName.toLowerCase(),
          w: Math.round(b.width), h: Math.round(b.height),
        });
      }
    });
    return out;
  });
  console.log(`  [tap targets @ ${label}] ${small.length} under 40px: ${small.map((s) => `${s.label}(${s.w}x${s.h})`).join(', ')}`);
  for (const s of small) note(`tap:${label}`, `"${s.label}" is ${s.w}x${s.h}px`);
  return small;
}

// ---------- 0. provision test account ----------
console.log('\n=== 00-setup ===');
await ensureTestAccount();

// ---------- 1. login ----------
await step('01-login-page', async () => {
  // Signed-out visitors get the marketing landing page; /signin deep-links to the form.
  await page.goto(BASE + '/signin', { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').waitFor({ state: 'visible' });
  await shot('01-login');
  await overflowCheck('login');
});

await step('02-sign-in', async () => {
  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const firstLib = page.getByText('Create your first library');
  const addBtn = page.getByRole('button', { name: 'Add', exact: true }).first();
  await Promise.race([
    firstLib.waitFor({ state: 'visible', timeout: 30000 }),
    addBtn.waitFor({ state: 'visible', timeout: 30000 }),
  ]);
  await shot('02-after-signin');
  if (await addBtn.isVisible().catch(() => false)) {
    note('signin', 'account was NOT fresh — landed on main shell; skipping create-library/onboarding steps');
  }
});

// ---------- 2. create library + onboarding wizard ----------
const fresh = await page.getByText('Create your first library').isVisible().catch(() => false);
if (fresh) {
  await step('03-create-library', async () => {
    await page.getByPlaceholder('e.g. My Library').fill('Phone Test');
    await shot('03-create-library-form');
    await page.getByRole('button', { name: 'Create library' }).click();

    // A 3-step onboarding wizard opens (name -> who's it for -> bring in books).
    await page.getByText('Name your library').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(500);
    await shot('04-wizard-1-name');
    await dialogMetrics('wizard');
    await tapTargetScan('wizard');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByText("Who's it for?").waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await shot('04-wizard-2-age');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByText('Bring in your books').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await shot('04-wizard-3-import');
    await overflowCheck('wizard-import');
    await tapTargetScan('wizard-import');

    await page.getByRole('button', { name: /Skip & explore|Finish/ }).click();
    await page.waitForTimeout(600);
  });
}

// ---------- 3. main shell ----------
await step('05-main-shell', async () => {
  await page.getByRole('button', { name: 'Add', exact: true }).first().waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  await shot('05-main-shell');
  await shot('05-main-shell-full', { fullPage: true });
  await overflowCheck('main-shell');
  await tapTargetScan('header-toolbar');
  // header geometry: does the toolbar wrap?
  const header = await page.evaluate(() => {
    const btns = ['Add', 'Library', 'Stats', 'Recommend'];
    const found = {};
    [...document.querySelectorAll('button')].forEach((b) => {
      const t = b.textContent.trim();
      if (btns.includes(t)) found[t] = b.getBoundingClientRect().toJSON();
    });
    return found;
  });
  console.log('  header buttons:', JSON.stringify(Object.fromEntries(Object.entries(header).map(([k, v]) => [k, `y=${Math.round(v.y)} x=${Math.round(v.x)} ${Math.round(v.width)}x${Math.round(v.height)}`]))));
});

// ---------- 4. Add dialog ----------
await step('06-add-dialog-search', async () => {
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const search = page.getByPlaceholder('Title, author, or series…');
  await search.waitFor({ state: 'visible' });
  await dialogMetrics('add-dialog-empty');
  await search.fill('project hail mary');
  await page.locator('button.flex.w-full.items-center.gap-3:has(img)').first().waitFor({ state: 'visible', timeout: 45000 });
  await page.waitForTimeout(1500);
  await shot('06-add-search-dropdown');
  await overflowCheck('add-dropdown');
});

await step('07-add-form', async () => {
  await page.locator('button.flex.w-full.items-center.gap-3:has(img)').first().click();
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('label')];
    const get = (t) => {
      const l = labels.find((x) => x.textContent.trim().startsWith(t));
      const i = l && (l.querySelector('input') || l.parentElement.querySelector('input'));
      return i ? i.value : '';
    };
    return get('Title').length > 0;
  }, { timeout: 45000 });
  await page.waitForTimeout(1000);
  await shot('07-add-form-top');
  await dialogMetrics('add-form');
  await overflowCheck('add-form');
  // scroll form panel to bottom to verify all fields reachable
  await page.evaluate(() => {
    const panels = [...document.querySelectorAll('div')].filter((d) => {
      const cs = getComputedStyle(d);
      return /(auto|scroll)/.test(cs.overflowY) && d.scrollHeight > d.clientHeight + 1 && d.getBoundingClientRect().width > 200;
    });
    const p = panels[panels.length - 1];
    if (p) p.scrollTop = p.scrollHeight;
  });
  await page.waitForTimeout(400);
  await shot('07-add-form-bottom');
  // status -> read
  const statusSel = page.locator('select:has(option[value="wanttoread"])').first();
  await statusSel.scrollIntoViewIfNeeded();
  await statusSel.selectOption('read');
  await page.waitForTimeout(400);
  // measure star rating halves while visible
  const stars = await page.evaluate(() => {
    const s = [...document.querySelectorAll('span.relative.inline-block')].map((el) => el.getBoundingClientRect());
    return s.length ? { count: s.length, w: Math.round(s[0].width), h: Math.round(s[0].height) } : null;
  });
  if (stars) note('tap:star-rating', `star spans ${stars.w}x${stars.h}px each -> half-star tap target ~${Math.round(stars.w / 2)}x${stars.h}px`);
  await shot('07-add-form-status-read');
  await page.getByRole('button', { name: 'Add', exact: true }).last().click();
  await page.waitForFunction(() => {
    const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith('Title'));
    const i = l && (l.querySelector('input') || l.parentElement.querySelector('input'));
    return i && i.value === '';
  }, { timeout: 20000 });
  // Adding a book fires the one-time "grab it free on Audible" promo, which overlays
  // the app. Dismiss via "Already a subscriber" — this also permanently silences it
  // for the test account, so it won't block later steps or future runs.
  const promo = page.getByRole('button', { name: 'Already a subscriber' });
  if (await promo.isVisible().catch(() => false)) {
    note('add-form', 'Audible promo appeared after add; dismissed via "Already a subscriber"');
    await promo.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForTimeout(600);
});

// ---------- 5. views ----------
await step('08-card-grid', async () => {
  await page.getByText('Project Hail Mary').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(1200); // covers + possible auto-recommend banner
  await shot('08-library-cards');
  await overflowCheck('cards-view');
  // The three-dots button was removed — tapping a card now opens its action menu.
  await tapTargetScan('cards-view');
});

await step('09-covers-view', async () => {
  await page.locator('button[title="covers"]').click();
  await page.waitForTimeout(900);
  await shot('09-library-covers');
  await overflowCheck('covers-view');
});

await step('10-list-view', async () => {
  await page.locator('button[title="list"]').click();
  await page.waitForTimeout(900);
  await shot('10-library-list');
  await overflowCheck('list-view');
  // readability: what does the first row actually show at 390px?
  const row = await page.evaluate(() => {
    const t = [...document.querySelectorAll('main *')].find((el) => el.textContent.includes('Project Hail Mary') && el.children.length > 1 && el.getBoundingClientRect().height < 120 && el.getBoundingClientRect().height > 20);
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { text: t.innerText.replace(/\n/g, ' | ').slice(0, 200), w: Math.round(r.width), h: Math.round(r.height) };
  });
  if (row) note('list-view', `first row (${row.w}x${row.h}px) shows: ${row.text}`);
  await tapTargetScan('list-view');
});

// ---------- 6. card action menu (opened by tapping the card) ----------
await step('11-card-menu', async () => {
  await page.locator('button[title="cards"]').click(); // back to cards
  await page.waitForTimeout(700);
  // Tapping a (non-series) book card opens its action menu — the three-dots button is gone.
  await page.getByText('Project Hail Mary').first().click();
  await page.waitForTimeout(500);
  await shot('11-card-menu-open');
  // does the dropdown fit?
  const dd = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const cand = [...document.querySelectorAll('div, ul')].filter((el) => {
      const cs = getComputedStyle(el);
      return (cs.position === 'absolute' || cs.position === 'fixed') && el.querySelector('button') && /Up Next|Edit|Delete/i.test(el.textContent);
    });
    const el = cand[cand.length - 1];
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { vw, vh, left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), fits: b.left >= 0 && b.right <= vw && b.top >= 0 && b.bottom <= vh };
  });
  if (dd) note('card-menu', `dropdown rect L${dd.left} R${dd.right} T${dd.top} B${dd.bottom} (vw=${dd.vw}) fitsOnScreen=${dd.fits}`);
  await tapTargetScan('card-menu');
  // add to Up Next so we can measure queue arrows
  const upNext = page.getByRole('button', { name: /Add to Up Next/ }).last();
  if (await upNext.isVisible().catch(() => false)) {
    await upNext.click();
    await page.waitForTimeout(900);
    await shot('12-up-next-strip');
    const arrows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('button[aria-label="Move earlier"], button[aria-label="Move later"]').forEach((b) => {
        const r = b.getBoundingClientRect();
        out.push({ label: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height) });
      });
      return out;
    });
    for (const a of arrows) note('tap:queue-arrows', `"${a.label}" is ${a.w}x${a.h}px`);
  } else {
    await page.keyboard.press('Escape');
  }
});

// ---------- 7. stats ----------
await step('13-stats', async () => {
  await page.getByRole('button', { name: 'Stats', exact: true }).click();
  await page.getByPlaceholder('e.g. 24').waitFor({ state: 'visible' });
  await page.waitForTimeout(1000);
  await shot('13-stats-top');
  await shot('13-stats-full', { fullPage: true });
  await overflowCheck('stats');
  await tapTargetScan('stats');
});

// ---------- 8. recommend ----------
await step('14-recommend', async () => {
  await page.getByRole('button', { name: 'Recommend', exact: true }).click();
  const q = page.getByPlaceholder('What are you looking for?');
  await q.waitFor({ state: 'visible' });
  await shot('14-recommend-empty');
  await q.fill('space opera');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  // results: wait for "More recommendations" or any result card with badges
  await page.getByRole('button', { name: /More recommendations/ }).waitFor({ state: 'visible', timeout: 150000 });
  await page.waitForTimeout(1500);
  await shot('15-recommend-results');
  await shot('15-recommend-results-full', { fullPage: true });
  await overflowCheck('recommend-results');
  await tapTargetScan('recommend-results');
});

// ---------- 9. settings ----------
await step('16-settings', async () => {
  await page.locator('button[aria-label="Settings"]').click();
  await page.getByText('Rename this library').waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  await shot('16-settings-top');
  await dialogMetrics('settings-dialog');
  await tapTargetScan('settings-dialog');
  const scrolled = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('div')].filter((d) => {
      const cs = getComputedStyle(d);
      return /(auto|scroll)/.test(cs.overflowY) && d.scrollHeight > d.clientHeight + 1 && d.getBoundingClientRect().width > 200;
    });
    const p = panels[panels.length - 1];
    if (!p) return null;
    p.scrollTop = p.scrollHeight;
    return { to: p.scrollTop, max: p.scrollHeight - p.clientHeight };
  });
  if (scrolled) note('settings-dialog', `scrolls: reached ${scrolled.to}/${scrolled.max}`);
  await page.waitForTimeout(400);
  await shot('16-settings-bottom');
  await page.locator('button[aria-label="Close"]').first().click().catch(() => {});
});

await browser.close();

// ---------- report ----------
console.log('\n\n========== STEP RESULTS ==========');
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.step}${r.detail ? ' — ' + r.detail : ''}`);
console.log('\n========== FINDINGS ==========');
for (const f of findings) console.log(`[${f.area}] ${f.msg}`);
console.log(`\nConsole errors: ${consoleErrors.length}`);
for (const c of consoleErrors) console.log(`  [${c.step}] ${c.text}`);
console.log(`\nScreenshots (${shots.length}):`);
for (const s of shots) console.log(`  ${s}`);
process.exit(0);

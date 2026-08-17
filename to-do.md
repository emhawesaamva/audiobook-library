# To-do

Outstanding work, most consequential first. The README's own To-do section
tracks completed milestones; this file is for what is still open.

Last reviewed: 2026-08-17.

---

## 1. Needs a person

### Update `.env` with the rotated Supabase secret key
The service-role key was rotated on 2026-08-17. The local `.env` still holds the
old one, so anything reading `SUPABASE_SECRET_KEY` fails silently-ish until it is
replaced: the Admin tab's user list and delete-user, `scripts/test-integration.js`,
`scripts/ui-test/mobile-audit.mjs`, and `scripts/common.js`.

Dashboard → Project Settings → API keys → secret key.

### Install Docker for local test parity
`npm run db:start`, `test:e2e`, `test:mobile` and `test:integration` all need the
local Supabase stack, which needs Docker. Without it those suites only ever run in
CI, so a break is found minutes later in a PR rather than seconds later locally.

`brew install --cask docker`, then `npm run db:start && npm run db:reset && npm run db:use-local`.

### Confirm the first scheduled nightly run
`.github/workflows/nightly.yml` fires at 07:00 UTC. It has been verified two ways
(on its own PR, and via `workflow_dispatch`) but has never fired on the schedule
itself. Check the first one, then stop worrying about it.

### Check the mobile audit artifact after that run
The Up Next drawer grew in #12 and the audit has not run since. It measures tap
targets and overflow, and the drawer is `fixed` and deliberately off-screen when
closed — `mobile-audit.mjs` excludes it via `[data-upnext-drawer]`, but that
exclusion has not been exercised against the larger drawer.

---

## 2. Cleanup, safe to do any time

### Delete the three unused GitHub repo secrets
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` are
referenced by **no workflow** since E2E moved to the local stack. They are not
readable — not by the API, not by an admin — so deleting loses the values for
good. Evidence says they pointed at "Library Test": they were created hours after
that project, and production's auth table never contained a `coverage-test@…`
account, which the E2E suite creates on every run.

### Delete the "Library Test" Supabase project
Paused, obsolete now that CI runs locally, and occupying one of two free-tier
active-project slots. Deleting it frees the slot.

### Decide the fate of `scripts/run-sql.js`
It needs `SUPABASE_ACCESS_TOKEN`, which is still a placeholder, and its fallback
path reads `%APPDATA%` — Windows-only, so it has never worked on this machine.
Schema now lives in `supabase/migrations/`, applied locally by `supabase db reset`
and to production via the Supabase MCP. Either populate the token or delete the
script and its README references.

### Document where each environment variable actually lives
The README lists the variables but not their homes, and that ambiguity cost real
time: `GEMINI_API_KEY` was hunted through `app_settings`, `vault.secrets` and edge
functions before turning up in Vercel. A short table would prevent a repeat.

| Variable | Local `.env` | Vercel | Notes |
|---|---|---|---|
| `VITE_SUPABASE_URL` / `_PUBLISHABLE_KEY` | yes | yes | points at production in both |
| `SUPABASE_SECRET_KEY` | yes | yes | service role — bypasses RLS |
| `ANTHROPIC_API_KEY` | yes | yes | |
| `GEMINI_API_KEY` | placeholder | **yes** | fallback only fires on credit exhaustion |
| `SUPABASE_ACCESS_TOKEN` | placeholder | no | local tooling only; see above |
| `OWNER_EMAIL` | yes | no | one-time legacy migration |

---

## 3. Known gaps and open questions

### "Notify Me" cannot be distinguished from "not in the catalogue"
OverDrive's search endpoint returns **only titles the library owns**, confirmed
against real audiobooks Fairfax lacks (`Blindsight`, `The Quantum Thief`, `Ilium`
— all `total=0`, identical to a title that does not exist). `deepSearch`,
`includeUnowned` and `showOnlyAvailable` do nothing. Libby's own deep search
surfaces these, via an endpoint we do not have.

Both cases therefore read **"Audible only"**. If a deep-search endpoint is ever
identified, the fourth state becomes possible.

### Availability backfills slowly on large libraries
The refresh is capped at 40 books per visit, three concurrent, and only runs for
Recommended / Want books older than 24h. A library with hundreds of wanted books
takes several visits to fully populate. Raise the cap, or add an explicit
"refresh availability" action, if that becomes annoying.

### Series headers never show availability
Only volumes are checked, since a header has no status of its own. A header for a
series you want shows no badge at all. An aggregate ("3 of 5 available") would be
better but needs a rule for mixed states.

### The Anthropic → Gemini fallback has never actually run
`app_settings` has no `ai_credit_exhausted` row, so the path has never fired in
production. It has unit tests (`test/messages-core.test.js`), but the real
Anthropic error shape has never been observed. Worth a deliberate test the next
time credit is intentionally exhausted.

### The OverDrive endpoint is undocumented
`thunder.api.overdrive.com` is what libbyapp.com's own front-end calls. It is
keyless and unversioned, with no stability guarantee, and `estimatedWaitDays` is
their estimate rather than a promise. `libbyAvailability` re-checks the matched
record's `languages` client-side precisely so a renamed parameter degrades to
"not owned" rather than to a wrong answer.

---

## 4. Smaller items

- **Bundle size.** The production build emits a >500KB chunk warning. Code-splitting
  the Admin tab and the import pipeline would be the obvious first cut.
- **E2E does not cover** the availability badges (the test account has no library
  code configured, so no lookup fires), the drawer's hover/pin behaviour, or the
  Admin tab (needs an admin-flagged account). OAuth and email-confirmation flows
  are deliberately out of scope — see the header comment in `coverage.mjs`.
- **`libbySearchUrl`'s no-library fallback** points at `overdrive.com/search` with
  no language filter, while every other Libby link is pinned to `language-en`.
- **Holds tab could show the live estimate** next to the recorded wait, which is
  arguably the more useful number once a hold is weeks old. Deliberately not built.

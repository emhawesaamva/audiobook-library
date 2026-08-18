# To-do

Outstanding work, most consequential first. The README's own To-do section
tracks completed milestones; this file is for what is still open.

Last reviewed: 2026-08-18.

---

## 1. Needs a person

~~Update `.env` with the rotated Supabase secret key~~ — done 2026-08-18.
~~Delete the "Library Test" Supabase project~~ — done; confirmed gone from
`list_projects` (was done via dashboard — no delete-project call exists in the
management API/MCP, only pause/restore).
~~Remove the leftover `chore/close-testing-gaps` worktree~~ — done 2026-08-18.
~~Install Docker for local test parity~~ — done 2026-08-18.
~~Confirm the first scheduled nightly run~~ — done; a `schedule`-triggered run
fired 2026-08-17 07:45 UTC and succeeded.
~~Check the mobile audit artifact after that run~~ — done; artifact confirmed
present, and the `[data-upnext-drawer]` exclusion re-verified against the grown
drawer (18/18 steps pass, zero overflow). `test:mobile` also moved from nightly
to the per-PR gate (#18), so this now runs on every PR rather than once a night.

---

## 2. Cleanup, safe to do any time

~~Document where each environment variable actually lives~~ — done 2026-08-18;
table moved into README.md's "Environment variables" section (it was only
sitting here as a draft before, never actually reaching the README).
~~Delete the three unused GitHub repo secrets~~ — done 2026-08-18
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`).
~~Decide the fate of `scripts/run-sql.js`~~ — done 2026-08-18; deleted along with
its README references (#19).

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

~~Availability backfills slowly on large libraries~~ — reviewed 2026-08-18,
decided the current cap (40 books/visit, 3 concurrent, Recommended/Want older
than 24h) is fine as-is; not worth an explicit refresh action or a higher cap.

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
- ~~Holds tab could show the live estimate~~ — closed 2026-08-18, not just deferred:
  `estimatedWaitDays` is a catalog-level "if you joined today" estimate, not the
  user's actual queue position, which only their own logged-in Libby account can
  see. A live refetch wouldn't track their personal countdown — it'd just be a
  different, less relevant number than the recorded-at-hold-time wait.

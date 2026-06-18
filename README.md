# Audiobook Library

A multi-user audiobook tracking and recommendation app built with React, Vite, Tailwind CSS, and Supabase. Live at https://audiolib.io.

## What it is

Sign in with Google (or email/password), create one or more **libraries** (per person, per genre — up to you), and track your audiobooks with covers, narrators, runtimes, ratings, and listening history. Claude-powered recommendations learn from what you love.

## Features

- **Effortless adding** — search-as-you-type against Audible's catalog autofills title, author, narrator, runtime, cover art, year, and series info. Manual entry always available.
- **One-click series** — pick any book in a series and add the entire series (all volumes, ordered, with covers) in a single click. Existing series can fetch their missing volumes.
- **Three views** — cover grid (bookshelf), card grid, and a sortable list.
- **Rich tracking** — half-star ratings, Read / Listening / Want to Listen / Recommended / DNF (with reason and % reached), start/finish dates (auto-set on status changes), re-listen history, loved flags, tags, notes, and "recommended by" provenance.
- **Up Next queue** — a small ordered strip of what you'll listen to next, separate from the full want list.
- **Stats & goals** — listening hours, yearly book/hour goals with progress rings, top authors/narrators/genres, rating distribution, per-year review.
- **AI recommendations** — describe a mood or ask for "more like X"; Claude answers grounded in your loved books and authors, with age-appropriate filtering per library (Adult / Teens / Children). The app also quietly keeps two fresh recommendations waiting in each library, and deleting one teaches it never to suggest that book again.
- **Import & export** — Goodreads CSV import (with optional metadata enrichment), CSV/JSON export.
- **Multi-user** — accounts are isolated by Postgres row-level security. Each user gets their own libraries and settings.
- **Admin** — the owner account sees an Admin tab: user list with usage, disable-signups switch.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS v4 |
| Auth | Supabase Auth (Google OAuth + email/password) |
| Database | Supabase Postgres with RLS (`supabase/schema.sql`, `supabase/rls.sql`) |
| AI | Claude API (Sonnet for recommendations, Haiku for identification) via serverless proxy |
| Metadata | Audible catalog API (narrator/runtime/series/covers), Open Library + iTunes fallbacks via `api/metadata.js` |
| Hosting | Vercel (static build + serverless functions in `api/`) |

## Local development

```bash
npm install
cp .env.example .env   # fill in keys (see comments in the file)
npm run dev
```

The Vite dev server proxies `/v1/*` to Anthropic (key injected server-side) and serves the same `/api/*` handlers Vercel runs in production.

## Database setup (one-time)

Run in order against a fresh Supabase project (SQL editor, or `node scripts/run-sql.js <file>` with a `SUPABASE_ACCESS_TOKEN`):

1. `supabase/schema.sql` — tables, triggers, seed settings
2. `supabase/rls.sql` — row-level security policies

Then in the Supabase dashboard:

1. **Auth → Providers**: enable **Email**, and **Google** (needs a Google Cloud OAuth client; authorized redirect URI is `https://YOUR_PROJECT.supabase.co/auth/v1/callback`)
2. **Auth → URL Configuration**: Site URL = your production URL; add `http://localhost:5173` to additional redirect URLs

## Scripts

| Command | What it does |
|---|---|
| `npm run backup` | Dump the legacy `audiobook_library` table to `backups/` |
| `npm run migrate` | One-time legacy → relational migration (`OWNER_EMAIL=... npm run migrate`) |
| `npm run verify-migration` | Verify migrated counts/fields against the legacy data |
| `node scripts/run-sql.js <file.sql>` | Run SQL via the Supabase Management API |

## Vercel environment variables

`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (server-side), plus `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (bundled into the frontend).

## Automated testing

Tests run automatically in a pipeline ([GitHub Actions](.github/workflows/ci.yml)) so broken code is caught before it can reach production. Because `master` auto-deploys to Vercel, the goal is to block a bad change *before* it merges — not to discover it after it's live.

**What runs, and when.** Every push and pull request triggers a fresh, throwaway Linux runner that checks out the code, installs dependencies, and runs the suites below. Nothing runs on a developer's machine or on the production server:

| Trigger | Suite | Why |
|---|---|---|
| Push to `dev` / `master` | `npm test` (unit + import logic) | Fast feedback (~15s); these are pure functions, no network |
| PR into `master` | `npm test` **and** `npm run test:e2e` (Playwright) | Full gate before anything can deploy |

**Two layers of testing.**

- **Unit / integration** — call functions directly with hand-written inputs (mock data). No database or network, so they need no secrets and finish in seconds. This is most of the suite.
- **End-to-end (E2E)** — launch the real app in a headless browser and click through every user flow (sign in, add a book, import a CSV, export, share…). It verifies the *real wiring*, so it talks to a live Supabase backend. It stubs only the paid external APIs (Claude + Audible) to stay fast, free, and deterministic.

**The gate.** Branch protection on `master` requires *both* suites to pass before a PR can merge. A red build blocks the merge, which blocks the Vercel deploy — that's what makes the tests a safety net rather than just a report.

**The E2E test database.** E2E runs against a **dedicated, non-production** Supabase project (never production — the suite creates and deletes throwaway accounts using an admin key, which would be destructive against real data). Its `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` are stored as GitHub repository secrets. To stand up a fresh test project, apply `supabase/schema.sql`, then `supabase/rls.sql`, then `supabase/public-read.sql` (see [Database setup](#database-setup-one-time)).

`npm run test:mobile` and the live-AI tests (`RUN_AI_TESTS=1` / `USE_REAL_AI=1`) are intentionally **not** in the per-PR gate — run them manually. See [`docs/TESTING.md`](docs/TESTING.md) for the full test surface.

## To-do

- [x] **Set up CI.** GitHub Actions (`.github/workflows/ci.yml`) runs `npm test` (unit + import logic) on pushes to `dev`/`master` and on PRs into `master`. The `npm run test:e2e` Playwright suite also runs on PRs into `master`, against a dedicated **non-production** Supabase test project (paid APIs stubbed). Branch protection on `master` requires both the unit suite and the E2E suite to pass before merging. `npm run test:mobile` and the live-AI tests (`RUN_AI_TESTS=1` / `USE_REAL_AI=1`) remain manual. See `docs/TESTING.md` for the full test surface.
- [x] Confirm `GEMINI_API_KEY` is set in the Vercel project env so the Anthropic→Gemini fallback works in production.
- [x] Open a PR `dev` → `master` to ship the StoryGraph + AI-assisted import work.

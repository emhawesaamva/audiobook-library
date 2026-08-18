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
| Database | Supabase Postgres with RLS (`supabase/migrations/`) |
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

Schema lives in `supabase/migrations/`, applied in filename order. Two ways to
get a database:

**Local (recommended for development and tests).** Needs Docker running:

```bash
npm run db:start      # boot Postgres + auth + PostgREST + Studio in Docker
npm run db:reset      # apply supabase/migrations/* onto a clean database
npm run db:use-local  # point .env at the local stack (backs up your hosted .env)
```

`npm run db:stop` shuts it down. Studio is at http://127.0.0.1:54323.

**Hosted project.** Run the files in `supabase/migrations/` in filename order
against a fresh Supabase project (SQL editor, or the Supabase MCP), then in the
dashboard:

1. **Auth → Providers**: enable **Email**, and **Google** (needs a Google Cloud OAuth client; authorized redirect URI is `https://YOUR_PROJECT.supabase.co/auth/v1/callback`)
2. **Auth → URL Configuration**: Site URL = your production URL; add `http://localhost:5173` to additional redirect URLs

Migrations are additive and idempotent, so an existing database only needs the
files it hasn't seen yet.

`supabase/add-feedback-table.sql` and `supabase/lock-legacy-table.sql` sit
outside `migrations/` deliberately — they are one-shot patches for the
already-live database, and would fail on a fresh one where `schema` already
covers them.

## Scripts

| Command | What it does |
|---|---|
| `npm run backup` | Dump the legacy `audiobook_library` table to `backups/` |
| `npm run migrate` | One-time legacy → relational migration (`OWNER_EMAIL=... npm run migrate`) |
| `npm run verify-migration` | Verify migrated counts/fields against the legacy data |

## Vercel environment variables

`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (server-side), plus `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (bundled into the frontend).

## Automated testing

Tests run automatically in a pipeline ([GitHub Actions](.github/workflows/ci.yml)) so broken code is caught before it can reach production. Because `master` auto-deploys to Vercel, the goal is to block a bad change *before* it merges — not to discover it after it's live.

**What runs, and when.** Every push and pull request triggers a fresh, throwaway Linux runner that checks out the code, installs dependencies, and runs the suites below. Nothing runs on a developer's machine or on the production server:

| Trigger | Suite | Why |
|---|---|---|
| Push to `dev` / `master` | `npm test` (unit + import logic) | Fast feedback (~15s); these are pure functions, no network |
| PR into `master` | `npm test`, `npm run test:e2e`, **and** `npm run test:mobile` (Playwright) | Full gate before anything can deploy |

**Two layers of testing.**

- **Unit / integration** — call functions directly with hand-written inputs (mock data). No database or network, so they need no secrets and finish in seconds. This is most of the suite.
- **End-to-end (E2E)** — launch the real app in a headless browser and click through every user flow (sign in, add a book, import a CSV, export, share…). It verifies the *real wiring*, so it talks to a live Supabase backend. It stubs only the paid external APIs (Claude + Audible) to stay fast, free, and deterministic.
- **Mobile audit** — the same kind of Playwright run as E2E, but at phone viewport widths (390px and 320px), checking for horizontal overflow, wrapped/clipped labels, and undersized tap targets. Used to run nightly only, which meant a PR could merge with a mobile layout regression and nothing would say so until the next morning; it gates every PR now.

**The gate.** Branch protection on `master` requires all three suites to pass before a PR can merge. A red build blocks the merge, which blocks the Vercel deploy — that's what makes the tests a safety net rather than just a report.

**The E2E/mobile database.** Both E2E and the mobile audit run against a **local Supabase stack in Docker**, started by the CI job itself — no hosted project, no repo secrets, no free-tier pausing. Each run gets a clean database from `supabase/migrations/`, so runs cannot contaminate each other.

Run it locally the same way:

```bash
npm run db:start && npm run db:reset && npm run db:use-local
npm run dev &
npm run test:e2e
```

This replaced a hosted test project that the free-tier idle policy had paused. The suite could not connect, reported `0/0 steps passed`, and **exited 0** — so the E2E check went green while testing nothing, for any change, indefinitely. `coverage.mjs` now exits non-zero when the suite aborts or when no steps ran, so that failure mode is loud.

**Guarding production.** Local `.env` points at production so `npm run dev` works against real data, which is exactly the wrong target for these suites — they create and *delete* real auth users. `scripts/production-refs.js` holds the production refs, and `test:e2e`, `test:integration`, and `test:mobile` all refuse to run against one before making any request. Override per-run:

```bash
VITE_SUPABASE_URL=https://<test-ref>.supabase.co \
SUPABASE_SECRET_KEY=<test-secret> npm run test:e2e
```

`ALLOW_PRODUCTION_WRITES=1` bypasses the guard; it exists for deliberate one-offs, not routine use. Add new production refs to `PRODUCTION_REFS` in `scripts/production-refs.js`.

**Nightly.** [`.github/workflows/nightly.yml`](.github/workflows/nightly.yml) runs `npm run test:integration` (RLS isolation, the signup trigger, admin self-promotion) at 07:00 UTC, against the same local stack. Too slow for the per-PR gate, and previously ran only when someone remembered — which is how a stray test account once reached the production auth table. `workflow_dispatch` triggers a run on demand.

The live-AI tests (`RUN_AI_TESTS=1` / `USE_REAL_AI=1`) remain manual, since they spend real API credit. See [`docs/TESTING.md`](docs/TESTING.md) for the full test surface.

## To-do

- [x] **Set up CI.** GitHub Actions (`.github/workflows/ci.yml`) runs `npm test` (unit + import logic) on pushes to `dev`/`master` and on PRs into `master`. The `npm run test:e2e` Playwright suite also runs on PRs into `master`, against a **local Supabase stack in Docker** (paid APIs stubbed). Branch protection on `master` requires both the unit suite and the E2E suite to pass before merging. `npm run test:integration` and `npm run test:mobile` run nightly (`.github/workflows/nightly.yml`); the live-AI tests (`RUN_AI_TESTS=1` / `USE_REAL_AI=1`) remain manual. See `docs/TESTING.md` for the full test surface.
- [x] Confirm `GEMINI_API_KEY` is set in the Vercel project env so the Anthropic→Gemini fallback works in production.
- [x] Open a PR `dev` → `master` to ship the StoryGraph + AI-assisted import work.

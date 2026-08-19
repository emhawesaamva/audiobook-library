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
- **Connect your own AI** — mint a token in Settings and point Claude (or any MCP client) at `https://audiolib.io/api/mcp`. It reads your taste and writes to your library, but does no thinking of its own: *your* model does the recommending, grounded in what you've loved.
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
| MCP | `api/mcp.js` — connect Claude to a library ([design](docs/DESIGN-mcp-server.md)) |

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
npm run db:reset      # apply supabase/migrations/* onto a clean database, then seed
npm run db:use-local  # point .env at the local stack (backs up your hosted .env)
```

`npm run db:stop` shuts it down. Studio is at http://127.0.0.1:54323.

**Seeding the local stack.** A reset otherwise leaves an empty database and no way
in, so it is seeded with a test account and library, and the sign-in details are
printed at the end.

```bash
npm run db:capture     # record the current local library as the seed
npm run db:seed        # re-apply it without a reset
npm run db:clone-prod  # rebuild the seed from the hosted project
```

`db:capture` writes two files, both gitignored because a capture is somebody's
real library and this repo is public:

- `supabase/seed-data.json` — the source of truth, applied over the REST API by
  `npm run db:seed`.
- `supabase/seed.sql` — generated from it, and run by the Supabase CLI's own
  `[db.seed]` hook. This is what makes a bare `npx supabase db reset` seed
  identically to `npm run db:reset`; the CLI hook only takes `.sql` files, so it
  cannot call the script directly.

Arrange the books you want in the UI, run `db:capture`, and every later reset
restores exactly that. With no seed files present both paths are no-ops, so a
fresh clone still works.

Because those files are gitignored, a fresh clone — or a machine that lost its
local stack — has no seed to start from. `npm run db:clone-prod` is the way back:
it reads a library out of the hosted project into `seed-data.json`, which
`db:seed` then applies (regenerating `seed.sql` as it goes).

```bash
npm run db:clone-prod                # the sole account, or $OWNER_EMAIL
npm run db:clone-prod -- a@b.com     # a specific account
npm run db:seed
```

It reads the hosted credentials from `.env.hosted-backup` (the copy `db:use-local`
sets aside; override with `PROD_ENV_FILE`) through a client that can only issue
`GET`, so it cannot write to the hosted project, and it touches nothing but the
JSON file.

**Guards.** `seed-local.mjs` refuses to run against the production project or any
non-loopback URL. The generated SQL aborts if the database already holds accounts
other than the seed one — which is what stops `supabase db reset --linked`, which
targets the *linked* (production) project, from seeding over real data.

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
| `npm run deploy:quick -- "msg"` | Push a minor change straight to master, skipping the PR gate (see below) |

## Environment variables

Where each one actually lives — worth checking here before hunting through
`app_settings`, `vault.secrets`, or edge functions:

| Variable | Local `.env` | Vercel | Notes |
|---|---|---|---|
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | yes | points at production in both; bundled into the frontend |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | yes | yes | server-side only; secret key is service role — bypasses RLS |
| `ANTHROPIC_API_KEY` | yes | yes | |
| `GEMINI_API_KEY` | placeholder locally | **yes** | fallback only fires on credit exhaustion |
| `OWNER_EMAIL` | yes | no | local tooling only, one-time legacy migration |

## Connect an AI assistant (MCP)

Settings → **Connect an AI assistant** mints a personal access token, then:

```bash
claude mcp add --transport http audiolib https://audiolib.io/api/mcp \
  --header "Authorization: Bearer alib_..."
```

Ask "what should I listen to next?" and the assistant pulls your taste profile,
reasons over it itself, checks each pick against Audible's catalogue and your
Libby library, and shows you links and waits. Say you placed a hold and it
records one; say you want a book and it adds it. Nothing is written until you
ask for it.

**The server never calls an AI.** That is the point — your client already has a
model, and paying twice for the same recommendation would be silly. It hands
over the grounding (`get_taste_profile`) and the lookups (`search_catalog`,
`check_availability`) and lets your model do the thinking. See
[`docs/DESIGN-mcp-server.md`](docs/DESIGN-mcp-server.md).

**A token is bound to one library.** Not to your account — to the library it was
created under. It cannot see or touch your others, and you can revoke it from
the same panel. The one exception is your Libby library code, which the schema
keys on the account; the UI says so where you create the token.

Tokens are generated in the browser and only their SHA-256 is stored, so the raw
value is shown exactly once and cannot be recovered. Read-only tokens are
available for an assistant you want to let look but not touch.

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

**The quick path, and what it costs.** `npm run deploy:quick -- "what changed"` commits the working tree to `master` and pushes, which Vercel deploys — no PR, no waiting on the gate. It is for copy tweaks, label changes, spacing: things where the seven-minute round trip costs more than it protects.

It is not gate-free by accident. It still runs `npm test` and `npm run build` first, because together they take about two seconds and catch the syntax error that would white-screen the whole SPA. It refuses outright to ship changes under `supabase/`, `api/`, `.github/`, `package.json`, or `vercel.json` — those alter behaviour no fast check can see — and `--force` overrides both if you are certain. Afterwards it watches `audiolib.io` until the new bundle is actually serving, and prints the commit to roll back to.

What it gives up is exactly the Playwright coverage: a rename that breaks a selector, a layout that overflows at 320px. Those suites still run on the push, so the failure lands in Actions a few minutes later — you find out after users could, rather than before. That happened on the "Listening" → "Reading" rename: the fast checks passed and E2E caught a stale selector. Use the gate when a change touches anything a person clicks; use this when it doesn't.

To close this path entirely, turn on "Do not allow bypassing the above settings" in the `master` branch protection rule — the script relies on `enforce_admins` being off, and reports clearly when a push is rejected.

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

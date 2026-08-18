# Testing

All routine test commands are deterministic and free — the paid/external APIs
(the AI proxy and the Audible metadata proxy) are **stubbed by default**. Each
external-dependent suite has a `USE_REAL_AI=1` (or `RUN_AI_TESTS=1`) opt-out to
run against the live services when you want true end-to-end confirmation.

> **Forced AI in tests uses Gemini, not Claude.** When you opt into real AI, the
> requests are tagged so the proxy skips Anthropic and goes straight to Gemini
> (`x-force-gemini` header → `handleMessages` in `api/_lib/messages-core.js`).
> This keeps test runs off Anthropic credits. Requires `GEMINI_API_KEY` in `.env`.

## Quick reference

| Command | What it runs | External APIs | Needs dev server |
|---------|--------------|---------------|------------------|
| `npm test` | Unit / integration of pure logic | none | no |
| `npm run test:e2e` | Full desktop functional E2E (27 flows) | stubbed | **yes** |
| `npm run test:mobile` | Mobile layout audit (390px + 320px) | stubbed | **yes** |
| `npm run test:integration` | Supabase auth/RLS checks | live Supabase | no |
| `RUN_AI_TESTS=1 node --test test/ai-live.test.js` | Live column-mapping via Gemini | **live Gemini** | no |
| `USE_REAL_AI=1 npm run test:e2e` | Desktop E2E against real APIs (AI via Gemini) | **live** | yes |
| `USE_REAL_AI=1 npm run test:mobile` | Mobile audit against real content (AI via Gemini) | **live** | yes |

> Windows note: the env-var commands above use POSIX syntax. In PowerShell use
> `$env:RUN_AI_TESTS=1; node --test test/ai-live.test.js` (and unset after).

## Unit / integration (`npm test`)

Pure functions, no network — runs in well under a second:

- `test/csv.test.js` — CSV parsers, the tier-2 `parseWithMapping`, tier-3
  `detectMalformedRows`, format detection.
- `test/ai-helpers.test.js` — pure helpers of the AI import path
  (`parseMappingResponse`, `mergeRepairedRows`).
- `test/importPipeline.test.js` — the import cascade orchestration (tier-1 happy
  path + error paths), no network.
- `test/messages-core.test.js` — the `/v1/messages` proxy core (credit-exhaustion
  detection + Anthropic↔Gemini fallback translation).

## Desktop functional E2E (`npm run test:e2e`)

`scripts/ui-test/coverage.mjs` — drives a real browser through 27 user flows
(auth, library create + onboarding, add/edit/delete books, filters/search/sort,
views, Up Next, stats, recommend, import incl. AI-mapped + series + paste,
export, settings, second library, sharing, theme). Self-provisions and tears
down its own Supabase account. Stubs Claude + Audible deterministically.

## Mobile layout audit (`npm run test:mobile`)

`scripts/ui-test/mobile-audit.mjs` — iPhone-portrait (390px) plus a 320px stress
pass. Measures horizontal overflow, tap-target sizes, and dialog geometry across
the shell, add dialog, all three views, card menu/Up Next, stats, recommend,
settings, **share / paste / import-confirm / series dialogs**, and the
**public-profile** read-only view. Uses deliberately **layout-adversarial
fixtures** (very long titles, many narrators, long blurbs) so worst-case
wrapping is re-tested every run. Produces findings + screenshots, not pass/fail.

## Live AI (`RUN_AI_TESTS=1` / `USE_REAL_AI=1`)

The stubs verify *our* integration; these verify the *seam* with the provider.
Run them: before a deploy, after changing a prompt / model id / response shape /
the proxy, or on a schedule. They go through **Gemini** (see the note at the top)
and need `GEMINI_API_KEY`. `ai-live.test.js` retries transient Gemini "high
demand" errors so a green/red result reflects code health, not provider load.
See `docs/DESIGN-ai-assisted-imports.md` for the stubbing rationale.

## Prerequisites

- `npm run dev` running on `:5173` for the E2E and mobile suites.
- `.env` with `VITE_SUPABASE_URL`, `SUPABASE_SECRET_KEY` (self-provisioning test
  accounts) and `GEMINI_API_KEY` (for live AI runs).

# Design note: AI-assisted imports

Status: **Implemented (tiers 1–3 + confirmation)** · Last updated: 2026-06-17

## How it's wired (implementation)

- `src/lib/csv.js` — tier-1 parsers (unchanged) plus the tier-2/3 primitives:
  `parseWithMapping(text, {mapping, statusMap})` (deterministic mapping-based
  parser), `detectMalformedRows(books)` (tier-3 trigger), and the shared
  `MAPPABLE_FIELDS` / `VALID_STATUSES` constants.
- `src/lib/ai.js` — `inferImportMapping({header, sampleRows})` (tier 2) and
  `repairImportRows(books, flagged)` (tier 3), with pure helpers
  `parseMappingResponse` and `mergeRepairedRows` factored out for testing.
- `src/lib/importPipeline.js` — `parseImportFile(text, filename)` orchestrates
  the cascade and returns `{ books, errors, note, format, sourceLabel, aiUsed,
  aiMapped, mapping, repairedCount }`. Both callers share it.
- `src/components/ImportConfirm.jsx` — the confirmation preview, shown by
  `Settings.jsx` and `OnboardingWizard.jsx` whenever `result.aiUsed` is true.

Tests: `npm test` (offline — `test/csv.test.js`, `test/ai-helpers.test.js`,
`test/importPipeline.test.js`). A gated live smoke test against the real API:
`RUN_AI_TESTS=1 node --test test/ai-live.test.js`.

---

## Original decision record

Status when written: **Decided, not yet built** · 2026-06-17

## Problem

Imports today rely on deterministic parsers (`src/lib/csv.js`) that recognize a
fixed set of exports — Goodreads, StoryGraph, Audible Library Extractor (JSON +
CSV), and Libby (CSV + JSON) — by sniffing header columns
(`detectImportFormat`). This works perfectly when a file matches a known shape,
but it fails — silently or completely — when:

- The file is from a service we don't have a parser for.
- A known service renamed/reordered columns so a field maps to nothing
  (comes through `null` with no error).
- Values are dirty within an otherwise-recognized format (bad dates, garbled
  text, unexpected status strings that silently default to `wanttoread`).

Goal: imports should "always get it right" even when the data isn't exactly in
the expected shape — without sending entire libraries to an LLM on every import.

## Core principle

**Use Claude for the fuzzy judgment; keep deterministic code for the bulk work.**
The LLM decides *what this file is* and *what each column means*; our existing
row loop parses the thousands of rows. This keeps cost flat regardless of library
size and keeps row parsing as fast and reliable as it is today.

## Decided approach — tiered cascade, tiers 1–3

| Tier | Behavior | AI? | Confirmation? |
|------|----------|-----|---------------|
| 1 | Deterministic detect + parse (today's code) | No | No |
| 2 | AI **column mapping** when detection fails or columns are unmapped | Yes | **Yes** |
| 3 | AI **repair pass** on detectably-malformed rows | Yes | **Yes** |

### Tier 1 — deterministic (exists)
Unchanged. Clean Goodreads/StoryGraph/Audible/Libby exports cost nothing and
never invoke AI.

### Tier 2 — AI column mapping
Trigger: `detectImportFormat` returns `null`, or a known format leaves required
fields unmapped. Send the **header row + a small sample of data rows** (not the
whole file) to Claude; get back a structured mapping object
(`{ ourField: theirColumn }`) plus value-translation hints (e.g. status string
→ our status enum). The existing deterministic loop then parses all N rows using
that mapping. One cheap call regardless of library size; mapping is auditable and
cacheable.

Requires refactoring the parsers to accept a mapping object rather than
hardcoded column names. This refactor is also what makes adding the *next*
service trivial.

### Tier 3 — AI repair pass
Trigger: rows that come out **detectably** malformed after parsing — empty
required field, regex-failed date, non-coercible number, obviously garbled text.
Send only those rows to Claude for normalization, merge results back.

Cheap to run (fires rarely, only on the bad rows) and cheap to build. **Known
limitation:** it only catches *loud* failures. Our parsers fail silently and
safely — an unrecognized status quietly becomes `wanttoread`
(`csv.js`), a non-numeric rating quietly becomes `null` — so those rows look
clean and won't trigger repair. The confirmation layer (below) is what catches
those silent cases.

Build order note: ship Tier 2 first, observe what actually comes through broken
in practice, and build Tier 3 against real examples rather than hypothetical ones.

## Confirmation layer (cross-cutting)

**Rule: any time AI is involved in an import, the user confirms before it lands.**

- Deterministic-only imports (Tier 1) stay silent, exactly as today.
- The moment Tier 2 or Tier 3 fires, show a preview before committing:
  the inferred column mapping + a sample of parsed rows
  ("we read this as: Title ← Book Name, Author ← Writer … import anyway?").
- Implementation is a single gate keyed off one boolean ("did any AI step run?")
  — no confidence-threshold tuning.

Rationale: Tier 2 can be *confidently wrong* (map "rating" to the wrong column)
and silently corrupt a whole import. A human spots "why is everything marked
want-to-read" instantly — something no row-level heuristic will. The preview and
the repair pass catch different halves of the problem.

## Deferred (not in this scope)

- **Full-file AI parse** — send the entire file to Claude, get normalized JSON.
  Token-bound (a large Goodreads export won't fit) and most expensive per import.
  Reserve as a last resort for small/exotic files only.
- **Vision / screenshot import** — read a library screenshot or PDF via Claude
  vision. This is **competitive parity with AudiobookLog** (which markets
  screenshot import), not just "more AI." Tracked as a known gap, not forgotten.

## Existing plumbing to build on

- `src/lib/ai.js` already calls Claude (Haiku) via the dev-server proxy for the
  "Paste a List" feature — the same pattern extends to mapping/repair.
- `detectImportFormat` already returns a clean `null` failure signal to branch on.
- `src/lib/importBooks.js` (`runImport`) is the shared pipeline (dedupe, enrich,
  series grouping) that AI-parsed books would feed into unchanged.

# To-do

Last reviewed: 2026-08-18.

---

## 1. Known gaps and open questions

### Series headers never show availability
Only volumes are checked, since a header has no status of its own. A header for a
series you want shows no badge at all. An aggregate ("3 of 5 available") would be
better but needs a rule for mixed states.

### The Anthropic → Gemini fallback has never actually run
`app_settings` has no `ai_credit_exhausted` row, so the path has never fired in
production. It has unit tests (`test/messages-core.test.js`), but the real
Anthropic error shape has never been observed. Worth a deliberate test the next
time credit is intentionally exhausted.

***

## 2. Smaller items

- **Bundle size.** The production build emits a >500KB chunk warning. Code-splitting
  the Admin tab and the import pipeline would be the obvious first cut.

- **E2E does not cover** the availability badges (the test account has no library
  code configured, so no lookup fires), the drawer's hover/pin behaviour, or the
  Admin tab (needs an admin-flagged account). OAuth and email-confirmation flows
  are deliberately out of scope — see the header comment in `coverage.mjs`.

- **`libbySearchUrl`'s no-library fallback** points at `overdrive.com/search` with
  no language filter, while every other Libby link is pinned to `language-en`.

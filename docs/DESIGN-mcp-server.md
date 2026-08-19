# The MCP server

`https://audiolib.io/api/mcp` lets an MCP client — Claude Code, Claude Desktop —
read and update one AudioLib library. This is the reasoning behind its shape.

## Why it exists, and why it does no inference

The app already has AI features, and they all work the same way: the app builds
a prompt, calls Claude through `/v1/messages`, and pays for the tokens. That is
the app doing reasoning on the user's behalf.

An MCP server inverts the relationship. The connecting client *already has* a
model, and its own subscription. What it lacks is the library. So this server
stores things and looks things up, and **never calls a model** — the whole point
would be lost if it did, and the user would be paying twice.

The consequence worth stating plainly: there is no `recommend` tool. Instead
`get_taste_profile` returns the same grounding `fetchRecommendations` assembles
in `src/lib/ai.js` — loved books and authors, genres, what they're listening to
now, what they abandoned, everything they already own — rendered as a block the
client's model drops into its own prompt. The model reasons, `search_catalog`
verifies the picks are real books, `check_availability` says whether the library
lends them, and nothing is written until the listener asks for it.

`api/_lib/mcp-*.js` must never import `api/_lib/messages-core.js`. That is the
invariant this whole design rests on.

## What the server can and cannot make a client do

An MCP server is passive. It cannot observe the conversation, cannot detect that
a recommendation was asked for, and cannot inject anything unprompted. So the
workflow is *steered*, not enforced, by four mechanisms in descending strength:

1. **The `recommend_from_my_library` prompt** — deterministic, because the
   listener invokes it directly. Returns the taste block already wrapped as a
   request.
2. **The server `instructions` string** — the one thing every client reads before
   it picks a tool.
3. **Trigger-shaped tool descriptions** — `get_taste_profile` opens with "Call
   this FIRST, before answering, whenever…".
4. **`next_step` on every response** — each call names the tool that follows it,
   so the model is never guessing the sequence.

A model that ignores all four and answers from general knowledge will produce
plausible-looking picks with no grounding. That failure mode is invisible unless
you look for it, which is why the verification checklist includes asking for a
recommendation obliquely and confirming the tool still gets called.

## Authentication: one token, one library

A personal access token (`alib_` + 32 random bytes, base64url) is minted in
Settings and bound to a single `profiles` row — not to an account. Every query
`api/_lib/mcp-scope.js` builds carries that `profile_id`.

**The token is generated in the browser.** This app has no application backend,
and a mint endpoint would put the raw secret through a serverless function where
it can land in a request log. `createMcpToken` in `src/lib/db.js` generates it,
sends only its SHA-256, shows the raw value once, and never stores it.

**SHA-256, unsalted, is the right choice here** even though it would be wrong for
a password. The secret is 256 bits of CSPRNG output: there is no dictionary to
slow down and offline brute force is infeasible. An unsalted digest is also what
makes the lookup a single indexed `token_hash=eq.…` rather than a table scan
verifying every row with a KDF.

### Why the service key, and not RLS

Every other data path in this app is authorized by Postgres RLS keyed on
`auth.uid()`. This one cannot be: the server holds a token, not a user JWT, so
it calls PostgREST with the service key and **RLS does not apply**.

Minting a short-lived JWT with `sub = account_id` was considered and rejected:
the project JWT secret is not in the deployed env set; RLS is scoped per
*account*, so it would not enforce the single-library property anyway and
`mcp-scope.js` would still be needed; and Supabase's publishable/secret key model
deprecates hand-rolled JWTs.

That makes `api/_lib/mcp-scope.js` the authorization boundary. It is deliberately
small and boring so it can be read end to end. Its rules:

- every read carries the bound `profile_id` (or `account_id`)
- every id-targeted write filters on **both** `id` and `profile_id`, so a forged
  id matches zero rows and surfaces as "No such book in this library" rather
  than a silent success
- inserts are shaped with `cleanBookFields` and stamped with the bound
  `profile_id` **last** — load-bearing, because `profile_id` *is* in the
  `BOOK_COLUMNS` allowlist and would otherwise survive cleaning
- shaping happens at the boundary, not in the callers, so the guarantee does not
  depend on `mcp-tools.js` continuing to behave
- only an allowlist of tables is reachable at all
- ids are shape-checked and filter values URL-encoded. **Do not copy
  `api/_lib/admin-core.js`**, which interpolates ids raw — safe there because the
  value came from a verified admin, unsafe here because values arrive from an
  LLM. An unescaped `&or=(…)` in a filter value is a full scope escape.

A stronger future option is a `security definer` Postgres function that takes the
token hash and does the scoping in SQL. It would also give real transactions,
which PostgREST cannot.

### The one exception: the Libby key

`set_libby_key` writes `user_settings`, which is keyed on `account_id`. Setting
it through a library-scoped token therefore changes behaviour for **every**
library on the account, and Settings.jsx already labels the field "applies to
your whole account".

This is deliberate — availability checking is useless without it, and the guided
flow depends on being able to ask for and save it mid-conversation. The blast
radius is small (a public library slug, not a credential), it is stated in the
tool description and in the token-creation UI, and it should stay the only place
a token reaches outside its library.

## What is deliberately absent

- **Admin anything.** Nothing from `src/components/Admin.jsx`; `accounts`,
  `app_settings` (beyond one SELECT of `affiliate_tag`) and `feedback` are not in
  the table allowlist.
- **Import and export.** The Goodreads/Libby/StoryGraph merge pipeline stays in
  the UI. `add_books` is a plain create. This also keeps `src/lib/csv.js` and
  `src/lib/importBooks.js` out of the serverless bundle.
- **Recommendation storage, and therefore rejection.** Recommendations live in
  the conversation, so there is nothing to reject; `rejected_recommendations` is
  unreachable.
- **Goals.** `reading_goals` is unreachable.
- **Creating or deleting libraries.** A token can rename the one it is bound to
  and change its age group. Nothing more.

## Known weaknesses

- **Age-group enforcement is advisory.** The in-app recommender puts the audience
  rule in a server-controlled system prompt. Here it can only be *handed* to a
  client-side model via `get_taste_profile`'s `guidance` field and the server
  instructions. This is genuinely weaker, and it matters most for `children`
  libraries.
- **Prompt injection through library content.** `get_taste_profile` funnels
  library text into a prompt the model is told to act on, and `description` comes
  from Audible. Mitigated by truncating descriptions and excluding `notes` from
  the rendered block entirely — titles, authors, ratings and DNF reasons are
  enough grounding.
- **No transactions.** `set_up_next`, `create_series` and bulk writes can
  partially apply. Each is idempotent and returns the resulting state so the
  client can verify rather than assume.
- **The share-link coupling.** A token's `profile_id` is also its library's share
  URL id, so a leaked token reveals the public share link. Not a new exposure
  (`profiles` and `books` are anon-readable for `/share/:profileId`), but worth
  knowing.

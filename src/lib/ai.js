// Claude integration: book recommendations and quick book identification.
// Requests go to /v1/messages, proxied server-side so the API key never
// reaches the browser (Vite dev proxy locally, Vercel function in prod).
import { getStatus, audienceInstruction, ADULT_AUDIENCE_GUIDANCE } from "./bookUtils.js";
import { MAPPABLE_FIELDS, VALID_STATUSES } from "./csv.js";

export async function claudeFetch(body, extraHeaders = {}) {
  const r = await fetch("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error(text.slice(0, 120)); }
}

export function extractJSON(txt) {
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start !== -1) return txt.slice(start, i + 1); }
  }
  return null;
}

// Shared recommendation engine used by the manual search UI and the
// auto-recommend background job. Returns { recommendations: [...], note }.
export async function fetchRecommendations({ books, profileName, ageGroup, query, model, maxTokens = 4000 }) {
  const lovedBooks = books.filter((b) => b.loved || Number(b.rating) >= 5);
  const loved = lovedBooks.map((b) => b.title).join(", ");
  const lovedAuthors = [...new Set(lovedBooks.map((b) => b.author).filter(Boolean))];
  const lovedGenres = [...new Set(lovedBooks.map((b) => b.subgenre || b.genre).filter(Boolean))];
  const reading = books.filter((b) => getStatus(b) === "reading").map((b) => b.title).join(", ");
  const audience = audienceInstruction(ageGroup);

  const sys = `You are an audiobook recommendation engine for ${profileName}. They listen exclusively on Audible.

${audience ?? ADULT_AUDIENCE_GUIDANCE}

LOVED BOOKS: ${loved || "not yet established"}
LOVED AUTHORS: ${lovedAuthors.join(", ") || "not yet established"}
ENJOYED GENRES: ${lovedGenres.join(", ") || "not yet established — default to adult fiction"}
READING NOW: ${reading || "nothing"}

Only recommend real, well-known audiobooks you are confident exist.

Return JSON only, no markdown:
{"headline":"one short, punchy, enthusiastic sentence reacting to what they asked for — make them excited to scroll; no emoji","recommendations":[{"title":"","author":"","year":"","why":"one direct line","similarity":"most like: [title]","genre":"Science Fiction","subgenre":""}],"note":""}`;

  const d = await claudeFetch({
    model: model || "claude-sonnet-5",
    max_tokens: maxTokens,
    system: sys,
    messages: [{ role: "user", content: query }],
  });

  if (d.error) throw new Error(d.error.message);
  const allText = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const jsonStr = extractJSON(allText);
  if (!jsonStr) throw new Error("No JSON found in response");
  const parsed = JSON.parse(jsonStr);
  const recs = (parsed.recommendations ?? []).filter((r) => r.title && r.author);
  return { recommendations: recs, note: parsed.note ?? "", headline: parsed.headline ?? "" };
}

// Turn arbitrary pasted text (notes-app lists, numbered lists, random junk)
// into a structured book list for the paste importer.
export async function identifyBookList(text) {
  const d = await claudeFetch({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    system: `You convert messy pasted text into a structured list of books. The text may have numbering, bullets, emoji, dates, page numbers, half-remembered titles, or commentary mixed in. Extract every book you can identify.

Return JSON only, no markdown:
{"books":[{"title":"","author":null,"status":null}],"note":""}

Rules:
- title: the book's proper title with correct capitalization; fix obvious typos.
- author: the author if stated or if you are confident who wrote that well-known book; otherwise null. Never guess obscure attributions.
- status: ONLY when the text clearly signals it — "read"/"finished" -> "read", "reading"/"currently" -> "reading", "want"/"to read"/"tbr" -> "wanttoread". Otherwise null.
- Skip lines that are clearly not books; if you skip things or are unsure about an entry, say so briefly in note.
- Never invent books that are not in the text.`,
    messages: [{ role: "user", content: text.slice(0, 10000) }],
  });
  if (d.error) throw new Error(d.error.message);
  const allText = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const json = extractJSON(allText);
  if (!json) throw new Error("Couldn't make sense of that list");
  const parsed = JSON.parse(json);
  return {
    books: (parsed.books ?? []).filter((b) => b.title?.trim()),
    note: parsed.note ?? "",
  };
}

// ---- AI-assisted imports: column mapping (tier 2) & row repair (tier 3) ----

// Pure validation of Claude's mapping response. Exported for testing. Keeps only
// recognized fields mapped to non-empty column names, and only status
// translations whose target is a valid status. Throws if no usable mapping.
export function parseMappingResponse(text) {
  const json = extractJSON(text);
  if (!json) throw new Error("Couldn't read the file's structure");
  const parsed = JSON.parse(json);

  const mapping = {};
  for (const [field, col] of Object.entries(parsed.mapping ?? {})) {
    if (MAPPABLE_FIELDS.includes(field) && typeof col === "string" && col.trim())
      mapping[field] = col.trim();
  }
  if (!mapping.title) throw new Error("Couldn't find a title column in this file");

  const statusMap = {};
  for (const [raw, status] of Object.entries(parsed.statusMap ?? {})) {
    if (VALID_STATUSES.includes(status)) statusMap[String(raw).toLowerCase().trim()] = status;
  }
  return { mapping, statusMap, note: parsed.note ?? "" };
}

// Tier 2: ask Claude to map an unknown CSV's columns onto our fields. Sends only
// the header + a small sample of rows (not the whole file) — one cheap call
// regardless of library size. Returns { mapping, statusMap, note }.
export async function inferImportMapping({ header, sampleRows }) {
  const sample = [header, ...sampleRows.slice(0, 5)]
    .map((row) => row.map((c) => (c ?? "").slice(0, 80)).join(" | "))
    .join("\n");

  const d = await claudeFetch({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1500,
    system: `You map the columns of an unknown book-list CSV onto a fixed set of fields. You are given the header row and a few sample data rows (pipe-separated).

Our fields (map each to the source COLUMN NAME exactly as it appears in the header, or omit if absent):
- title (required), author, status, rating (0-5 personal rating), date_finished, date_started, year (publication year), isbn, asin, narrator, duration_minutes, series_title, series_position, notes, tags, read_count (total times read), goodreads_rating (community/average rating).

Also provide statusMap: translate each distinct raw value in the status column to one of: ${VALID_STATUSES.join(", ")}. ("read"=finished, "reading"=in progress, "wanttoread"=to-read/TBR, "dnf"=did not finish, "recommended"=recommended to them).

Return JSON only, no markdown:
{"mapping":{"title":"<col>","author":"<col>"},"statusMap":{"<raw value>":"read"},"note":"anything ambiguous"}

Only include fields you are confident about. Use the exact column names from the header. If there is no status column, omit status and statusMap.`,
    messages: [{ role: "user", content: sample }],
  });
  if (d.error) throw new Error(d.error.message);
  const allText = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return parseMappingResponse(allText);
}

// Pure merge of repaired rows back into the full book list. Exported for testing.
// `repaired` aligns to `flagged` order; each entry's fields overwrite the
// original at flagged[i].index. Clears _unparsed on touched rows.
export function mergeRepairedRows(books, flagged, repaired) {
  const out = books.slice();
  flagged.forEach((f, i) => {
    const fix = repaired[i];
    const merged = { ...out[f.index] };
    if (fix && typeof fix === "object") {
      for (const [k, v] of Object.entries(fix)) {
        if (v !== null && v !== undefined && v !== "") merged[k] = v;
      }
    }
    delete merged._unparsed; // internal marker — never persists past repair
    out[f.index] = merged;
  });
  return out;
}

// Tier 3: send only the detectably-malformed rows to Claude for normalization.
// Returns the full book list with those rows repaired. Best-effort: on any
// failure the original books are returned unchanged.
export async function repairImportRows(books, flagged) {
  if (!flagged.length) return books;
  const payload = flagged.map((f, i) => ({
    i,
    problems: f.reasons,
    row: { ...f.book, _unparsed: undefined },
  }));

  try {
    const d = await claudeFetch({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: `You fix malformed book records from a library import. Each item has an index "i", a list of "problems", and the parsed "row". Return corrected rows.

Rules:
- Keep the same "i" for each row so it can be matched back.
- Fix only the flagged problems; preserve good values. Correct obvious title garbling, swap author/title if reversed, drop out-of-range numbers (set null), and convert any date to YYYY-MM-DD.
- status must be one of: ${VALID_STATUSES.join(", ")}.
- Never invent books not present in the input.

Return JSON only, no markdown:
{"rows":[{"i":0,"title":"","author":null,"status":null,"date_finished":null,"rating":null,"year":null}]}`,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });
    if (d.error) throw new Error(d.error.message);
    const allText = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const json = extractJSON(allText);
    if (!json) return books;
    const parsed = JSON.parse(json);
    const rows = parsed.rows ?? [];
    // Reorder by "i" so merge aligns with flagged order even if Claude reorders.
    const byIndex = new Map(rows.filter((r) => Number.isInteger(r.i)).map((r) => [r.i, r]));
    const aligned = flagged.map((_, i) => byIndex.get(i) ?? null);
    return mergeRepairedRows(books, flagged, aligned);
  } catch {
    return books; // best-effort; fall back to the (skipped/null) parsed rows
  }
}

// Quick identification of a book from a free-text description (Add form).
export async function identifyBook(query, profileName) {
  const d = await claudeFetch({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `Identify the most likely audiobook from the user's description. ${profileName} listens on Audible. Return JSON only, no markdown:
{"title":"","author":"","genre":"","subgenre":"","series":false,"seriesName":""}
genre: one of Science Fiction, Fantasy, Horror, Thriller, Mystery, Romance, Historical Fiction, Literary Fiction, Nonfiction, Memoir, Biography, Young Adult, Children, Other.
subgenre: short descriptor like "Cyberpunk", "Space Opera", "Grimdark", "High Fantasy", or similar.
series/seriesName: whether the book is part of a series and its name.
If you cannot identify the book, return {"error":"not found"}.`,
    messages: [{ role: "user", content: query }],
  });
  if (d.error) throw new Error(d.error.message);
  const txt = d.content?.find((b) => b.type === "text")?.text ?? "";
  const parsed = JSON.parse(txt.replace(/```json|```/g, "").trim());
  if (parsed.error) return null;
  return parsed;
}

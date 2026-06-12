// Claude integration: book recommendations and quick book identification.
// Requests go to /v1/messages, proxied server-side so the API key never
// reaches the browser (Vite dev proxy locally, Vercel function in prod).
import { getStatus } from "./bookUtils.js";

export async function claudeFetch(body) {
  const r = await fetch("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

function audienceInstruction(ageGroup) {
  if (ageGroup === "children")
    return "AUDIENCE: This library belongs to a child. Only recommend age-appropriate audiobooks for children. Exclude all teen, adult, or mature content — no violence, horror, romance, or adult themes of any kind.";
  if (ageGroup === "teens")
    return "AUDIENCE: This library belongs to a teenager. Only recommend Young Adult (YA) audiobooks. Age-appropriate fantasy, sci-fi, adventure, and coming-of-age are welcome. Exclude explicit sexual content, extreme gore, and adult-only themes.";
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

${audience ?? "IMPORTANT: Recommend adult fiction audiobooks only. Interpret all queries in the context of adult literature — never recommend children's books, picture books, or middle-grade fiction unless explicitly requested."}

LOVED BOOKS: ${loved || "not yet established"}
LOVED AUTHORS: ${lovedAuthors.join(", ") || "not yet established"}
ENJOYED GENRES: ${lovedGenres.join(", ") || "not yet established — default to adult fiction"}
READING NOW: ${reading || "nothing"}

Only recommend real, well-known audiobooks you are confident exist.

Return JSON only, no markdown:
{"recommendations":[{"title":"","author":"","year":"","why":"one direct line","similarity":"most like: [title]","genre":"Science Fiction","subgenre":""}],"note":""}`;

  const d = await claudeFetch({
    model: model || "claude-sonnet-4-6",
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
  return { recommendations: recs, note: parsed.note ?? "" };
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

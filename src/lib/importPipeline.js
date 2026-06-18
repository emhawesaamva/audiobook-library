// Tiered import cascade (see docs/DESIGN-ai-assisted-imports.md):
//   Tier 1 — deterministic parse of recognized exports (no AI).
//   Tier 2 — unknown format: AI infers a column mapping, then we parse locally.
//   Tier 3 — repair detectably-malformed rows via AI (applies to any path).
// Whenever AI is involved (tier 2 or tier 3), the caller must confirm with the
// user before the books are committed (result.aiUsed === true).
import {
  detectImportFormat, parseGoodreadsCSV, parseLibbyCSV, parseLibbyJSON,
  parseAudibleJSON, parseAudibleCSV, parseStorygraphCSV,
  parseCSV, parseWithMapping, detectMalformedRows,
} from "./csv.js";
import { inferImportMapping, repairImportRows } from "./ai.js";

const LABELS = {
  goodreads: "Goodreads", storygraph: "StoryGraph", libby: "Libby",
  "libby-json": "Libby", audible: "Audible", "audible-csv": "Audible",
};

const isJSON = (text, filename) =>
  filename.endsWith(".json") || text.trimStart().startsWith("{") || text.trimStart().startsWith("[");

function runDeterministic(format, text) {
  switch (format) {
    case "goodreads": return parseGoodreadsCSV(text);
    case "libby": return parseLibbyCSV(text);
    case "libby-json": return parseLibbyJSON(text);
    case "audible": return parseAudibleJSON(text);
    case "audible-csv": return parseAudibleCSV(text);
    case "storygraph": return parseStorygraphCSV(text);
    default: return { books: [], errors: ["Unrecognized format"] };
  }
}

// Parse an uploaded file through the cascade. Returns:
//   { books, errors, note, format, sourceLabel, aiUsed, aiMapped, mapping, repairedCount }
// Throws only on a hard AI failure during mapping (caller should toast).
export async function parseImportFile(text, filename = "") {
  const fname = filename.toLowerCase();
  const format = detectImportFormat(text, fname);

  let result, sourceLabel, aiMapped = false, mapping = null;

  if (format) {
    result = runDeterministic(format, text);
    sourceLabel = LABELS[format] ?? "your file";
  } else {
    // Tier 2 — unknown format. We can only auto-map tabular CSV data; an
    // unrecognized JSON file has no reliable column structure to infer.
    if (isJSON(text, fname)) {
      return {
        books: [], errors: ["This file isn't a recognized export. Auto-mapping only works on CSV files — try a CSV export, or use “Paste a list.”"],
        format: null, sourceLabel: "your file", aiUsed: false, aiMapped: false, mapping: null, repairedCount: 0,
      };
    }
    const rows = parseCSV(text.slice(0, 4000));
    const header = rows[0] ?? [];
    if (!header.length || header.every((h) => !h?.trim())) {
      return {
        books: [], errors: ["This file is empty or not a readable CSV."],
        format: null, sourceLabel: "your file", aiUsed: false, aiMapped: false, mapping: null, repairedCount: 0,
      };
    }
    mapping = await inferImportMapping({ header, sampleRows: rows.slice(1) });
    result = parseWithMapping(text, mapping);
    sourceLabel = "your file";
    aiMapped = true;
  }

  let { books = [], errors = [], note = null } = result;

  // Tier 3 — repair detectably-malformed rows. Cheap local scan; only calls AI
  // when something is actually wrong.
  let repairedCount = 0;
  const flagged = detectMalformedRows(books);
  if (flagged.length) {
    books = await repairImportRows(books, flagged);
    repairedCount = flagged.length;
  }

  return {
    books, errors, note,
    format: format ?? "ai-mapped",
    sourceLabel,
    aiUsed: aiMapped || repairedCount > 0,
    aiMapped, mapping, repairedCount,
  };
}

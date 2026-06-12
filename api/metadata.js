// Vercel Serverless Function — book metadata search/series lookup.
// GET /api/metadata?q=...        -> { source, results: [...] }
// GET /api/metadata?series=ASIN -> { series, volumes: [...] }
import { handleMetadataRequest } from "./_lib/metadata-core.js";

// Series lookups batch-fetch volume details and can exceed the default 10s.
export const config = { maxDuration: 30 };

export default function handler(req, res) {
  return handleMetadataRequest(req, res);
}

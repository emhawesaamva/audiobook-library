// Vercel Serverless Function — book metadata search/series lookup.
// GET /api/metadata?q=...        -> { source, results: [...] }
// GET /api/metadata?series=ASIN -> { series, volumes: [...] }
import { handleMetadataRequest } from "./_lib/metadata-core.js";

export default function handler(req, res) {
  return handleMetadataRequest(req, res);
}

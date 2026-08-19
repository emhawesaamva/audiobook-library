// MCP endpoint: transport, authentication, and rate limiting.
//
// POST /api/mcp with `Authorization: Bearer alib_…`. The token is a personal
// access token minted in the app's Settings and bound to exactly one library;
// api/_lib/mcp-scope.js turns it into a data client that cannot reach anything
// else. The tools themselves are in api/_lib/mcp-tools.js.
//
// Split across three files rather than the one-core-per-endpoint convention the
// rest of api/_lib follows: metadata-core.js is 260 lines, and a single
// mcp-core.js would be well over a thousand. The seam is deliberate — scope is
// the security boundary, tools is the product surface, and this file is the
// plumbing between them.
//
// Note what is NOT imported here: messages-core.js. This endpoint never calls a
// model. That is the whole design.
import { createHash, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { makeScope, McpScopeError, pgMessage } from "./mcp-scope.js";
import { TOOLS, TOOLS_BY_NAME, PROMPTS, SERVER_INSTRUCTIONS } from "./mcp-tools.js";

const SERVER_INFO = { name: "audiolib", version: "1.0.0" };

// alib_ + 43 base64url chars = 32 random bytes.
const TOKEN_RE = /^alib_[A-Za-z0-9_-]{43}$/;

// Fixed window, counted on the token row because a Vercel function has no
// shared memory. Generous — this is a runaway-loop guard, not a quota.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
// Stamping last_used_at on every request would mean a row write per tool call.
// Once a minute is enough to answer "is this token still in use?".
const USAGE_STAMP_MS = 60_000;

// Vercel consumes and parses the request stream into req.body; Vite's connect
// middleware does not. Same split messages-core.js:22 handles.
export async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function svcHeaders(env) {
  return {
    apikey: env.secretKey,
    Authorization: `Bearer ${env.secretKey}`,
    "Content-Type": "application/json",
    "User-Agent": "audiolib.io/1.0 (+https://audiolib.io)",
  };
}

// Resolve a bearer token to the library it is bound to, or fail closed.
// Every failure returns the same shape; the caller renders one 401.
export async function resolveToken(env, authorization) {
  const raw = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  // Shape-check before touching the database, so a flood of garbage costs us
  // nothing. This is the DoS guard as much as it is validation.
  if (!TOKEN_RE.test(raw)) return { error: "Invalid or missing access token" };

  const hash = hashToken(raw);
  const res = await fetch(
    `${env.supabaseUrl}/rest/v1/mcp_tokens?token_hash=eq.${hash}&select=*&limit=1`,
    { headers: svcHeaders(env) }
  );
  if (!res.ok) return { error: "Could not verify the access token" };
  const [tok] = await res.json();
  if (!tok) return { error: "Invalid or missing access token" };

  // The b-tree lookup above already matched, and it is not a practical timing
  // oracle over HTTP. This is here so that a later refactor to a prefix or
  // non-unique lookup cannot quietly become one.
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(tok.token_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: "Invalid or missing access token" };

  if (tok.revoked_at) return { error: "This access token has been revoked" };
  if (tok.expires_at && Date.parse(tok.expires_at) <= Date.now()) {
    return { error: "This access token has expired" };
  }

  // The bound library must still exist and still belong to the token's account.
  const pres = await fetch(
    `${env.supabaseUrl}/rest/v1/profiles?id=eq.${tok.profile_id}&select=id,name,age_group,account_id`,
    { headers: svcHeaders(env) }
  );
  const [profile] = pres.ok ? await pres.json() : [];
  if (!profile || profile.account_id !== tok.account_id) {
    return { error: "This token's library no longer exists — create a new token in Settings" };
  }

  const now = Date.now();
  const windowStart = tok.req_window ? Date.parse(tok.req_window) : 0;
  const inWindow = now - windowStart < RATE_WINDOW_MS;
  if (inWindow && (tok.req_count ?? 0) >= RATE_MAX) {
    return { error: "Rate limit exceeded — slow down and try again in a minute", rateLimited: true };
  }

  return {
    token: tok, profile,
    usage: {
      req_window: inWindow ? tok.req_window : new Date(now).toISOString(),
      req_count: inWindow ? (tok.req_count ?? 0) + 1 : 1,
      // Only refresh last_used_at once a minute; the counter still moves.
      ...(!tok.last_used_at || now - Date.parse(tok.last_used_at) > USAGE_STAMP_MS
        ? { last_used_at: new Date(now).toISOString() }
        : {}),
    },
  };
}

function buildServer(scope) {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS_BY_NAME.get(req.params.name);
    if (!tool) return errorResult(`Unknown tool: ${req.params.name}`);
    if (tool.write && !scope.canWrite) return errorResult("This access token is read-only.");
    const started = Date.now();
    try {
      const payload = await tool.handler(scope, req.params.arguments ?? {});
      audit(scope, tool.name, true, started);
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (err) {
      audit(scope, tool.name, false, started);
      return errorResult(err instanceof McpScopeError ? err.message : pgMessage({ message: err?.message }));
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description, arguments: a }) => ({ name, description, arguments: a })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const prompt = PROMPTS.find((p) => p.name === req.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${req.params.name}`);
    return prompt.build(scope, req.params.arguments ?? {});
  });

  return server;
}

function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// One line per call. Never the token, and never book titles or notes — this
// goes to a log aggregator, and a library is personal.
function audit(scope, tool, okFlag, started) {
  console.log(JSON.stringify({
    mcp: true, tool, ok: okFlag, ms: Date.now() - started,
    profile_id: scope.profileId,
  }));
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export async function handleMcpRequest(req, res, { supabaseUrl, secretKey } = {}) {
  if (!supabaseUrl || !secretKey) {
    return sendJson(res, 500, { error: "MCP server is not configured" });
  }
  // No SSE: a serverless function cannot hold a stream open reliably, and the
  // transport runs stateless (one Server per request, no session store).
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Use POST — this endpoint speaks MCP over HTTP, not SSE" });
  }

  const env = { supabaseUrl, secretKey };
  // Authenticate before parsing a body, reading anything, or touching an
  // upstream. /api/metadata and /v1/messages next door are unauthenticated;
  // this one must not be.
  const auth = await resolveToken(env, req.headers?.authorization ?? req.headers?.Authorization);
  if (auth.error) return sendJson(res, auth.rateLimited ? 429 : 401, { error: auth.error });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const scope = makeScope(env, {
    accountId: auth.token.account_id,
    profileId: auth.token.profile_id,
    tokenId: auth.token.id,
    canWrite: !!auth.token.can_write,
  });
  scope.stampUsage(auth.usage);

  const server = buildServer(scope);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => { transport.close(); server.close(); });
  res.setHeader("Cache-Control", "no-store");
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

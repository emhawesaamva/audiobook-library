import test from "node:test";
import assert from "node:assert/strict";
import {
  isCreditExhaustedError,
  anthropicToGeminiRequest,
  GEMINI_MIN_OUTPUT_TOKENS,
  geminiToAnthropicResponse,
  handleMessages,
} from "../api/_lib/messages-core.js";

// Minimal Vercel-style req (pre-parsed body) and a res that records its output.
function fakeReq(body) {
  return { body };
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b; },
    get json() { return JSON.parse(this.body); },
  };
}

// Stub global fetch with a queue of responses keyed by URL substring.
function stubFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    for (const [needle, resp] of handlers) {
      if (url.includes(needle)) return resp;
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return calls;
}
const makeResp = (status, data) => ({ status, json: async () => data });

test("isCreditExhaustedError matches Anthropic's credit message on 400", () => {
  const data = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
  };
  assert.equal(isCreditExhaustedError(400, data), true);
});

test("isCreditExhaustedError ignores other errors and statuses", () => {
  assert.equal(isCreditExhaustedError(429, { error: { message: "rate limited" } }), false);
  assert.equal(isCreditExhaustedError(401, { error: { message: "invalid api key" } }), false);
  // Right message but wrong status — only 400 is the credit case.
  assert.equal(isCreditExhaustedError(500, { error: { message: "credit balance is too low" } }), false);
  assert.equal(isCreditExhaustedError(200, {}), false);
});

test("anthropicToGeminiRequest maps system, roles, and max_tokens", () => {
  // 4000 rather than an arbitrary small number: anything under
  // GEMINI_MIN_OUTPUT_TOKENS is raised to the floor now, which is its own test
  // above. This one is about the mapping.
  const out = anthropicToGeminiRequest({
    model: "claude-sonnet-4-6",
    max_tokens: 4000,
    system: "You are a recommender.",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "more please" },
    ],
  });
  assert.deepEqual(out.system_instruction, { parts: [{ text: "You are a recommender." }] });
  assert.equal(out.generationConfig.maxOutputTokens, 4000);
  assert.deepEqual(out.contents, [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ text: "hi there" }] },
    { role: "user", parts: [{ text: "more please" }] },
  ]);
});

test("anthropicToGeminiRequest flattens array content to text parts", () => {
  const out = anthropicToGeminiRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
  });
  assert.deepEqual(out.contents, [{ role: "user", parts: [{ text: "a\nb" }] }]);
  assert.equal(out.system_instruction, undefined);
});

test("a small max_tokens is floored, because thinking is charged against it", () => {
  // The bug this fixes: the admin connection test asks for 32 tokens, Gemini
  // spends them thinking, and the answer comes back empty. maxOutputTokens is a
  // cap rather than a target — the real answer used 13 tokens — so raising it
  // costs nothing when thinking stays short.
  const small = anthropicToGeminiRequest({ max_tokens: 32, messages: [{ role: "user", content: "hi" }] });
  assert.equal(small.generationConfig.maxOutputTokens, GEMINI_MIN_OUTPUT_TOKENS);

  // A caller asking for more than the floor keeps what it asked for.
  const big = anthropicToGeminiRequest({ max_tokens: 4000, messages: [{ role: "user", content: "hi" }] });
  assert.equal(big.generationConfig.maxOutputTokens, 4000);

  // Both thinking parameters go out: thinkingBudget for 2.5, thinkingLevel for 3.
  assert.equal(small.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(small.generationConfig.thinkingConfig.thinkingLevel, "low");
});

test("an empty Gemini response says WHY it was empty", () => {
  // "returned no content" on its own sent us checking the API key, when the
  // answer was in finishReason all along.
  const starved = geminiToAnthropicResponse({
    candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
  });
  assert.match(starved.error.message, /token budget went on thinking/);

  const blocked = geminiToAnthropicResponse({
    candidates: [{ content: { parts: [] } }],
    promptFeedback: { blockReason: "SAFETY" },
  });
  assert.match(blocked.error.message, /blocked: SAFETY/);

  // An explicit API error still wins — it is more specific than anything we infer.
  assert.equal(
    geminiToAnthropicResponse({ error: { message: "API key not valid" } }).error.message,
    "API key not valid"
  );
});

test("geminiToAnthropicResponse extracts text into Anthropic shape", () => {
  const resp = geminiToAnthropicResponse({
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
  });
  assert.equal(resp.type, "message");
  assert.equal(resp.model, "gemini-flash-latest");
  assert.equal(resp._provider, "gemini");
  assert.deepEqual(resp.content, [{ type: "text", text: '{"ok":true}' }]);
  assert.deepEqual(resp.usage, { input_tokens: 10, output_tokens: 5 });
});

test("geminiToAnthropicResponse returns an error shape when empty/blocked", () => {
  const blocked = geminiToAnthropicResponse({ candidates: [{ content: { parts: [] } }] });
  assert.equal(blocked.type, "error");
  assert.ok(blocked.error.message);

  const apiErr = geminiToAnthropicResponse({ error: { message: "quota exceeded" } });
  assert.equal(apiErr.type, "error");
  assert.equal(apiErr.error.message, "quota exceeded");
});

test("handleMessages falls back to Gemini on a credit-exhausted error", async () => {
  const realFetch = globalThis.fetch;
  try {
    const calls = stubFetch([
      ["api.anthropic.com", makeResp(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } })],
      ["generativelanguage.googleapis.com", makeResp(200, { candidates: [{ content: { parts: [{ text: '{"ok":1}' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })],
    ]);
    const res = fakeRes();
    // No supabase creds -> the flag write is skipped (no extra fetch).
    await handleMessages(fakeReq({ messages: [{ role: "user", content: "hi" }] }), res, {
      anthropicKey: "k", geminiKey: "g", supabaseUrl: undefined, supabaseSecret: undefined,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json._provider, "gemini");
    assert.equal(res.json.content[0].text, '{"ok":1}');
    assert.equal(calls.length, 2); // anthropic, then gemini
    assert.ok(calls[1].url.includes("generativelanguage"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("handleMessages passes through non-credit errors without calling Gemini", async () => {
  const realFetch = globalThis.fetch;
  try {
    const calls = stubFetch([
      ["api.anthropic.com", makeResp(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })],
    ]);
    const res = fakeRes();
    await handleMessages(fakeReq({ messages: [{ role: "user", content: "hi" }] }), res, {
      anthropicKey: "k", geminiKey: "g", supabaseUrl: undefined, supabaseSecret: undefined,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error.type, "authentication_error");
    assert.equal(calls.length, 1); // anthropic only; Gemini never called
  } finally {
    globalThis.fetch = realFetch;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  isCreditExhaustedError,
  anthropicToGeminiRequest,
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
  const out = anthropicToGeminiRequest({
    model: "claude-sonnet-4-6",
    max_tokens: 1234,
    system: "You are a recommender.",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "more please" },
    ],
  });
  assert.deepEqual(out.system_instruction, { parts: [{ text: "You are a recommender." }] });
  assert.equal(out.generationConfig.maxOutputTokens, 1234);
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

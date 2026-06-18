// Messages core shared by the Vercel function (api/v1/messages.js) and the Vite
// dev middleware. Proxies /v1/messages to Anthropic. When Anthropic reports the
// credit balance is too low, it (a) records an `ai_credit_exhausted` flag in the
// app_settings table so the admin UI can show a banner, and (b) transparently
// falls back to Gemini Flash, translating the reply into the Anthropic response
// shape the frontend expects. All other responses pass through unchanged.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

function makeJson(res) {
  return (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
}

// Vercel pre-parses JSON into req.body; the Vite/connect dev middleware does not,
// so read and parse the raw stream in that case.
async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// The specific failure we fall back on: HTTP 400 with Anthropic's
// "Your credit balance is too low to access the Anthropic API" message.
export function isCreditExhaustedError(status, data) {
  return status === 400 && /credit balance is too low/i.test(data?.error?.message ?? "");
}

// Map an Anthropic Messages request onto a Gemini generateContent request.
// None of the app's calls use tools, so this is plain system + messages.
export function anthropicToGeminiRequest(body) {
  const out = { contents: [] };

  const sysText =
    typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b) => (typeof b === "string" ? b : b.text ?? "")).join("\n")
        : "";
  if (sysText) out.system_instruction = { parts: [{ text: sysText }] };

  for (const m of body.messages ?? []) {
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text ?? "" : ""))
              .join("\n")
          : "";
    out.contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }

  // gemini-flash-latest resolves to a thinking model; disable thinking so the
  // whole token budget produces the answer (these are JSON-extraction tasks that
  // don't need reasoning, and thinking can otherwise consume max_tokens and
  // return empty content).
  out.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
  if (body.max_tokens) out.generationConfig.maxOutputTokens = body.max_tokens;
  return out;
}

// Map a Gemini generateContent response back onto the Anthropic Messages shape.
// On an empty/blocked response, return an Anthropic-shaped error so the frontend
// surfaces it through its normal `d.error` path.
export function geminiToAnthropicResponse(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  if (!text) {
    return {
      type: "error",
      error: {
        type: "api_error",
        message: data?.error?.message || "Gemini fallback returned no content",
      },
    };
  }
  const usage = data?.usageMetadata ?? {};
  return {
    id: "gemini_fallback",
    type: "message",
    role: "assistant",
    model: "gemini-flash-latest",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount ?? 0,
      output_tokens: usage.candidatesTokenCount ?? 0,
    },
    _provider: "gemini",
  };
}

// Record (upsert) the credit-exhausted flag. Best-effort; never throws.
async function flagCreditExhausted(supabaseUrl, secretKey) {
  if (!supabaseUrl || !secretKey) return;
  try {
    await fetch(`${supabaseUrl}/rest/v1/app_settings`, {
      method: "POST",
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        key: "ai_credit_exhausted",
        value: { since: new Date().toISOString() },
      }),
    });
  } catch {
    /* best-effort: a failed flag write must not break the AI call */
  }
}

async function callGemini(body, geminiKey) {
  const r = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": geminiKey },
    body: JSON.stringify(anthropicToGeminiRequest(body)),
  });
  return geminiToAnthropicResponse(await r.json());
}

export async function handleMessages(req, res, { anthropicKey, geminiKey, supabaseUrl, supabaseSecret }) {
  const json = makeJson(res);

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(400, { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
  }

  let status, data;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    status = r.status;
    data = await r.json();
  } catch (err) {
    return json(500, { type: "error", error: { type: "proxy_error", message: err.message || "Proxy request failed" } });
  }

  if (isCreditExhaustedError(status, data)) {
    await flagCreditExhausted(supabaseUrl, supabaseSecret);
    if (geminiKey) {
      try {
        const gem = await callGemini(body, geminiKey);
        if (gem && !gem.error) return json(200, gem);
      } catch {
        /* fall through to the original Anthropic error below */
      }
    }
    // No usable Gemini fallback — surface the original credit error.
    return json(status, data);
  }

  return json(status, data);
}

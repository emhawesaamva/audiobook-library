// Vercel Serverless Function — proxies /v1/messages to Anthropic.
// Node.js runtime with maxDuration: 60 to accommodate web-search calls
// that can take 20-40 seconds. Injects the API key server-side.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ type: "error", error: { type: "proxy_error", message: err.message || "Proxy request failed" } });
  }
}

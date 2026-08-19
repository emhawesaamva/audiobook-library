import { createClient } from "@supabase/supabase-js";

// Supabase intermittently answers 401 PGRST303 ("JWT claims validation failed")
// for an access token it minted moments earlier. It shows up on the burst of
// requests a page load fires right after a token refresh — the four startup
// queries carry the identical token, three come back 200 and one 401 — and the
// same token works on the next attempt, so it is a validation blip on their
// side rather than a real auth failure. A 401 is rejected before any SQL runs,
// so replaying the request can't double-apply a write.
//
// Left unhandled, one unlucky request fails the whole initial load, which is
// how opening the app after the token has expired ends up looking like a
// brand-new account with no libraries.
const RETRYABLE_JWT_CODES = new Set(["PGRST301", "PGRST303"]);
const RETRY_DELAYS_MS = [250, 750];

async function isTokenBlip(res) {
  if (res.status !== 401) return false;
  try {
    const { code } = await res.clone().json();
    return RETRYABLE_JWT_CODES.has(code);
  } catch {
    return false; // not a PostgREST error body — treat as a genuine 401
  }
}

async function fetchRetryingTokenBlips(input, init) {
  let res = await fetch(input, init);
  for (const delay of RETRY_DELAYS_MS) {
    if (!(await isTokenBlip(res))) break;
    await new Promise((r) => setTimeout(r, delay));
    res = await fetch(input, init);
  }
  return res;
}

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { global: { fetch: fetchRetryingTokenBlips } }
);

export default supabase;

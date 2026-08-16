// Which Supabase projects are production, and the guard that keeps destructive
// scripts away from them. Deliberately free of side effects (no .env loading,
// no network, no process.exit at import) so any script can import it, including
// ones that tolerate a missing SUPABASE_SECRET_KEY.
//
// Local .env legitimately points at production so `npm run dev` works against
// real data. Scripts that create and delete auth users therefore cannot infer
// safety from "the env is configured" — they have to check the ref.

export const PRODUCTION_REFS = new Set(["lschyxipktswvmicodij"]); // "Library"

export function refFromUrl(url) {
  try {
    return new URL(url).hostname.split(".")[0];
  } catch {
    return null;
  }
}

export function isProductionUrl(url) {
  const ref = refFromUrl(url);
  return ref != null && PRODUCTION_REFS.has(ref);
}

// Exits the process unless `url` is a non-production project. Set
// ALLOW_PRODUCTION_WRITES=1 to proceed anyway (deliberate one-offs only).
export function assertNotProductionUrl(url, scriptName = "this script") {
  const ref = refFromUrl(url);
  if (!isProductionUrl(url)) return ref;
  if (process.env.ALLOW_PRODUCTION_WRITES === "1") {
    console.warn(`WARNING: ${scriptName} running against PRODUCTION (${ref}) — ALLOW_PRODUCTION_WRITES=1 was set.`);
    return ref;
  }
  console.error(
    `Refusing to run ${scriptName} against the production project (${ref}).\n` +
    `It creates and deletes real auth users, which cascades away real libraries.\n\n` +
    `Point VITE_SUPABASE_URL and SUPABASE_SECRET_KEY at a test project, or start\n` +
    `the local stack with \`npm run db:start\` and use \`npm run test:e2e:local\`.\n\n` +
    `Set ALLOW_PRODUCTION_WRITES=1 only if you genuinely mean to touch production.`
  );
  process.exit(1);
}

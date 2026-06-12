// Admin user-listing core, shared by the Vercel function (api/admin/users.js)
// and the Vite dev middleware. Verifies the caller's JWT, checks their
// accounts.is_admin flag, then lists all users with profile/book counts using
// the secret (service-role) key.

const UA = { "User-Agent": "library-admin/1.0" };

export async function handleAdminUsers(req, res, { supabaseUrl, secretKey }) {
  const json = (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  try {
    if (!supabaseUrl || !secretKey) return json(500, { error: "Server not configured" });

    const jwt = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json(401, { error: "Missing bearer token" });

    const svc = {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
      ...UA,
    };

    // Resolve the caller from their JWT (auth server validates it).
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: secretKey, Authorization: `Bearer ${jwt}`, ...UA },
    });
    if (!userResp.ok) return json(401, { error: "Invalid session" });
    const caller = await userResp.json();

    // Admin check against the accounts table.
    const acctResp = await fetch(
      `${supabaseUrl}/rest/v1/accounts?select=is_admin&id=eq.${caller.id}`,
      { headers: svc }
    );
    const [acct] = await acctResp.json();
    if (!acct?.is_admin) return json(403, { error: "Admin only" });

    // List all auth users (paged) + account rows + per-account counts.
    const users = [];
    for (let page = 1; page <= 20; page++) {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=100`, { headers: svc });
      if (!r.ok) return json(502, { error: "User listing failed" });
      const data = await r.json();
      const batch = data.users ?? data;
      users.push(...batch);
      if (batch.length < 100) break;
    }

    const [accounts, profiles, books] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/accounts?select=id,email,display_name,is_admin,created_at`, { headers: svc }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/profiles?select=id,account_id`, { headers: svc }).then((r) => r.json()),
      fetch(`${supabaseUrl}/rest/v1/books?select=id,profile_id`, { headers: svc }).then((r) => r.json()),
    ]);

    const profilesByAccount = new Map();
    for (const p of profiles) {
      profilesByAccount.set(p.account_id, (profilesByAccount.get(p.account_id) ?? 0) + 1);
    }
    const accountByProfile = new Map(profiles.map((p) => [p.id, p.account_id]));
    const booksByAccount = new Map();
    for (const b of books) {
      const acc = accountByProfile.get(b.profile_id);
      if (acc) booksByAccount.set(acc, (booksByAccount.get(acc) ?? 0) + 1);
    }
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    return json(200, {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        display_name: accountById.get(u.id)?.display_name ?? null,
        is_admin: accountById.get(u.id)?.is_admin ?? false,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        providers: u.app_metadata?.providers ?? [],
        profile_count: profilesByAccount.get(u.id) ?? 0,
        book_count: booksByAccount.get(u.id) ?? 0,
      })),
    });
  } catch (err) {
    return json(500, { error: err.message ?? "admin lookup failed" });
  }
}

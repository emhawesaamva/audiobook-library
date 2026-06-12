// Admin core handlers shared by Vercel functions and the Vite dev middleware.
// Each handler verifies the caller's JWT and admin flag before acting.

const UA = { "User-Agent": "library-admin/1.0" };

function makeJson(res) {
  return (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
}

async function verifyAdmin(supabaseUrl, secretKey, jwt) {
  const svc = { apikey: secretKey, Authorization: `Bearer ${secretKey}`, ...UA };
  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: secretKey, Authorization: `Bearer ${jwt}`, ...UA },
  });
  if (!userResp.ok) return { error: "Invalid session" };
  const caller = await userResp.json();
  const acctResp = await fetch(
    `${supabaseUrl}/rest/v1/accounts?select=is_admin&id=eq.${caller.id}`,
    { headers: svc }
  );
  const [acct] = await acctResp.json();
  if (!acct?.is_admin) return { error: "Admin only" };
  return { caller, svc };
}

export async function handleAdminUsers(req, res, { supabaseUrl, secretKey }) {
  const json = makeJson(res);

  try {
    if (!supabaseUrl || !secretKey) return json(500, { error: "Server not configured" });

    const jwt = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json(401, { error: "Missing bearer token" });

    const { error, caller, svc } = await verifyAdmin(supabaseUrl, secretKey, jwt);
    if (error) return json(error === "Admin only" ? 403 : 401, { error });

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

// DELETE /api/admin/delete-user?userId={id}
// Deletes the target auth user and — via cascade — all their profiles, books,
// settings, and every other row tied to their account. Guards:
//   • Caller must be admin.
//   • Cannot delete yourself.
//   • Cannot delete another admin account.
export async function handleDeleteUser(req, res, { supabaseUrl, secretKey }) {
  const json = makeJson(res);

  if (req.method !== "DELETE") return json(405, { error: "Method not allowed" });

  try {
    if (!supabaseUrl || !secretKey) return json(500, { error: "Server not configured" });

    const jwt = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json(401, { error: "Missing bearer token" });

    // Support req.query (Vercel) and raw query string (Vite dev middleware).
    const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const userId = req.query?.userId ?? params.get("userId");
    if (!userId) return json(400, { error: "Missing userId" });

    const { error, caller, svc } = await verifyAdmin(supabaseUrl, secretKey, jwt);
    if (error) return json(error === "Admin only" ? 403 : 401, { error });

    if (userId === caller.id) return json(400, { error: "Cannot delete your own account" });

    // Refuse to delete another admin to prevent accidental lockout.
    const targetResp = await fetch(
      `${supabaseUrl}/rest/v1/accounts?select=is_admin&id=eq.${userId}`,
      { headers: svc }
    );
    const [targetAcct] = await targetResp.json();
    if (targetAcct?.is_admin) return json(400, { error: "Cannot delete an admin account" });

    // Delete the auth.users row — cascades through accounts → profiles → books etc.
    const del = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: svc,
    });
    if (!del.ok) {
      const body = await del.json().catch(() => ({}));
      return json(502, { error: body.message ?? "Delete failed" });
    }

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: err.message ?? "Delete failed" });
  }
}

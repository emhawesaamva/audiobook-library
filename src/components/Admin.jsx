// Admin tab (owner only): user list with usage counts, app settings.
import { useState, useEffect } from "react";
import supabase from "../lib/supabase.js";
import { setAppSetting } from "../lib/db.js";
import { Spinner, labelCls, inputCls, btnSecondary } from "./shared.jsx";
import { claudeFetch } from "../lib/ai.js";
import { Trash2 } from "lucide-react";

export default function Admin({ appSettings, onSettingsChange, onToast }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(null); // userId
  const [deleting, setDeleting] = useState(false);
  const [affiliateCode, setAffiliateCode] = useState(appSettings.affiliate_tag ?? "");
  const [savingAffiliate, setSavingAffiliate] = useState(false);
  const [tests, setTests] = useState({}); // { claude|gemini: { loading, ok, text, answered, error } }

  // Send a one-line "hello" through the /v1/messages proxy. "claude" uses the
  // normal path (and will reveal if it fell back to Gemini); "gemini" forces
  // Gemini via the x-force-gemini header. Shows whether a response came back.
  const testConnection = async (provider) => {
    setTests((t) => ({ ...t, [provider]: { loading: true } }));
    try {
      const d = await claudeFetch(
        { model: "claude-haiku-4-5-20251001", max_tokens: 32, messages: [{ role: "user", content: "Reply with a short, friendly hello." }] },
        provider === "gemini" ? { "x-force-gemini": "1" } : {},
      );
      if (d.error) throw new Error(d.error.message || "Request failed");
      const text = (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (!text) throw new Error("Empty response");
      const answered = d._provider === "gemini" || /gemini/i.test(d.model || "") ? "Gemini" : "Claude";
      setTests((t) => ({ ...t, [provider]: { ok: true, text, answered } }));
    } catch (e) {
      setTests((t) => ({ ...t, [provider]: { ok: false, error: e.message } }));
    }
  };

  useEffect(() => {
    setAffiliateCode(appSettings.affiliate_tag ?? "");
  }, [appSettings.affiliate_tag]);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setCurrentUserId(session?.user?.id ?? null);
        const r = await fetch("/api/admin/users", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setUsers(data.users);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  const saveAffiliateTag = async () => {
    setSavingAffiliate(true);
    try {
      const trimmed = affiliateCode.trim();
      await setAppSetting("affiliate_tag", trimmed || null);
      onSettingsChange({ ...appSettings, affiliate_tag: trimmed || null });
      onToast?.({ text: trimmed ? "Affiliate tag saved" : "Affiliate tag cleared" });
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    } finally {
      setSavingAffiliate(false);
    }
  };

  const toggleSignups = async () => {
    const next = !(appSettings.signups_disabled === true);
    try {
      await setAppSetting("signups_disabled", next);
      onSettingsChange({ ...appSettings, signups_disabled: next });
      onToast?.({ text: next ? "New signups disabled" : "Signups enabled" });
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    }
  };

  const deleteUser = async (userId) => {
    setDeleting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`/api/admin/delete-user?userId=${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
      setConfirmingDelete(null);
      onToast?.({ text: "User deleted" });
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    } finally {
      setDeleting(false);
    }
  };

  const td = "px-3 py-2 text-sm";
  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400";

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-zinc-300/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className={labelCls}>App settings</div>
        <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm">
          <button
            onClick={toggleSignups}
            className={`relative h-5 w-9 rounded-full transition cursor-pointer ${appSettings.signups_disabled ? "bg-accent-500" : "bg-zinc-300 dark:bg-zinc-700"}`}
            role="switch" aria-checked={!!appSettings.signups_disabled}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${appSettings.signups_disabled ? "left-[18px]" : "left-0.5"}`} />
          </button>
          Disable new account signups
        </label>

        <div className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <label className={labelCls}>Amazon Associates affiliate tag</label>
          <div className="mt-1.5 flex gap-2">
            <input
              type="text"
              value={affiliateCode}
              onChange={(e) => setAffiliateCode(e.target.value)}
              placeholder="e.g. mystore-20"
              className={`${inputCls} flex-1 !py-1.5`}
            />
            <button
              onClick={saveAffiliateTag}
              disabled={savingAffiliate}
              className="rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-accent-400 disabled:opacity-50 cursor-pointer"
            >
              {savingAffiliate ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            When set, all Audible links on the site will include your tag for commission tracking. Amazon's required disclosure will be shown to users automatically.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-300/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className={labelCls}>AI connection test</div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Sends a one-line “hello” to each provider and shows whether a response came back. “Claude” uses the normal
          path, so it reveals an automatic fallback to Gemini if Anthropic credits are exhausted.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {["claude", "gemini"].map((p) => {
            const t = tests[p];
            return (
              <div key={p} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium capitalize">{p}</span>
                  <button
                    onClick={() => testConnection(p)}
                    disabled={t?.loading}
                    className={`${btnSecondary} !px-2.5 !py-1 text-xs`}
                  >
                    {t?.loading ? <><Spinner className="h-3.5 w-3.5" /> Testing…</> : `Test ${p === "gemini" ? "Gemini" : "Claude"}`}
                  </button>
                </div>
                {t && !t.loading && (t.ok ? (
                  <div className="mt-2 text-xs">
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">✓ Response received</span>
                    <span className="text-zinc-500 dark:text-zinc-400"> · answered by {t.answered}</span>
                    <p className="mt-1 italic text-zinc-600 line-clamp-3 dark:text-zinc-400">“{t.text}”</p>
                  </div>
                ) : (
                  <div className="mt-2 text-xs">
                    <span className="font-semibold text-red-600 dark:text-red-400">✗ Failed</span>
                    <p className="mt-1 break-words text-zinc-600 dark:text-zinc-400">{t.error}</p>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-zinc-300/90 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-100 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 dark:border-zinc-800">
          Users {users && `(${users.length})`}
        </div>
        {error && <div className="px-4 py-3 text-sm text-red-600">{error}</div>}
        {!users && !error && <div className="flex justify-center py-8"><Spinner className="h-5 w-5 text-zinc-500 dark:text-zinc-400" /></div>}
        {users && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className={th}>Email</th>
                  <th className={th}>Sign-in</th>
                  <th className={th}>Libraries</th>
                  <th className={th}>Books</th>
                  <th className={th}>Joined</th>
                  <th className={th}>Last seen</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {users.map((u) =>
                  confirmingDelete === u.id ? (
                    <tr key={u.id} className="border-b border-zinc-50 dark:border-zinc-800/50 bg-red-50 dark:bg-red-950/20">
                      <td colSpan={7} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                          <span className="text-red-700 dark:text-red-400">
                            Permanently delete <strong>{u.email}</strong> and all their library data? This cannot be undone.
                          </span>
                          <button
                            onClick={() => deleteUser(u.id)}
                            disabled={deleting}
                            className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
                          >
                            {deleting ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                            Delete permanently
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(null)}
                            disabled={deleting}
                            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={u.id} className="border-b border-zinc-50 last:border-0 dark:border-zinc-800/50">
                      <td className={td}>
                        {u.email}
                        {u.is_admin && <span className="ml-1.5 rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-700 dark:bg-accent-700/20 dark:text-accent-400">admin</span>}
                      </td>
                      <td className={`${td} text-zinc-500 dark:text-zinc-400`}>{(u.providers ?? []).join(", ") || "email"}</td>
                      <td className={td}>{u.profile_count}</td>
                      <td className={td}>{u.book_count}</td>
                      <td className={`${td} text-zinc-500 dark:text-zinc-400`}>{u.created_at?.slice(0, 10)}</td>
                      <td className={`${td} text-zinc-500 dark:text-zinc-400`}>{u.last_sign_in_at?.slice(0, 10) ?? "—"}</td>
                      <td className="px-2 py-2 text-right">
                        {!u.is_admin && u.id !== currentUserId && (
                          <button
                            onClick={() => setConfirmingDelete(u.id)}
                            title="Delete user"
                            className="rounded-md p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 dark:hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

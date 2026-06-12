// Sign-in / sign-up / password-reset screen. Google OAuth + email/password.
import { useState, useEffect } from "react";
import supabase from "../lib/supabase.js";
import { btnPrimary, btnSecondary, inputCls, labelCls, Spinner } from "./shared.jsx";

const MODES = { signin: "Sign in", signup: "Create account", reset: "Reset password" };

export default function Login() {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [signupsDisabled, setSignupsDisabled] = useState(false);

  useEffect(() => {
    supabase
      .from("app_settings")
      .select("value")
      .eq("key", "signups_disabled")
      .maybeSingle()
      .then(({ data }) => setSignupsDisabled(data?.value === true));
  }, []);

  const google = async () => {
    setError(null);
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (e) setError(e.message);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        if (!data.session) setNotice("Check your email for a confirmation link, then sign in.");
      } else {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (err) throw err;
        setNotice("Password reset email sent — check your inbox.");
      }
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-500 text-2xl shadow-md">🎧</div>
          <h1 className="font-serif text-2xl font-bold">Audiobook Library</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Track, rate, and discover audiobooks</p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <button onClick={google} className={`${btnSecondary} w-full`}>
            <svg width="16" height="16" viewBox="0 0 48 48">
              <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
              <path fill="#FF3D00" d="M6.3 14.7 12.9 19.5C14.7 15.1 18.9 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/>
            </svg>
            Continue with Google
          </button>

          <div className="my-4 flex items-center gap-3 text-xs text-zinc-400">
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            or
            <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>

          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className={labelCls}>Email</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoComplete="email" />
            </div>
            {mode !== "reset" && (
              <div>
                <label className={labelCls}>Password</label>
                <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"} />
              </div>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            {notice && <p className="text-sm text-emerald-600 dark:text-emerald-400">{notice}</p>}
            <button type="submit" disabled={busy} className={`${btnPrimary} w-full`}>
              {busy ? <Spinner /> : MODES[mode]}
            </button>
          </form>

          <div className="mt-4 flex justify-between text-xs text-zinc-500">
            {mode === "signin" ? (
              <>
                {!signupsDisabled && (
                  <button onClick={() => { setMode("signup"); setError(null); setNotice(null); }} className="hover:text-accent-600 cursor-pointer">
                    Create account
                  </button>
                )}
                <button onClick={() => { setMode("reset"); setError(null); setNotice(null); }} className="ml-auto hover:text-accent-600 cursor-pointer">
                  Forgot password?
                </button>
              </>
            ) : (
              <button onClick={() => { setMode("signin"); setError(null); setNotice(null); }} className="hover:text-accent-600 cursor-pointer">
                ← Back to sign in
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

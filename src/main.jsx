import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import supabase from "./lib/supabase.js";
import Login from "./components/Login.jsx";
import Landing from "./components/Landing.jsx";
import App from "./App.jsx";
import PublicProfile from "./components/PublicProfile.jsx";
import { btnPrimary, inputCls, labelCls, Dialog } from "./components/shared.jsx";
import "./index.css";

// Apply saved theme and display size before first paint to avoid a flash.
// Defaults: light theme, large size.
document.documentElement.classList.toggle(
  "dark",
  localStorage.getItem("lib_theme") === "dark"
);
document.documentElement.classList.toggle(
  "size-large",
  localStorage.getItem("lib_size") !== "compact"
);

function NewPasswordForm({ onDone }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    const { error: err } = await supabase.auth.updateUser({ password });
    if (err) setError(err.message);
    else onDone();
  };
  return (
    <Dialog title="Set a new password" onClose={onDone}>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label className={labelCls}>New password</label>
          <input type="password" required minLength={6} value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputCls} autoComplete="new-password" />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className={`${btnPrimary} w-full`}>Save password</button>
      </form>
    </Dialog>
  );
}

function AuthGate({ startOnLogin = false }) {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [recovery, setRecovery] = useState(false);
  const [showLogin, setShowLogin] = useState(startOnLogin);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        Loading…
      </div>
    );
  }
  if (!session) {
    return showLogin
      ? <Login onBack={() => setShowLogin(false)} />
      : <Landing onSignIn={() => setShowLogin(true)} />;
  }
  return (
    <>
      <App session={session} onSignOut={() => supabase.auth.signOut()} />
      {recovery && <NewPasswordForm onDone={() => setRecovery(false)} />}
    </>
  );
}

// Route /share/{profileId} to the public read-only view; everything else through AuthGate.
// Signed-out visitors see the landing page; /signin (or /login) deep-links to the form.
const path = window.location.pathname;
const shareMatch = path.match(/^\/share\/([^/]+)/);
if (shareMatch) {
  createRoot(document.getElementById("root")).render(<PublicProfile profileId={shareMatch[1]} />);
} else {
  const startOnLogin = path === "/signin" || path === "/login";
  createRoot(document.getElementById("root")).render(<AuthGate startOnLogin={startOnLogin} />);
}

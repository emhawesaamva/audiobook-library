import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import supabase from "./lib/supabase.js";
import Login from "./components/Login.jsx";
import App from "./App.jsx";
import { btnPrimary, inputCls, labelCls, Dialog } from "./components/shared.jsx";
import "./index.css";

// Apply saved theme before first paint to avoid a flash. Default is light.
document.documentElement.classList.toggle(
  "dark",
  localStorage.getItem("lib_theme") === "dark"
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

function AuthGate() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [recovery, setRecovery] = useState(false);

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
  if (!session) return <Login />;
  return (
    <>
      <App session={session} onSignOut={() => supabase.auth.signOut()} />
      {recovery && <NewPasswordForm onDone={() => setRecovery(false)} />}
    </>
  );
}

createRoot(document.getElementById("root")).render(<AuthGate />);

import { createRoot } from "react-dom/client";
import { useState } from "react";
import App from "./library.jsx";
import supabase from "./supabase.js";

// ── Supabase storage ──────────────────────────────────────────────────────────
const snapshotted = new Set();

window.storage = {
  get: async (key) => {
    const { data, error } = await supabase
      .from("audiobook_library")
      .select("data")
      .eq("id", key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return { value: JSON.stringify(data.data) };
  },
  set: async (key, value) => {
    const { error } = await supabase
      .from("audiobook_library")
      .upsert({ id: key, data: JSON.parse(value) }, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return true;
  },
  snapshot: (key, data) => {
    if (snapshotted.has(key)) return;
    snapshotted.add(key);
    const snapId = `${key}-snapshot-${new Date().toISOString()}`;
    supabase.from("audiobook_library")
      .insert({ id: snapId, data })
      .then(({ error: e }) => { if (e) console.warn("Snapshot failed:", e.message); });
  },
};

// Redirect Anthropic API calls through the Vite proxy (keeps API key server-side)
const _fetch = window.fetch.bind(window);
window.fetch = (url, ...args) => {
  if (typeof url === "string" && url.startsWith("https://api.anthropic.com"))
    url = url.replace("https://api.anthropic.com", "");
  return _fetch(url, ...args);
};

// ── PIN gate ──────────────────────────────────────────────────────────────────
const AUTH_KEY = "lib_auth";

async function hashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function PinGate({ onUnlock }) {
  const [entered, setEntered] = useState("");
  const [error,   setError]   = useState(false);

  const press = async (d) => {
    if (error) return;
    const next = entered + d;
    if (next.length > 4) return;
    setEntered(next);
    if (next.length === 4) {
      const hash = await hashPin(next);
      if (hash === import.meta.env.VITE_PIN_HASH) {
        localStorage.setItem(AUTH_KEY, "1");
        onUnlock();
      } else {
        setError(true);
        setTimeout(() => { setEntered(""); setError(false); }, 700);
      }
    }
  };

  const del = () => { if (!error) setEntered(e => e.slice(0, -1)); };

  const btn = (label, onClick, extraStyle = {}) => (
    <button key={label} onClick={onClick} style={{
      width: 72, height: 72, borderRadius: 8,
      border: "1px solid var(--border)", background: "var(--surface)",
      color: "var(--text)", fontSize: 24, fontWeight: 600,
      fontFamily: "'Georgia', serif", cursor: "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      transition: "background 0.1s",
      ...extraStyle,
    }}
      onMouseEnter={e => e.currentTarget.style.background = "var(--surface-mid)"}
      onMouseLeave={e => e.currentTarget.style.background = extraStyle.background || "var(--surface)"}
    >{label}</button>
  );

  return (
    <div style={{
      background: "var(--bg)", minHeight: "100vh",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Georgia', serif",
    }}>
      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%,60%  { transform: translateX(-8px); }
          40%,80%  { transform: translateX(8px); }
        }
      `}</style>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>

        {/* Title */}
        <div style={{ fontSize: 14, color: "var(--text-dimmer)", fontFamily: "monospace", letterSpacing: "0.15em" }}>
          AUDIOBOOK LIBRARY
        </div>

        {/* Dot indicators */}
        <div style={{
          display: "flex", gap: 16,
          animation: error ? "shake 0.6s ease" : "none",
        }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{
              width: 14, height: 14, borderRadius: "50%",
              background: error ? "var(--danger)" : i < entered.length ? "#f59e0b" : "transparent",
              border: `2px solid ${error ? "var(--danger)" : i < entered.length ? "#f59e0b" : "var(--border)"}`,
              transition: "background 0.15s, border-color 0.15s",
            }}/>
          ))}
        </div>

        {/* Keypad */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 72px)", gap: 10 }}>
          {[1,2,3,4,5,6,7,8,9].map(d => btn(d, () => press(String(d))))}
          {/* bottom row: empty, 0, empty */}
          <div/>
          {btn("0", () => press("0"))}
          <div/>
        </div>

      </div>
    </div>
  );
}

function Root() {
  const [unlocked, setUnlocked] = useState(!!localStorage.getItem(AUTH_KEY));
  const lock = () => { localStorage.removeItem(AUTH_KEY); setUnlocked(false); };
  if (!unlocked) return <PinGate onUnlock={() => setUnlocked(true)} />;
  return <App onLock={lock} />;
}

createRoot(document.getElementById("root")).render(<Root />);

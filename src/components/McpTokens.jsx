// "Connect an AI assistant" — personal access tokens for the MCP server.
//
// Each token is bound to the library it was created under, so an assistant
// connected with it can read and write that library and nothing else. The one
// exception is the Libby library code, which the schema keys on the account
// rather than the library; the copy below says so, because a person deciding
// whether to hand a token to an assistant should not have to read the schema.
//
// The raw token exists once, here, in state. It is shown once and never stored
// — only its sha256 reaches the database.
import { useState, useEffect } from "react";
import { listMcpTokens, createMcpToken, revokeMcpToken } from "../lib/db.js";
import { btnSecondary, btnDanger, inputCls, selectCls, selectArrowStyle, labelCls, Spinner, ConfirmRow, pillToggle } from "./shared.jsx";
import { Copy, Check, Plug } from "lucide-react";

const MCP_URL = "https://audiolib.io/api/mcp";

const EXPIRY_OPTIONS = [
  { value: "365", label: "1 year" },
  { value: "90", label: "90 days" },
  { value: "30", label: "30 days" },
  { value: "", label: "Never expires" },
];

function relative(iso) {
  if (!iso) return "never used";
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "used today";
  if (days === 1) return "used yesterday";
  if (days < 30) return `used ${days}d ago`;
  return `used ${new Date(iso).toLocaleDateString()}`;
}

function CopyButton({ value, label = "Copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* clipboard blocked — the value is on screen to select */ }
      }}
      className={`${btnSecondary} !py-1.5 shrink-0 text-xs`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {done ? "Copied" : label}
    </button>
  );
}

export default function McpTokens({ profile, onToast }) {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("365");
  const [readOnly, setReadOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null); // { token, row } — shown once
  const [confirming, setConfirming] = useState(null);
  const [howTo, setHowTo] = useState(false);

  const load = async () => {
    try { setTokens(await listMcpTokens(profile.id)); }
    catch (e) { onToast?.({ text: e.message, isError: true }); setTokens([]); }
  };

  useEffect(() => { setFresh(null); setConfirming(null); load(); }, [profile.id]);
  // Never let a raw token outlive the panel that revealed it.
  useEffect(() => () => setFresh(null), []);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const expiresAt = expiry
        ? new Date(Date.now() + Number(expiry) * 86_400_000).toISOString()
        : null;
      const result = await createMcpToken(profile.id, { name: trimmed, expiresAt, canWrite: !readOnly });
      setFresh(result);
      setName("");
      await load();
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    try {
      await revokeMcpToken(id);
      setConfirming(null);
      await load();
      onToast?.({ text: "Token revoked" });
    } catch (e) { onToast?.({ text: e.message, isError: true }); }
  };

  const live = (tokens ?? []).filter((t) => !t.revoked_at);

  return (
    <div>
      <div className={labelCls}>Connect an AI assistant</div>
      <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
        Use <code className="font-mono">{MCP_URL}</code> and create a token to let Claude or
        another AI or LLM work with your own library. Track books and get recommendations from
        your own taste. Ask it “what should I listen to next?” and it answers from what you've
        actually loved. A token reaches <strong>only this library</strong>, never your others,
        and you can revoke it any time.
      </p>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <button onClick={() => setHowTo((v) => !v)} className={pillToggle(howTo)}>
          How do I connect Claude?
        </button>
      </div>

      {howTo && (
        <ol className="mb-4 space-y-2 rounded-lg border border-zinc-300/90 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          <li>
            <strong className="text-zinc-700 dark:text-zinc-300">1. Make a token below.</strong>{" "}
            Give it a name, press Create, and copy it. It's only shown once.
          </li>
          <li>
            <strong className="text-zinc-700 dark:text-zinc-300">2. In Claude,</strong> open
            Settings → Connectors → <em>Add</em> → <em>Add custom connector</em>. Name it
            anything; the server URL is <code className="font-mono">{MCP_URL}</code>.
          </li>
          <li>
            <strong className="text-zinc-700 dark:text-zinc-300">3. Set Authentication to “None”.</strong>{" "}
            Claude pre-selects “Always required”, which means signing in through a login page —
            this uses a token instead, and “None” is the option that lets you paste one.
          </li>
          <li>
            <strong className="text-zinc-700 dark:text-zinc-300">4. Add a request header</strong>{" "}
            named <code className="font-mono">authorization</code> with your token as the value.
            Save, and Claude should list 20 tools.
          </li>
          <li className="pt-1 text-zinc-500 dark:text-zinc-500">
            Using Claude Code instead? Paste the one-line command shown with your new token —
            no clicking required.
          </li>
        </ol>
      )}

      {fresh ? (
        <div className="mb-4 rounded-lg border border-accent-500/60 bg-accent-50 p-3 dark:bg-accent-700/10">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent-700 dark:text-accent-400">
            Copy this now — it won't be shown again
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-xs dark:bg-zinc-900">
              {fresh.token}
            </code>
            <CopyButton value={fresh.token} />
          </div>
          <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">Claude Code:</div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 font-mono text-[11px] dark:bg-zinc-900">
              {`claude mcp add --transport http audiolib ${MCP_URL} --header "Authorization: Bearer ${fresh.token}"`}
            </code>
            <CopyButton
              value={`claude mcp add --transport http audiolib ${MCP_URL} --header "Authorization: Bearer ${fresh.token}"`}
            />
          </div>
          <button onClick={() => setFresh(null)} className={`${btnSecondary} !py-1.5 text-xs`}>Done</button>
        </div>
      ) : (
        <div className="mb-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What's it for? e.g. Claude on my laptop"
              className={`${inputCls} min-w-0 flex-1`}
            />
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className={`${selectCls} w-auto shrink-0`} style={selectArrowStyle}>
              {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button onClick={create} disabled={!name.trim() || creating} className={`${btnSecondary} shrink-0`}>
              {creating ? <Spinner /> : <Plug className="h-4 w-4" />} Create token
            </button>
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="accent-accent-500" />
            Read-only (the assistant can look, but not change anything)
          </label>
        </div>
      )}

      {tokens === null ? (
        <Spinner />
      ) : live.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No tokens yet.</p>
      ) : (
        <div className="space-y-2">
          {live.map((t) => (
            <div key={t.id} className="rounded-lg border border-zinc-300/90 px-3 py-2 dark:border-zinc-800">
              {confirming === t.id ? (
                <ConfirmRow
                  message={`Revoke "${t.name}"? Any assistant using it loses access immediately.`}
                  confirmLabel="REVOKE"
                  onConfirm={() => revoke(t.id)}
                  onCancel={() => setConfirming(null)}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {t.name}
                      {!t.can_write && <span className="ml-2 text-xs font-normal text-zinc-500">read-only</span>}
                    </div>
                    <div className="truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {t.token_prefix}… · {relative(t.last_used_at)}
                      {t.expires_at ? ` · expires ${new Date(t.expires_at).toLocaleDateString()}` : " · no expiry"}
                    </div>
                  </div>
                  <button onClick={() => setConfirming(t.id)} className={`${btnDanger} !py-1.5 shrink-0 text-xs`}>Revoke</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

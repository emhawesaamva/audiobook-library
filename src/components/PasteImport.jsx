// "Paste a list" importer, shared by Settings and the onboarding wizard.
// Two steps: paste anything -> Claude (Haiku) identifies the books -> user
// confirms the list. On confirm, hands the chosen rows to onConfirm(rows),
// where rows are { title, author, status }.
import { useState } from "react";
import { Dialog, btnPrimary, btnSecondary, inputCls, selectCls, selectArrowStyle, Spinner, StatusChip } from "./shared.jsx";
import { identifyBookList } from "../lib/ai.js";
import { ClipboardList } from "lucide-react";

export default function PasteImport({ onConfirm, onToast }) {
  const [paste, setPaste] = useState(null); // null | {step:"input",text} | {step:"review",items,note,text}
  const [identifying, setIdentifying] = useState(false);

  const identify = async () => {
    if (!paste?.text?.trim()) return;
    setIdentifying(true);
    try {
      const { books: found, note } = await identifyBookList(paste.text);
      if (!found.length) onToast?.({ text: note || "No books found in that text", isError: true });
      else setPaste({ step: "review", text: paste.text, note, items: found.map((b) => ({ ...b, checked: true })) });
    } catch (e) {
      onToast?.({ text: e.message, isError: true });
    }
    setIdentifying(false);
  };

  const confirm = async (defaultStatus) => {
    const selected = (paste.items ?? []).filter((i) => i.checked);
    setPaste(null);
    await onConfirm(selected.map((i) => ({ title: i.title, author: i.author ?? null, status: i.status ?? defaultStatus })));
  };

  return (
    <>
      <button onClick={() => setPaste({ step: "input", text: "" })} className={btnSecondary}>
        <ClipboardList className="h-4 w-4" /> Paste a list
      </button>
      {paste && (
        <PasteDialog paste={paste} setPaste={setPaste} identifying={identifying} onIdentify={identify} onConfirm={confirm} />
      )}
    </>
  );
}

function PasteDialog({ paste, setPaste, identifying, onIdentify, onConfirm }) {
  const [defaultStatus, setDefaultStatus] = useState("wanttoread");
  const items = paste.items ?? [];
  const selectedCount = items.filter((i) => i.checked).length;

  const toggle = (idx) =>
    setPaste({ ...paste, items: items.map((it, i) => (i === idx ? { ...it, checked: !it.checked } : it)) });

  return (
    <Dialog title="Import from a pasted list" onClose={() => setPaste(null)} wide={paste.step === "review"}>
      {paste.step === "input" ? (
        <>
          <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
            Paste any list of books — from Apple Notes, a text message, an email, anywhere. Numbering, typos,
            and stray comments are fine; the librarian will sort it out.
          </p>
          <textarea
            autoFocus
            rows={10}
            value={paste.text}
            onChange={(e) => setPaste({ ...paste, text: e.target.value })}
            placeholder={"e.g.\n1. project hail mary\n2. The Martian - andy weir (loved it!)\nmurderbot??\nfinish blood over bright haven"}
            className={inputCls}
          />
          <button onClick={onIdentify} disabled={identifying || !paste.text.trim()} className={`${btnPrimary} mt-3 w-full`}>
            {identifying ? <><Spinner /> Reading your list…</> : "Identify books"}
          </button>
        </>
      ) : (
        <>
          <p className="mb-1 text-sm text-zinc-600 dark:text-zinc-400">
            Found <strong>{items.length}</strong> book{items.length === 1 ? "" : "s"} — uncheck anything that looks wrong, then import.
          </p>
          {paste.note && <p className="mb-2 text-xs italic text-zinc-500 dark:text-zinc-400">{paste.note}</p>}
          <div className="mb-3 max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-300/90 p-2 dark:border-zinc-800">
            {items.map((it, i) => (
              <label key={i} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                <input type="checkbox" checked={it.checked} onChange={() => toggle(i)} className="accent-accent-500" />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{it.title}</span>
                  {it.author && <span className="text-zinc-500 dark:text-zinc-400"> — {it.author}</span>}
                </span>
                {it.status && <StatusChip status={it.status} />}
              </label>
            ))}
          </div>
          <div className="mb-3 flex items-center gap-2 text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">Import unmarked books as</span>
            <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)} className={`${selectCls} !w-auto !py-1.5`} style={selectArrowStyle}>
              <option value="wanttoread">Want to Listen</option>
              <option value="read">Read</option>
              <option value="reading">Listening</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onConfirm(defaultStatus)} disabled={!selectedCount} className={`${btnPrimary} flex-1`}>
              Looks right — import {selectedCount} book{selectedCount === 1 ? "" : "s"}
            </button>
            <button onClick={() => setPaste({ step: "input", text: paste.text })} className={btnSecondary}>← Edit text</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

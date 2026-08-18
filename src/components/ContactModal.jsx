// Contact-us dialog opened from the toolbar's "?" button. Sends a comment,
// question, or bit of feedback, stored for admin review (see Admin.jsx).
import { useState } from "react";
import { Dialog, Spinner, btnPrimary, btnSecondary, inputCls, labelCls } from "./shared.jsx";
import * as db from "../lib/db.js";

export default function ContactModal({ email, onClose, onToast }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await db.createFeedback(email, message.trim());
      onToast?.({ text: "Thanks — your message was sent." });
      onClose();
    } catch (e) {
      onToast?.({ text: `Couldn't send: ${e.message}`, isError: true });
      setSending(false);
    }
  };

  return (
    <Dialog title="Contact us" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>From</label>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">{email}</div>
        </div>
        <div>
          <label className={labelCls}>Message</label>
          <textarea
            autoFocus
            rows={6}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="A comment, question, or bit of feedback…"
            className={inputCls}
          />
        </div>
      </div>
      <div className="mt-5 flex gap-2">
        <button onClick={send} disabled={sending || !message.trim()} className={`${btnPrimary} flex-1`}>
          {sending ? <Spinner /> : "Send"}
        </button>
        <button onClick={onClose} className={btnSecondary}>Cancel</button>
      </div>
    </Dialog>
  );
}

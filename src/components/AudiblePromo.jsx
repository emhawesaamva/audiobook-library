// One-time upsell shown after a user adds (or "wants") a book. Hidden entirely
// for self-identified Audible subscribers. The "grab it free" link carries the
// Amazon Associates affiliate tag so the site earns commission on trial signups.
import { Headphones } from "lucide-react";
import { Dialog, btnPrimary, btnSecondary } from "./shared.jsx";
import { audibleSearchUrl } from "../lib/bookUtils.js";

export default function AudiblePromo({ book, affiliateTag, onSubscriber, onClose }) {
  return (
    <Dialog title="This book is on Audible" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-500 shadow-sm">
            <Headphones className="h-5 w-5 text-zinc-900" />
          </span>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            <span className="font-semibold text-zinc-800 dark:text-zinc-100">“{book.title}”</span> is available on Audible —
            new members can grab their first audiobook free with a trial.
          </p>
        </div>
        <a
          href={audibleSearchUrl(book, affiliateTag)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
          className={`${btnPrimary} w-full`}
        >
          <Headphones className="h-4 w-4" /> Want to grab it free?
        </a>
        <button onClick={onSubscriber} className={`${btnSecondary} w-full`}>
          Already a subscriber
        </button>
      </div>
    </Dialog>
  );
}

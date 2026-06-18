// "How to export from X" accordions, shared by Settings and the onboarding
// wizard so the import instructions stay in one place.
import { useState } from "react";

const SOURCES = [
  { id: "audible", label: "Audible" },
  { id: "goodreads", label: "Goodreads" },
  { id: "libby", label: "Libby" },
  { id: "storygraph", label: "StoryGraph" },
];

const link = "mt-2 block text-accent-600 hover:underline dark:text-accent-400";
const panel = "mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-800/50";
const list = "list-decimal space-y-1 pl-4 text-zinc-600 dark:text-zinc-300";

export default function ImportGuides() {
  const [open, setOpen] = useState(null); // "audible" | "goodreads" | "libby" | "storygraph" | null
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SOURCES.map((g) => (
          <button
            key={g.id}
            onClick={() => setOpen(open === g.id ? null : g.id)}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
              open === g.id
                ? "border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-700/15 dark:text-accent-400"
                : "border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400"
            }`}
          >
            How to export from {g.label}
          </button>
        ))}
      </div>

      {open === "audible" && (
        <div className={panel}>
          <ol className={list}>
            <li>Install the free <strong>Audible Library Extractor</strong> extension for Chrome or Edge.</li>
            <li>Log in to audible.com and navigate to your library.</li>
            <li>Click the <strong>Audible Library Extractor</strong> button below the search input.</li>
            <li>Choose what to extract, then click the blue button to start.</li>
            <li>When finished, open the gallery menu (top right) → <strong>Extension tools → Export CSV → Raw data</strong>.</li>
            <li>Return here, click Import, and select that file.</li>
          </ol>
          <a href="https://joonaspaakko.gitbook.io/audible-library-extractor/gallery/csv-export" target="_blank" rel="noopener noreferrer" className={link}>
            Documentation →
          </a>
        </div>
      )}
      {open === "goodreads" && (
        <div className={panel}>
          <ol className={list}>
            <li>Log in to <strong>goodreads.com</strong> on a desktop browser.</li>
            <li>Go to <strong>My Books</strong>, then select <strong>Import and Export</strong> from the left sidebar.</li>
            <li>Click <strong>Export Library</strong> — a CSV file will download.</li>
            <li>Return here, click Import, and select that file.</li>
          </ol>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">Your ratings, shelves (read/reading/want-to-read), and read dates are all imported.</p>
          <a href="https://help.goodreads.com/s/article/How-do-I-import-or-export-my-books-1553870934590" target="_blank" rel="noopener noreferrer" className={link}>
            Documentation →
          </a>
        </div>
      )}
      {open === "libby" && (
        <div className={panel}>
          <ol className={list}>
            <li>Open the <strong>Libby app</strong> or visit <strong>libbyapp.com</strong>.</li>
            <li>Tap <strong>Shelf</strong>, then tap <strong>Timeline</strong> at the top of the screen.</li>
            <li>Tap <strong>Actions → Export Timeline</strong>.</li>
            <li>Choose <strong>Spreadsheet</strong> to download a CSV file.</li>
            <li>Return here, click Import, and select that file.</li>
          </ol>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">Only audiobook activity is imported — ebooks and magazines are skipped automatically.</p>
          <a href="https://help.libbyapp.com/en-us/6207.htm" target="_blank" rel="noopener noreferrer" className={link}>
            Documentation →
          </a>
        </div>
      )}
      {open === "storygraph" && (
        <div className={panel}>
          <ol className={list}>
            <li>Log in to <strong>app.thestorygraph.com</strong>.</li>
            <li>Click your profile icon (top right) → <strong>Manage Account</strong>.</li>
            <li>Scroll down to the <strong>Manage Your Data</strong> section and click <strong>Export StoryGraph Library</strong>.</li>
            <li>StoryGraph will email you a download link — open that email and download the CSV file.</li>
            <li>Return here, click Import, and select that file.</li>
          </ol>
          <p className="mt-2 text-zinc-500 dark:text-zinc-400">Your read status, ratings, reviews, tags, and moods are all imported.</p>
          <a href="https://app.thestorygraph.com/user-export" target="_blank" rel="noopener noreferrer" className={link}>
            Go to StoryGraph Export page →
          </a>
        </div>
      )}
    </>
  );
}

// Public marketing landing page shown to signed-out visitors at "/".
// Logged-in users never see this (AuthGate skips it when a session exists).
// Clicking any CTA calls onSignIn, which flips AuthGate over to <Login>.
import { useState } from "react";
import {
  Headphones, Sparkles, Library, BarChart3, Share2, Users,
  BookOpen, ArrowRight, Moon, Sun,
} from "lucide-react";
import { btnPrimary, btnSecondary, Stars, StatusChip, Cover } from "./shared.jsx";

const FEATURES = [
  {
    Icon: Sparkles,
    title: "AI recommendations that get you",
    body: "Tell our Claude-powered librarian what you're in the mood for, or let it surface picks based on the books and authors you've loved. Every suggestion comes with the cover, narrator, and why it fits.",
  },
  {
    Icon: Library,
    title: "Track every listen",
    body: "Statuses for Listening, Finished, Want to Listen, and DNF. Rate with half-stars, mark all-time favorites, and keep full series together automatically.",
  },
  {
    Icon: BookOpen,
    title: "Covers & details, auto-filled",
    body: "Add a title and we pull the cover art, narrator, runtime, series order, and crowd rating from Audible — no typing required.",
  },
  {
    Icon: BarChart3,
    title: "Your year in audiobooks",
    body: "Hours listened, top authors and narrators, rating breakdowns, hidden gems, and how your taste compares to the crowd. Set yearly goals and watch them fill.",
  },
  {
    Icon: Share2,
    title: "Share your shelf",
    body: "Publish a beautiful read-only version of any library with one link. Friends can browse your ratings and add picks straight to their own shelf.",
  },
  {
    Icon: Users,
    title: "A library for everyone",
    body: "Separate profiles for each listener — kids, teens, adults — each with its own shelf, goals, and age-appropriate recommendations.",
  },
];

const STEPS = [
  {
    title: "Import or add your books",
    body: "Bring your history over from Audible, Goodreads, or Libby, paste in any list of titles and let AI sort it out, or just start typing.",
  },
  {
    title: "Rate and organize",
    body: "Mark what you've finished, star your favorites, and queue up what's next.",
  },
  {
    title: "Discover your next listen",
    body: "Get AI picks tuned to your taste, with live library availability through Libby.",
  },
];

function Logo({ className = "" }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-500 shadow-sm">
        <Headphones className="h-5 w-5 text-zinc-900" />
      </span>
      <span className="text-lg font-bold">
        AudioLib<span className="text-accent-600">.io</span>
      </span>
    </span>
  );
}

// Real Audible cover art (from the same catalog the app uses). The shared
// <Cover> component falls back to a titled gradient if any image 404s.
// Every title appears once — never in both the recommended strip and the shelf.
// Books shown in the mockup's "Recommended for you" strip.
const RECS = [
  { title: "Project Hail Mary", cover_url: "https://m.media-amazon.com/images/I/51POf8gOyLL._SL500_.jpg" },
  { title: "It Ends with Us", cover_url: "https://m.media-amazon.com/images/I/514AlIuBkKL._SL500_.jpg" },
  { title: "Dune", cover_url: "https://m.media-amazon.com/images/I/41rrXYM-wHL._SL500_.jpg" },
];

// Books shown in the mockup's shelf grid.
const SHELF = [
  { title: "The Martian", cover_url: "https://m.media-amazon.com/images/I/414J3xG+7+L._SL500_.jpg", chip: "reading" },
  { title: "The Way of Kings", cover_url: "https://m.media-amazon.com/images/I/51hAwcG3oNL._SL500_.jpg", chip: "read" },
  { title: "A Game of Thrones", cover_url: "https://m.media-amazon.com/images/I/51y1J8oFBqL._SL500_.jpg", chip: null },
  { title: "Where the Crawdads Sing", cover_url: "https://m.media-amazon.com/images/I/51MnNmMUHhL._SL500_.jpg", chip: "read" },
  { title: "Wool", cover_url: "https://m.media-amazon.com/images/I/51wvy7jratL._SL500_.jpg", chip: "wanttoread" },
  { title: "The Hunger Games", cover_url: "https://m.media-amazon.com/images/I/51vOc7NtICL._SL500_.jpg", chip: "read" },
  { title: "Harry Potter and the Sorcerer's Stone", cover_url: "https://m.media-amazon.com/images/I/51xJbFMRsxL._SL500_.jpg", chip: null },
  { title: "The Fellowship of the Ring", cover_url: "https://m.media-amazon.com/images/I/51eVNlqfveL._SL500_.jpg", chip: "read" },
];

// A static, decorative "peek at the app" built from real cover art + design tokens.
function AppMockup() {
  return (
    <div className="mx-auto max-w-md animate-fade-up overflow-hidden rounded-2xl border border-zinc-300/90 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
      {/* title bar */}
      <div className="flex items-center gap-1.5 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-amber-400" />
        <span className="h-3 w-3 rounded-full bg-emerald-400" />
        <span className="flex-1 text-center text-xs font-medium text-zinc-400 dark:text-zinc-500">AudioLib.io</span>
      </div>
      {/* body */}
      <div className="space-y-4 p-4">
        <div className="rounded-xl border border-accent-200/70 bg-accent-50/50 p-3 dark:border-accent-700/30 dark:bg-accent-700/5">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 shrink-0 text-accent-600" />
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">Recommended for you</span>
          </div>
          <div className="mt-2.5 flex gap-2">
            {RECS.map((r) => (
              <div key={r.title} className="w-1/3">
                <Cover book={r} className="aspect-[1/1.5] w-full shadow-sm" rounded="rounded-md" />
                <div className="mt-1 truncate text-[10px] text-zinc-500 dark:text-zinc-400">{r.title}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {SHELF.map((c, i) => (
            <div key={c.title}>
              <div className="relative">
                <Cover book={c} className="aspect-[1/1.5] w-full shadow-sm" rounded="rounded-lg" />
                {c.chip && <StatusChip status={c.chip} className="absolute left-1 top-1 shadow" />}
              </div>
              {i === 0 && (
                <div className="mt-1 flex justify-center">
                  <Stars rating={4.5} size="text-xs" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Landing({ onSignIn }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("lib_theme", next ? "dark" : "light");
  };

  const year = new Date().getFullYear();

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* ---- nav ---- */}
      <header className="sticky top-0 z-30 border-b border-zinc-200/70 bg-zinc-100/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Logo />
          <div className="flex items-center gap-2">
            <button
              onClick={toggleDark}
              aria-label={dark ? "Light mode" : "Dark mode"}
              className="rounded-md p-2 text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button className={btnPrimary} onClick={onSignIn}>Sign in</button>
          </div>
        </div>
      </header>

      <main>
        {/* ---- hero ---- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
                Your audiobook library, finally organized.
              </h1>
              <p className="mt-5 text-lg text-zinc-600 dark:text-zinc-300">
                AudioLib is the smart way to track every audiobook you've listened to, rate your
                favorites, and get personal recommendations from an AI librarian that knows your taste —
                then listen your way: buy it on Audible or borrow it free from your library with Libby.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <button className={btnPrimary} onClick={onSignIn}>
                  Get started — it's free <ArrowRight className="h-4 w-4" />
                </button>
                <button className={btnSecondary} onClick={onSignIn}>Sign in</button>
              </div>
              <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
                Free to use · Sign in with Google · No credit card.
              </p>
            </div>
            <AppMockup />
          </div>

          {/* integration strip */}
          <div className="mt-16 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Bring your books from anywhere
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {["Audible", "Goodreads", "Libby", "CSV", "Paste a list"].map((name) => (
                <span key={name} className="rounded-full border border-zinc-300/90 px-3 py-1 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                  {name}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ---- listen your way: Audible + Libby, side by side ---- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <h2 className="text-center text-3xl font-bold">Buy it, or borrow it free</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-zinc-600 dark:text-zinc-300">
            Every book on your shelf links straight to <strong>both</strong> Audible and Libby — so you
            choose how to listen: own a copy, or borrow it free from your local library.
          </p>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-300/90 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-500 shadow-sm">
                  <Headphones className="h-5 w-5 text-zinc-900" />
                </span>
                <h3 className="text-lg font-semibold">Listen on Audible</h3>
              </div>
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
                Jump to any title on Audible in one click — new members can grab their first audiobook
                free with a trial. Your whole shelf is there waiting, right alongside Audible's own picks.
              </p>
            </div>
            <div className="rounded-xl border border-zinc-300/90 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500 shadow-sm">
                  <Library className="h-5 w-5 text-white" />
                </span>
                <h3 className="text-lg font-semibold">Borrow free with Libby</h3>
              </div>
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
                Connect your library card and AudioLib checks Libby for live availability and wait times
                on every book — so you always know what you can borrow free right now. Libby doesn't
                recommend, so this is a genuine add: your whole list, matched to your library's shelves.
              </p>
            </div>
          </div>
        </section>

        {/* ---- features ---- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <h2 className="text-center text-3xl font-bold">Everything a listener needs on one shelf</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-zinc-600 dark:text-zinc-300">
            Every feature is free — AI recommendations, stats, sharing, and imports all included.
            No premium tiers, no paywalls, nothing locked behind an upgrade. Ever.
          </p>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-zinc-300/90 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-100 text-accent-700 dark:bg-accent-700/20 dark:text-accent-400">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 font-semibold">{title}</h3>
                <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- how it works ---- */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <h2 className="text-center text-3xl font-bold">Up and running in two minutes</h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {STEPS.map((step, i) => (
              <div key={step.title}>
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-500 font-bold text-zinc-900">
                  {i + 1}
                </div>
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-300">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- closing CTA ---- */}
        <section className="mx-auto max-w-6xl px-4 pb-16 sm:pb-24">
          <div className="rounded-2xl bg-accent-500 p-10 text-center text-zinc-900 sm:p-14">
            <h2 className="text-3xl font-bold">Start building your audiobook library today.</h2>
            <p className="mt-3 text-zinc-800">Free, private, and ready when you are.</p>
            <button
              onClick={onSignIn}
              className="mt-7 rounded-lg bg-zinc-900 px-5 py-2.5 font-semibold text-white transition hover:bg-zinc-800 cursor-pointer"
            >
              Get started
            </button>
          </div>
        </section>
      </main>

      {/* ---- footer ---- */}
      <footer className="border-t border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-10 text-sm text-zinc-500 dark:text-zinc-400">
          <div>
            <Logo />
            <p className="mt-2">The smart audiobook library.</p>
          </div>
          <p>© {year} AudioLib.io</p>
        </div>
      </footer>
    </div>
  );
}

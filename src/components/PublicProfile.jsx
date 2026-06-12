// Public read-only view of a shared library profile, accessible at /share/{profileId}.
// Uses a separate anon Supabase client so the viewer's session never leaks into
// public reads. The viewer's own authenticated client is used only for "add" writes.
import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import supabase from "../lib/supabase.js";
import { BookCardGrid, BookCoverTile, BookListRow } from "./BookCard.jsx";
import Stats from "./Stats.jsx";
import { Stars, StatusChip, Cover } from "./shared.jsx";
import {
  getStatus, calcSeriesRating, fmtDuration,
  audibleSearchUrl, goodreadsSearchUrl, flattenBooks,
} from "../lib/bookUtils.js";
import { createBook, listProfiles } from "../lib/db.js";
import {
  Library, X, Check, Grid3x3, LayoutGrid, List,
  Headphones, BookOpen, Plus,
} from "lucide-react";

const anonClient = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
  }
);

function assembleBooks(rows) {
  const byParent = new Map();
  for (const b of rows) {
    if (b.parent_id) {
      if (!byParent.has(b.parent_id)) byParent.set(b.parent_id, []);
      byParent.get(b.parent_id).push(b);
    }
  }
  return rows
    .filter((b) => !b.parent_id)
    .map((b) =>
      b.is_series
        ? {
            ...b,
            books: (byParent.get(b.id) ?? []).sort(
              (a, c) => (a.series_position ?? 0) - (c.series_position ?? 0)
            ),
          }
        : b
    );
}

const FILTERS = [
  ["all", "All"],
  ["read", "Read"],
  ["reading", "Listening"],
  ["wanttoread", "Want to Listen"],
  ["crowd", "Crowd 4.5+"],
  ["loved", "Loved"],
];

function applyFilter(books, filter, sort) {
  let list = [...books];
  if (filter === "loved") {
    list = list.filter((b) => b.loved || b.books?.some((c) => c.loved));
  } else if (filter === "crowd") {
    list = list.filter((b) =>
      (b.is_series ? b.books ?? [] : [b]).some((c) => Number(c.goodreads_rating) >= 4.5)
    );
  } else if (filter !== "all") {
    list = list.filter((b) => getStatus(b) === filter);
  }
  if (sort === "title") list.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
  else if (sort === "author") list.sort((a, b) => (a.author ?? "").localeCompare(b.author ?? ""));
  else if (sort === "rating") list.sort((a, b) => calcSeriesRating(b) - calcSeriesRating(a));
  return list;
}

function BookViewModal({ book, onClose, onAdd }) {
  const status = getStatus(book);
  const rating = calcSeriesRating(book);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-4 top-4 rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer">
          <X className="h-4 w-4" />
        </button>
        <div className="flex gap-4">
          <Cover book={book} className="h-28 w-20 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-snug">{book.title}</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{book.author}</p>
            {book.narrator && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Narrated by {book.narrator}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusChip status={status} />
              {rating > 0 && <Stars rating={rating} size="text-sm" />}
              {book.duration_minutes && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{fmtDuration(book.duration_minutes)}</span>
              )}
            </div>
          </div>
        </div>
        {book.notes && <p className="mt-4 text-sm text-zinc-700 dark:text-zinc-300">{book.notes}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {onAdd && (
            <button onClick={() => { onClose(); onAdd(book); }}
              className="flex items-center gap-1.5 rounded-lg bg-accent-500 px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-accent-400 cursor-pointer">
              <Plus className="h-3.5 w-3.5" /> Add to my library
            </button>
          )}
          <a href={audibleSearchUrl(book)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <Headphones className="h-3.5 w-3.5" /> Audible
          </a>
          <a href={goodreadsSearchUrl(book)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <BookOpen className="h-3.5 w-3.5" /> Goodreads
          </a>
        </div>
      </div>
    </div>
  );
}

function SeriesViewModal({ series, onClose, onAdd }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute right-4 top-4 rounded-md p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer">
          <X className="h-4 w-4" />
        </button>
        <h2 className="mb-4 text-lg font-semibold">{series.title}</h2>
        <div className="max-h-96 space-y-1 overflow-y-auto">
          {(series.books ?? []).map((book) => (
            <div key={book.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              <Cover book={book} className="h-10 w-7 shrink-0" rounded="rounded" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{book.title}</div>
                <div className="flex items-center gap-1.5">
                  <StatusChip status={getStatus(book)} />
                  {Number(book.rating) > 0 && <Stars rating={Number(book.rating)} size="text-xs" />}
                </div>
              </div>
              {onAdd && (
                <button onClick={() => onAdd(book)}
                  className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 cursor-pointer">
                  + Add
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AddToLibraryDialog({ book, profiles, onConfirm, onClose }) {
  const [picked, setPicked] = useState(profiles[0]?.id ?? null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-base font-semibold">Add to which library?</h2>
        <p className="mb-4 truncate text-sm text-zinc-500 dark:text-zinc-400">"{book.title}"</p>
        <div className="mb-4 space-y-2">
          {profiles.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
              <input type="radio" name="profile" value={p.id} checked={picked === p.id}
                onChange={() => setPicked(p.id)} className="accent-amber-500" />
              <span className="flex-1 text-sm font-medium">{p.name}</span>
              {picked === p.id && <Check className="h-4 w-4 text-accent-600" />}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={() => onConfirm(picked)}
            className="flex-1 rounded-lg bg-accent-500 py-2 text-sm font-semibold text-zinc-900 hover:bg-accent-400 cursor-pointer">
            Add to Library
          </button>
          <button onClick={onClose}
            className="flex-1 rounded-lg border border-zinc-300 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 cursor-pointer">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PublicProfile({ profileId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [profile, setProfile] = useState(null);
  const [books, setBooks] = useState([]);

  // Viewer's own auth state (used for "add to my library" flow only)
  const [viewerSession, setViewerSession] = useState(undefined);
  const [viewerProfiles, setViewerProfiles] = useState([]);

  const [tab, setTab] = useState("library");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("added");
  const [view, setView] = useState(localStorage.getItem("lib_view") ?? "cards");

  const [viewingBook, setViewingBook] = useState(null);
  const [viewingSeries, setViewingSeries] = useState(null);
  const [addingBook, setAddingBook] = useState(null);
  const [addSuccess, setAddSuccess] = useState(false);
  const [addError, setAddError] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const { data: prof, error: pe } = await anonClient
          .from("profiles").select("*").eq("id", profileId).single();
        if (pe) throw pe;
        setProfile(prof);
        const { data: rows, error: be } = await anonClient
          .from("books").select("*").eq("profile_id", profileId).order("created_at");
        if (be) throw be;
        setBooks(assembleBooks(rows ?? []));
      } catch (e) {
        setError(e.message || "Failed to load library.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [profileId]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setViewerSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_, s) => setViewerSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!viewerSession) { setViewerProfiles([]); return; }
    listProfiles(viewerSession.user.id).then(setViewerProfiles).catch(console.warn);
  }, [viewerSession]);

  const filtered = useMemo(() => applyFilter(books, filter, sort), [books, filter, sort]);

  async function doAdd(book, targetProfileId) {
    try {
      await createBook({
        profile_id: targetProfileId,
        title: book.title,
        author: book.author,
        narrator: book.narrator,
        genre: book.genre,
        subgenre: book.subgenre,
        cover_url: book.cover_url,
        duration_minutes: book.duration_minutes,
        year: book.year,
        asin: book.asin,
        goodreads_rating: book.goodreads_rating,
        goodreads_url: book.goodreads_url,
        status: "recommended",
        recommended_by: profile?.name ?? "Shared library",
      });
      setAddingBook(null);
      setAddSuccess(true);
      setTimeout(() => setAddSuccess(false), 2500);
    } catch (e) {
      setAddError(e.message);
      setTimeout(() => setAddError(null), 4000);
    }
  }

  function handleAdd(book) {
    if (viewerSession === undefined) return;
    if (!viewerSession) { window.location.href = "/"; return; }
    if (viewerProfiles.length === 0) return;
    if (viewerProfiles.length === 1) {
      doAdd(book, viewerProfiles[0].id);
    } else {
      setAddingBook(book);
    }
  }

  function cardProps(b) {
    return {
      book: b,
      readOnly: true,
      libbyKey: undefined,
      onEdit: b.is_series ? undefined : () => setViewingBook(b),
      onOpen: b.is_series ? () => setViewingSeries(b) : undefined,
      onAdd: () => handleAdd(b),
      onDelete: undefined,
      onQueueToggle: undefined,
    };
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        Loading…
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 text-center">
        <div>
          <p className="font-medium text-zinc-700 dark:text-zinc-300">Library not found</p>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{error ?? "This link may be invalid."}</p>
          <a href="/" className="mt-4 inline-block text-sm text-accent-600 hover:underline">Go to home</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <a href="/" className="flex items-center gap-1.5 font-semibold text-zinc-900 hover:opacity-80 dark:text-zinc-100">
            <Library className="h-5 w-5 text-accent-600" />
            <span className="hidden sm:inline">Library</span>
          </a>
          <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
          <div className="min-w-0 flex-1 flex items-center gap-2">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{profile.name}</span>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              Shared library · read only
            </span>
          </div>
          <div className="flex items-center gap-2">
            {addSuccess && (
              <span className="flex items-center gap-1 text-sm font-medium text-green-600 dark:text-green-400">
                <Check className="h-4 w-4" /> Added
              </span>
            )}
            {addError && (
              <span className="text-sm text-red-600 dark:text-red-400">{addError}</span>
            )}
            {viewerSession === null && (
              <a href="/" className="rounded-lg bg-accent-500 px-3 py-1.5 text-sm font-semibold text-zinc-900 hover:bg-accent-400">
                Sign in to add books
              </a>
            )}
          </div>
        </div>
      </header>

      {/* Tabs */}
      <div className="sticky top-[57px] z-20 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex max-w-5xl gap-1 px-4">
          {[["library", "Library"], ["stats", "Stats"]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition cursor-pointer ${
                tab === id
                  ? "border-accent-500 text-accent-700 dark:text-accent-400"
                  : "border-transparent text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "library" && (
          <>
            {/* Toolbar */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1.5">
                {FILTERS.map(([id, label]) => (
                  <button key={id} onClick={() => setFilter(id)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition cursor-pointer ${
                      filter === id
                        ? "bg-accent-500 text-zinc-900"
                        : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <select value={sort} onChange={(e) => setSort(e.target.value)}
                  className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900 cursor-pointer">
                  <option value="added">Recently added</option>
                  <option value="title">Title</option>
                  <option value="author">Author</option>
                  <option value="rating">Rating</option>
                </select>
                <div className="flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
                  {[["covers", Grid3x3], ["cards", LayoutGrid], ["list", List]].map(([v, Icon]) => (
                    <button key={v} onClick={() => setView(v)}
                      className={`px-2 py-1.5 cursor-pointer ${
                        view === v
                          ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
                          : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                      }`}>
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Book grid / list */}
            {filtered.length === 0 ? (
              <p className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">No books found.</p>
            ) : view === "covers" ? (
              <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7">
                {filtered.map((b) => <BookCoverTile key={b.id} {...cardProps(b)} />)}
              </div>
            ) : view === "list" ? (
              <div className="rounded-xl border border-zinc-300/90 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                {filtered.map((b) => <BookListRow key={b.id} {...cardProps(b)} />)}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((b) => <BookCardGrid key={b.id} {...cardProps(b)} />)}
              </div>
            )}
          </>
        )}

        {tab === "stats" && (
          <Stats books={books} goals={[]} onSetGoal={() => {}} readOnly title="My year in audiobooks" possessive="My" />
        )}
      </main>

      {viewingBook && (
        <BookViewModal
          book={viewingBook}
          onClose={() => setViewingBook(null)}
          onAdd={handleAdd}
        />
      )}
      {viewingSeries && (
        <SeriesViewModal
          series={viewingSeries}
          onClose={() => setViewingSeries(null)}
          onAdd={handleAdd}
        />
      )}
      {addingBook && (
        <AddToLibraryDialog
          book={addingBook}
          profiles={viewerProfiles}
          onConfirm={(pid) => doAdd(addingBook, pid)}
          onClose={() => setAddingBook(null)}
        />
      )}
    </div>
  );
}

// App shell: top bar (libraries, search, view toggle, theme, settings),
// tabs (Library / Stats / Recommend / Admin), and all data orchestration.
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import * as db from "./lib/db.js";
import { fetchRecommendations } from "./lib/ai.js";
import { searchBooks as metaSearch, resultToBook } from "./lib/metadata.js";
import { getStatus, calcSeriesRating, flattenBooks } from "./lib/bookUtils.js";
import { BookCardGrid, BookCoverTile, BookListRow } from "./components/BookCard.jsx";
import BookForm from "./components/BookForm.jsx";
import SeriesModal from "./components/SeriesModal.jsx";
import Recommend from "./components/Recommend.jsx";
import Stats from "./components/Stats.jsx";
import Settings from "./components/Settings.jsx";
import Admin from "./components/Admin.jsx";
import UpNext from "./components/UpNext.jsx";
import { Toast, Spinner, btnPrimary, btnSecondary, inputCls, labelCls } from "./components/shared.jsx";
import { Headphones, Sun, Moon, Settings as SettingsIcon, Plus, Grid3x3, LayoutGrid, List, LibraryBig } from "lucide-react";

const today = () => new Date().toISOString().slice(0, 10);

// Status transitions auto-set listening dates (still editable in the form).
function withAutoDates(fields, prev) {
  const out = { ...fields };
  if (out.status === "reading" && !out.date_started) out.date_started = today();
  if (out.status === "read" && !out.date_finished) {
    out.date_finished = today();
    if (!out.date_started && prev?.date_started) out.date_started = prev.date_started;
  }
  return out;
}

function CreateFirstLibrary({ onCreate }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="w-full max-w-sm rounded-xl border border-zinc-300/90 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <LibraryBig className="mx-auto mb-2 h-9 w-9 text-accent-500" />
        <h2 className="text-lg font-semibold">Create your first library</h2>
        <p className="mb-4 mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Libraries keep collections separate — one per person, or per genre, or however you like.
        </p>
        <input
          autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && onCreate(name.trim(), setBusy)}
          placeholder="e.g. My Library" className={inputCls}
        />
        <button
          onClick={() => name.trim() && onCreate(name.trim(), setBusy)}
          disabled={!name.trim() || busy}
          className={`${btnPrimary} mt-3 w-full`}
        >
          {busy ? <Spinner /> : "Create library"}
        </button>
      </div>
    </div>
  );
}

const FILTERS = [
  ["all", "All"], ["recommended", "Rec"], ["loved", "Loved"],
  ["read", "Read"], ["reading", "Listening"], ["want", "Want"], ["dnf", "DNF"],
];

const SORTS = [
  ["status", "Status"], ["rating", "Rating"], ["recent", "Recently added"],
  ["title", "Title A–Z"], ["author", "Author A–Z"], ["duration", "Length"],
];

export default function App({ session, onSignOut }) {
  const uid = session.user.id;

  const [account, setAccount] = useState(null);
  const [appSettings, setAppSettings] = useState({});
  const [profiles, setProfiles] = useState(null); // null = loading
  const [activeId, setActiveId] = useState(null);
  const [books, setBooks] = useState([]);
  const [booksReady, setBooksReady] = useState(false);
  const [goals, setGoals] = useState([]);

  const [tab, setTab] = useState("library");
  const [view, setView] = useState(localStorage.getItem("lib_view") ?? "cards");
  const [filter, setFilter] = useState("all");
  const [genre, setGenre] = useState("all");
  const [search, setSearch] = useState("");
  const [minRating, setMinRating] = useState(0);
  const [sortBy, setSortBy] = useState("status");

  const [form, setForm] = useState(null);          // {book} | null
  const [seriesOpen, setSeriesOpen] = useState(null); // series id | null
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("lib_theme") ?? "light");
  const [toast, setToastRaw] = useState(null);
  const [banner, setBanner] = useState(null);      // persistent status / error line

  const toastTimer = useRef(null);
  const setToast = useCallback((t) => {
    setToastRaw(t);
    clearTimeout(toastTimer.current);
    if (t && !t.sticky) toastTimer.current = setTimeout(() => setToastRaw(null), 2600);
  }, []);

  const activeIdRef = useRef(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const activeProfile = profiles?.find((p) => p.id === activeId) ?? null;

  // ---- theme ----
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("lib_theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("lib_view", view); }, [view]);

  // ---- initial load ----
  useEffect(() => {
    (async () => {
      try {
        const [acct, profs, settings, app] = await Promise.all([
          db.getAccount(uid),
          db.listProfiles(),
          db.getUserSettings(uid),
          db.getAppSettings(),
        ]);
        setAccount(acct);
        setAppSettings(app);
        if (settings.theme) setTheme(settings.theme);
        if (settings.settings?.view) setView(settings.settings.view);
        setProfiles(profs);
        const first =
          profs.find((p) => p.id === settings.default_profile_id) ?? profs[0] ?? null;
        if (first) selectProfile(first.id, profs);
      } catch (e) {
        setBanner({ text: `Load failed: ${e.message}`, isError: true });
        setProfiles([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const refreshBooks = useCallback(async (profileId = activeIdRef.current) => {
    if (!profileId) return [];
    const data = await db.loadBooks(profileId);
    if (activeIdRef.current === profileId) setBooks(data);
    return data;
  }, []);

  const selectProfile = useCallback(async (profileId) => {
    setBooksReady(false);
    setBooks([]);
    setFilter("all");
    setSearch("");
    setActiveId(profileId);
    activeIdRef.current = profileId;
    try {
      const data = await db.loadBooks(profileId);
      if (activeIdRef.current !== profileId) return;
      setBooks(data);
      db.snapshot(profileId, data);
      db.listGoals(profileId).then((g) => activeIdRef.current === profileId && setGoals(g));
    } catch (e) {
      setBanner({ text: `Couldn't load library: ${e.message}`, isError: true });
    }
    setBooksReady(true);
  }, []);

  useEffect(() => {
    if (activeProfile) document.title = `${activeProfile.name} · Em's Library`;
  }, [activeProfile]);

  // ---- auto-recommend: keep 2 "recommended" books per library ----
  const autoRecommended = useRef(new Set());
  useEffect(() => {
    if (!booksReady || !activeId || !activeProfile || autoRecommended.current.has(activeId)) return;
    autoRecommended.current.add(activeId);
    const needed = 2 - books.filter((b) => getStatus(b) === "recommended").length;
    if (needed <= 0) return;

    const profileId = activeId;
    const { name, age_group } = activeProfile;
    (async () => {
      try {
        const rejected = await db.listRejected(profileId);
        let current = [...books];
        for (let i = 0; i < needed; i++) {
          if (activeIdRef.current !== profileId) return;
          setBanner({ text: `Finding a recommendation for you${needed > 1 ? ` (${i + 1}/${needed})` : ""}…` });
          const exclude = new Set([
            ...current.map((b) => b.title.toLowerCase()),
            ...flattenBooks(current).map((b) => b.title.toLowerCase()),
            ...rejected.map((t) => t.toLowerCase()),
          ]);
          const lovedAuthors = [...new Set(current.filter((b) => b.loved || Number(b.rating) >= 5).map((b) => b.author).filter(Boolean))];
          const query = `Find me an audiobook ${lovedAuthors.length ? `similar to books by these loved authors: ${lovedAuthors.join(", ")}` : "that is highly rated and popular"}. Already in my library — do not suggest these: ${[...exclude].join(", ") || "none"}. Return one well-known match.`;
          let rec = null;
          try {
            const result = await fetchRecommendations({
              books: current, profileName: name, ageGroup: age_group, query,
              model: appSettings.default_model, maxTokens: 2000,
            });
            rec = result.recommendations.find((r) => !exclude.has(r.title.toLowerCase())) ?? null;
          } catch { /* skip this round */ }
          if (!rec || activeIdRef.current !== profileId) continue;

          let enriched = {};
          try {
            const { results } = await metaSearch(`${rec.title} ${rec.author}`, 2);
            if (results[0]) enriched = resultToBook(results[0]);
          } catch { /* best-effort */ }

          const row = await db.createBook({
            profile_id: profileId,
            author: rec.author,
            genre: rec.genre || "Science Fiction", subgenre: rec.subgenre || "",
            status: "recommended", recommended_by: "Claude",
            ...enriched, title: enriched.title || rec.title,
          });
          current = [...current, row];
          if (activeIdRef.current === profileId) {
            setBanner({ text: `Added "${row.title}" as a recommendation` });
            await refreshBooks(profileId);
          }
        }
      } finally {
        if (activeIdRef.current === profileId) setBanner(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booksReady, activeId]);

  // ---- mutations ----
  const saveBook = async (fields, { targetSeriesId } = {}) => {
    if (fields.id) {
      const prev = books.flatMap((b) => (b.is_series ? [b, ...(b.books ?? [])] : [b])).find((b) => b.id === fields.id);
      await db.updateBook(fields.id, withAutoDates(fields, prev));
    } else if (targetSeriesId) {
      const series = books.find((b) => b.id === targetSeriesId);
      await db.createBook({
        ...withAutoDates(fields), profile_id: activeId, parent_id: targetSeriesId,
        series_position: (series?.books?.length ?? 0) + 1,
      });
    } else {
      await db.createBook({ ...withAutoDates(fields), profile_id: activeId });
    }
    await refreshBooks();
  };

  // Bulk import with automatic series grouping: rows may carry a transient
  // `_series` ({asin, title, position}) from metadata enrichment. Imported
  // books join an existing series header when titles match, or form a new
  // series when two or more of them share one. Returns { seriesCount }.
  const importBooks = async (rows) => {
    const normTitle = (s) =>
      (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
        .replace(/\b(the|a|an|series|saga|trilogy)\b/g, " ").replace(/\s+/g, " ").trim();

    const created = await db.createBooks(
      rows.map(({ _series, ...r }) => ({ ...r, profile_id: activeId }))
    );

    const groups = new Map(); // seriesAsin -> { title, members: [{id, position}] }
    rows.forEach((r, i) => {
      if (!r._series?.asin || !created[i]) return;
      if (!groups.has(r._series.asin)) groups.set(r._series.asin, { title: r._series.title, members: [] });
      groups.get(r._series.asin).members.push({ row: created[i], position: r._series.position ?? null });
    });

    let seriesCount = 0;
    for (const group of groups.values()) {
      const existing = books.find((b) => b.is_series && normTitle(b.title) === normTitle(group.title));
      if (!existing && group.members.length < 2) continue; // no one-book series
      let headerId = existing?.id;
      if (!headerId) {
        const first = group.members[0].row;
        const header = await db.createBook({
          profile_id: activeId, is_series: true, title: group.title,
          author: first.author, genre: first.genre, subgenre: first.subgenre,
          cover_url: group.members.find((m) => m.row.cover_url)?.row.cover_url ?? null,
        });
        headerId = header.id;
      }
      for (const m of group.members) {
        await db.updateBook(m.row.id, { parent_id: headerId, series_position: m.position });
      }
      seriesCount++;
    }
    await refreshBooks();
    return { seriesCount };
  };

  const saveSeries = async (header, volumes) => {
    const parent = await db.createBook({ ...header, profile_id: activeId, is_series: true });
    if (volumes.length) {
      await db.createBooks(volumes.map((v) => ({ ...v, profile_id: activeId, parent_id: parent.id })));
    }
    await refreshBooks();
  };

  const guard = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) { setToast({ text: e.message, isError: true }); }
  };

  const removeBook = guard(async (book) => {
    await db.deleteBook(book.id);
    if (getStatus(book) === "recommended") db.addRejected(activeId, book.title).catch(() => {});
    await refreshBooks();
    setToast({ text: `Deleted "${book.title}"` });
  });

  // ---- up-next queue ----
  const queue = useMemo(() => {
    const all = books.flatMap((b) => (b.is_series ? (b.books ?? []) : [b]));
    return all.filter((b) => b.queue_position != null).sort((a, b) => a.queue_position - b.queue_position);
  }, [books]);

  const queueToggle = guard(async (book) => {
    const queued = book.queue_position != null;
    await db.updateBook(book.id, {
      queue_position: queued ? null : (queue[queue.length - 1]?.queue_position ?? 0) + 1,
    });
    await refreshBooks();
    setToast({ text: queued ? "Removed from Up Next" : "Added to Up Next" });
  });

  const startListening = guard(async (book) => {
    await db.updateBook(book.id, { status: "reading", date_started: today(), queue_position: null });
    await refreshBooks();
    setToast({ text: `Started "${book.title}"` });
  });

  // ---- profiles ----
  const addProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    try {
      const p = await db.createProfile(name);
      const next = [...(profiles ?? []), p];
      setProfiles(next);
      setAddingProfile(false);
      setNewProfileName("");
      selectProfile(p.id);
    } catch (e) {
      setToast({ text: e.message.includes("duplicate") ? "A library with that name exists" : e.message, isError: true });
    }
  };

  const deleteActiveProfile = async () => {
    const fallback = profiles.find((p) => p.id !== activeId);
    await db.deleteProfile(activeId);
    const next = profiles.filter((p) => p.id !== activeId);
    setProfiles(next);
    setSettingsOpen(false);
    if (fallback) selectProfile(fallback.id);
  };

  // ---- filtering & sorting ----
  const genres = useMemo(
    () => ["all", ...new Set(books.map((b) => b.genre).filter(Boolean))].sort((a, b) => (a === "all" ? -1 : a.localeCompare(b))),
    [books]
  );

  // Distinct "recommended by" values across the library, for form typeahead.
  const recommenders = useMemo(
    () => [...new Set([...books, ...flattenBooks(books)].map((b) => b.recommended_by).filter(Boolean))].sort(),
    [books]
  );

  const shown = useMemo(() => {
    const statusOrder = { recommended: 0, wanttoread: 1, reading: 2, read: 3, dnf: 4 };
    const q = search.toLowerCase();
    const matches = (b) =>
      !q ||
      b.title?.toLowerCase().includes(q) ||
      b.author?.toLowerCase().includes(q) ||
      b.narrator?.toLowerCase().includes(q) ||
      (b.tags ?? []).some((t) => t.toLowerCase().includes(q));

    const filtered = books.filter((b) => {
      const st = getStatus(b);
      if (filter === "loved" && !b.loved) return false;
      if (filter === "read" && st !== "read") return false;
      if (filter === "reading" && st !== "reading") return false;
      if (filter === "want" && st !== "wanttoread") return false;
      if (filter === "recommended" && st !== "recommended") return false;
      if (filter === "dnf" && st !== "dnf") return false;
      if (genre !== "all" && b.genre !== genre) return false;
      if (minRating > 0 && calcSeriesRating(b) < minRating) return false;
      if (q && !matches(b) && !b.books?.some(matches)) return false;
      return true;
    });

    // Surface matching series members for listening/want filters.
    const extra = [];
    if (filter === "reading" || filter === "want") {
      const target = filter === "reading" ? "reading" : "wanttoread";
      for (const series of books) {
        if (!series.is_series) continue;
        for (const sb of series.books ?? []) {
          if (sb.status !== target) continue;
          if (genre !== "all" && sb.genre !== genre) continue;
          if (minRating > 0 && (Number(sb.rating) || 0) < minRating) continue;
          if (q && !matches(sb)) continue;
          extra.push({ ...sb, _parentSeries: series });
        }
      }
    }

    return [...filtered, ...extra].sort((a, b) => {
      const sa = statusOrder[getStatus(a)] ?? 2, sb = statusOrder[getStatus(b)] ?? 2;
      const ra = calcSeriesRating(a), rb = calcSeriesRating(b);
      switch (sortBy) {
        case "rating": return rb - ra || (a.title ?? "").localeCompare(b.title ?? "");
        case "title": return (a.title ?? "").localeCompare(b.title ?? "");
        case "author": return (a.author ?? "").localeCompare(b.author ?? "");
        case "recent": return new Date(b.created_at) - new Date(a.created_at);
        case "duration": return (b.duration_minutes ?? 0) - (a.duration_minutes ?? 0);
        case "status":
        default: return sa - sb || rb - ra;
      }
    });
  }, [books, filter, genre, search, minRating, sortBy]);

  const stats = useMemo(() => {
    const read = books.filter((b) => getStatus(b) === "read");
    return {
      read: read.length,
      loved: books.filter((b) => b.loved).length,
      reading: books.filter((b) => getStatus(b) === "reading").length,
      want: books.filter((b) => getStatus(b) === "wanttoread").length,
    };
  }, [books]);

  // ---- render helpers ----
  const openSeries = (id) => setSeriesOpen(id);
  const activeSeries = seriesOpen ? books.find((b) => b.id === seriesOpen) : null;

  const cardProps = (b) => ({
    book: b,
    onEdit: () => (b._parentSeries ? setSeriesOpen(b._parentSeries.id) : setForm({ book: b })),
    onDelete: () => removeBook(b),
    onOpen: b.is_series ? () => openSeries(b.id) : undefined,
    onQueueToggle: !b.is_series ? () => queueToggle(b) : undefined,
  });

  const tabBtn = (t, label) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
        tab === t ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
    </button>
  );

  if (profiles === null) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">Loading…</div>;
  }

  if (!profiles.length) {
    return (
      <CreateFirstLibrary
        onCreate={async (name, setBusy) => {
          setBusy(true);
          try {
            const p = await db.createProfile(name);
            setProfiles([p]);
            selectProfile(p.id);
          } catch (e) {
            setToast({ text: e.message, isError: true });
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="min-h-screen pb-16">
      {/* ---- top bar ---- */}
      <header className="sticky top-0 z-40 border-b border-zinc-300/90 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5">
          <Headphones className="h-5 w-5 text-accent-500" />
          {/* library switcher */}
          <div className="flex items-center gap-1">
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => p.id !== activeId && selectProfile(p.id)}
                className={`rounded-lg px-2.5 py-1 text-sm font-medium transition cursor-pointer ${
                  p.id === activeId
                    ? "bg-accent-100 text-accent-700 dark:bg-accent-700/20 dark:text-accent-400"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {p.name}
              </button>
            ))}
            {addingProfile ? (
              <span className="flex items-center gap-1">
                <input
                  autoFocus value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addProfile(); if (e.key === "Escape") { setAddingProfile(false); setNewProfileName(""); } }}
                  placeholder="Name…"
                  className="w-28 rounded-lg border border-zinc-300 px-2 py-1 text-sm outline-none focus:border-accent-500 dark:border-zinc-700 dark:bg-zinc-900"
                />
                <button onClick={addProfile} className="rounded-lg bg-accent-500 px-2 py-1 text-xs font-bold text-zinc-900 cursor-pointer">Add</button>
              </span>
            ) : (
              <button onClick={() => setAddingProfile(true)} className="rounded-lg border border-dashed border-zinc-300 px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400 hover:border-zinc-400 hover:text-zinc-600 dark:border-zinc-700 cursor-pointer">
                + new
              </button>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={async () => {
                const next = theme === "dark" ? "light" : "dark";
                setTheme(next);
                db.saveUserSettings(uid, { theme: next }).catch(() => {});
              }}
              className="rounded-lg p-2 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 cursor-pointer"
              title="Toggle theme"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button onClick={() => setSettingsOpen(true)} className="rounded-lg p-2 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 cursor-pointer" title="Settings">
              <SettingsIcon className="h-4 w-4" />
            </button>
            <button onClick={() => setForm({ book: null })} className={`${btnPrimary} !py-1.5`}><Plus className="h-4 w-4" /> Add</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-5">
        {/* heading + stats */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{activeProfile?.name}'s Library</h1>
            <div className="mt-1 flex gap-4 text-xs text-zinc-500 dark:text-zinc-400">
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.read}</strong> finished</span>
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.reading}</strong> listening</span>
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.want}</strong> wanted</span>
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.loved}</strong> loved</span>
            </div>
          </div>
          <nav className="flex gap-1">
            {tabBtn("library", "Library")}
            {tabBtn("stats", "Stats")}
            {tabBtn("recommend", "Recommend")}
            {account?.is_admin && tabBtn("admin", "Admin")}
          </nav>
        </div>

        {banner && (
          <div className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
            banner.isError
              ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400"
              : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-400"
          }`}>
            {banner.text}
          </div>
        )}

        {tab === "library" && (
          <>
            <UpNext queue={queue} onReorder={async (entries) => { await db.setQueuePositions(entries); refreshBooks(); }} onRemove={queueToggle} onStart={startListening} />

            {/* toolbar */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1">
                {FILTERS.map(([f, label]) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-md px-2 py-1 text-xs font-semibold transition cursor-pointer ${
                      filter === f ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <input
                  value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search title, author, narrator…"
                  className={`${inputCls} !w-56 !py-1.5`}
                />
                <select value={genre} onChange={(e) => setGenre(e.target.value)} className={`${inputCls} !w-auto !py-1.5`}>
                  {genres.map((g) => <option key={g} value={g}>{g === "all" ? "All genres" : g}</option>)}
                </select>
                <select value={minRating} onChange={(e) => setMinRating(Number(e.target.value))} className={`${inputCls} !w-auto !py-1.5`}>
                  <option value={0}>Any rating</option><option value={4.5}>4.5★+</option><option value={4}>4★+</option><option value={3}>3★+</option>
                </select>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={`${inputCls} !w-auto !py-1.5`}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}
                </select>
                {/* view toggle */}
                <div className="flex rounded-lg border border-zinc-300/90 p-0.5 dark:border-zinc-700">
                  {[["covers", Grid3x3], ["cards", LayoutGrid], ["list", List]].map(([v, Icon]) => (
                    <button
                      key={v}
                      onClick={() => { setView(v); db.saveUserSettings(uid, { settings: { view: v } }).catch(() => {}); }}
                      className={`rounded-md px-2 py-1 text-sm transition cursor-pointer ${view === v ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-600"}`}
                      title={v}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{shown.length} of {books.length} entries</div>

            {!booksReady ? (
              <div className="flex justify-center py-16"><Spinner className="h-6 w-6 text-zinc-300" /></div>
            ) : shown.length === 0 ? (
              <div className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400">
                {books.length === 0 ? (
                  <>Your library is empty — hit <strong>+ Add</strong> to get started.</>
                ) : search ? (
                  <>No results for “{search}” — try a different search.</>
                ) : (
                  {
                    recommended: "Recommended books appear here — the librarian adds fresh picks automatically, and the Recommend tab finds more on demand.",
                    loved: "Books you mark with a ❤ after finishing them appear here — your all-time favorites shelf.",
                    read: "Books you've finished appear here. Set a book's status to Read (and give it a rating) to build your history.",
                    reading: "Whatever you're listening to right now appears here — set a book to Listening, or press play on your Up Next queue.",
                    want: "Your listening wishlist appears here — mark books as Want to Listen, or add picks from the Recommend tab.",
                    dnf: "Books you set aside without finishing appear here, along with how far you got and why.",
                  }[filter] ?? "No books match the genre or rating filters — try widening them."
                )}
              </div>
            ) : view === "covers" ? (
              <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7">
                {shown.map((b) => <BookCoverTile key={b.id} {...cardProps(b)} />)}
              </div>
            ) : view === "list" ? (
              <div className="rounded-xl border border-zinc-300/90 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                {shown.map((b) => <BookListRow key={b.id} {...cardProps(b)} />)}
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((b) => <BookCardGrid key={b.id} {...cardProps(b)} />)}
              </div>
            )}
          </>
        )}

        {tab === "stats" && (
          <Stats
            books={books}
            goals={goals}
            onSetGoal={async (year, type, target) => {
              await db.setGoal(activeId, year, type, target);
              setGoals(await db.listGoals(activeId));
            }}
          />
        )}

        {tab === "recommend" && activeProfile && (
          <Recommend
            books={books}
            profileName={activeProfile.name}
            ageGroup={activeProfile.age_group}
            model={appSettings.default_model}
            onAdd={async (fields) => { await db.createBook({ ...fields, profile_id: activeId }); refreshBooks(); }}
            onToast={setToast}
          />
        )}

        {tab === "admin" && account?.is_admin && (
          <Admin appSettings={appSettings} onSettingsChange={setAppSettings} onToast={setToast} />
        )}
      </main>

      {/* ---- dialogs ---- */}
      {form && (
        <BookForm
          book={form.book}
          recommenders={recommenders}
          seriesList={books.filter((b) => b.is_series)}
          onSave={saveBook}
          onSaveSeries={saveSeries}
          onClose={() => setForm(null)}
          onToast={setToast}
        />
      )}

      {activeSeries && (
        <SeriesModal
          series={activeSeries}
          recommenders={recommenders}
          onClose={() => setSeriesOpen(null)}
          onEditHeader={() => { setForm({ book: activeSeries }); setSeriesOpen(null); }}
          onSaveSub={async (id, fields) => {
            if (id) await db.updateBook(id, withAutoDates(fields));
            else await db.createBook({
              ...withAutoDates(fields), profile_id: activeId, parent_id: activeSeries.id,
              series_position: (activeSeries.books?.length ?? 0) + 1,
            });
            await refreshBooks();
          }}
          onDeleteSub={async (id) => { await db.deleteBook(id); refreshBooks(); }}
          onAddVolumes={async (volumes) => {
            await db.createBooks(volumes.map((v) => ({ ...v, profile_id: activeId, parent_id: activeSeries.id })));
            await refreshBooks();
          }}
          onToast={setToast}
        />
      )}

      {settingsOpen && activeProfile && (
        <Settings
          profile={activeProfile}
          profiles={profiles}
          books={books}
          session={session}
          onSelectProfile={selectProfile}
          onRenameProfile={async (name) => {
            const p = await db.updateProfile(activeId, { name });
            setProfiles(profiles.map((x) => (x.id === activeId ? p : x)));
            setToast({ text: "Renamed" });
          }}
          onAgeGroupChange={async (age_group) => {
            const p = await db.updateProfile(activeId, { age_group });
            setProfiles(profiles.map((x) => (x.id === activeId ? p : x)));
          }}
          onDeleteProfile={deleteActiveProfile}
          onImportBooks={importBooks}
          onClose={() => setSettingsOpen(false)}
          onSignOut={onSignOut}
          onToast={setToast}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}

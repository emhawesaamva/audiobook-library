// App shell: top bar (libraries, search, view toggle, theme, settings),
// tabs (Library / Stats / Recommend / Admin), and all data orchestration.
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import * as db from "./lib/db.js";
import { fetchRecommendations } from "./lib/ai.js";
import { searchBooks as metaSearch, resultToBook, libbyAvailability } from "./lib/metadata.js";
import { getStatus, calcSeriesRating, flattenBooks, sameTitle, hasHold } from "./lib/bookUtils.js";
import { booksNeedingLibbyCheck, toLibbyState } from "./lib/libbyStatus.js";
import { BookCardGrid, BookCoverTile, BookListRow } from "./components/BookCard.jsx";
import BookForm from "./components/BookForm.jsx";
import SeriesModal from "./components/SeriesModal.jsx";
import Recommend from "./components/Recommend.jsx";
import Stats from "./components/Stats.jsx";
import Holds from "./components/Holds.jsx";
import HoldModal from "./components/HoldModal.jsx";
import Settings from "./components/Settings.jsx";
import Admin from "./components/Admin.jsx";
import UpNext from "./components/UpNext.jsx";
import AudiblePromo from "./components/AudiblePromo.jsx";
import OnboardingWizard from "./components/OnboardingWizard.jsx";
import ContactModal from "./components/ContactModal.jsx";
import { Toast, Spinner, btnPrimary, btnSecondary, inputCls, selectCls, selectArrowStyle, labelCls } from "./components/shared.jsx";
import { Headphones, Sun, Moon, Settings as SettingsIcon, HelpCircle, Plus, Grid3x3, LayoutGrid, List, LibraryBig, ALargeSmall, TrendingUp, Share2, Copy, Check, X, Sparkles } from "lucide-react";

// Local calendar date, not UTC — toISOString() rolls over to tomorrow's date in
// the evening for anyone west of Greenwich, which throws off every consumer
// that treats the string as local midnight (holdWeeksLeft, date_started, etc).
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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

// Toolbar icon button whose label slides out on hover, widening the button
// (neighbors shift naturally in the flex row) — replaces title tooltips.
function ToolbarButton({ icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="group flex cursor-pointer items-center rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      {icon}
      <span className="max-w-0 overflow-hidden whitespace-nowrap text-sm font-medium transition-[max-width,margin] duration-300 ease-out group-hover:ml-1.5 group-hover:max-w-[8rem]">
        {label}
      </span>
    </button>
  );
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
  ["all", "All"], ["recommended", "Recommended"], ["loved", "Loved"],
  ["read", "Read"], ["reading", "Listening"], ["want", "Want"], ["dnf", "DNF"],
  ["crowd", "Crowd 4.5+"],
];

const SORTS = [
  ["status", "Status"], ["rating", "Rating"], ["crowd", "Crowd rating"],
  ["recent", "Recently added"], ["title", "Title A–Z"], ["author", "Author A–Z"],
  ["duration", "Length"],
];

// Best public rating attached to an entry (series use their best volume).
const crowdRating = (b) =>
  Math.max(
    Number(b.goodreads_rating) || 0,
    ...(b.books ?? []).map((c) => Number(c.goodreads_rating) || 0)
  );

// Sorting by anything other than status/rating orders books by a value that
// isn't otherwise visible on the card (crowd rating, date added, first
// letter, length) — so those sorts get section headings to surface it.
// Bucketing must stay monotonic with each comparator in `shown` below so
// same-bucket entries land adjacently and headings never repeat.
function sortGroupLabel(sortBy, b) {
  switch (sortBy) {
    case "crowd": {
      const r = crowdRating(b);
      if (!(r > 0)) return "Crowd: unrated";
      return `Crowd: ${(Math.round(r * 2) / 2).toFixed(1).replace(/\.0$/, "")}`;
    }
    case "title": {
      const c = (b.title ?? "").trim()[0]?.toUpperCase() ?? "";
      return `Title: ${/[A-Z]/.test(c) ? c : "#"}`;
    }
    case "author": {
      const c = (b.author ?? "").trim()[0]?.toUpperCase() ?? "";
      return `Author: ${/[A-Z]/.test(c) ? c : "#"}`;
    }
    case "recent": {
      if (!b.created_at) return "Added: unknown";
      return `Added: ${new Date(b.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })}`;
    }
    case "duration": {
      if (b.is_series) return "Length: series";
      const m = b.duration_minutes;
      if (!m) return "Length: unknown";
      const h = Math.floor(m / 60);
      if (h < 5) return "Length: under 5h";
      if (h < 10) return "Length: 5–10h";
      if (h < 15) return "Length: 10–15h";
      if (h < 20) return "Length: 15–20h";
      return "Length: 20h+";
    }
    default: // status, rating — already visible on every card, no heading
      return null;
  }
}

function GroupHeading({ label, grid = false }) {
  return (
    <div
      className={`${grid ? "col-span-full mb-1.5 mt-5 px-0.5 first:mt-0" : "border-b border-zinc-100 bg-zinc-50/70 px-3 py-1.5 dark:border-zinc-800/60 dark:bg-zinc-900/40"} text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500`}
    >
      {label}
    </div>
  );
}

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
  const [hold, setHold] = useState(null);          // {book, editing} | null
  const [seriesOpen, setSeriesOpen] = useState(null); // series id | null
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [onboarding, setOnboarding] = useState(false); // welcome framing in settings after creating a library
  const [addingProfile, setAddingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("lib_theme") ?? "light");
  const [size, setSize] = useState(localStorage.getItem("lib_size") ?? "large");
  const [prefs, setPrefs] = useState({}); // user_settings.settings jsonb (view, libby_key, size, …)

  const savePrefs = (patch) => {
    setPrefs((p) => {
      const merged = { ...p, ...patch };
      db.saveUserSettings(uid, { settings: merged }).catch(() => {});
      return merged;
    });
  };

  // Audible upsell after adding/wanting a book. Hidden for self-identified
  // subscribers (Settings toggle or the modal's "Already a subscriber"), and
  // throttled to at most once per calendar day per device.
  const [audiblePromo, setAudiblePromo] = useState(null); // book | null
  const maybePromoteAudible = (book) => {
    if (!book || prefs.audible_subscriber) return;
    if (localStorage.getItem("audible_promo_day") === today()) return;
    localStorage.setItem("audible_promo_day", today());
    setAudiblePromo(book);
  };
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
  useEffect(() => {
    document.documentElement.classList.toggle("size-large", size === "large");
  }, [size]);
  useEffect(() => { localStorage.setItem("lib_view", view); }, [view]);

  // ---- initial load ----
  useEffect(() => {
    (async () => {
      try {
        const [acct, profs, settings, app] = await Promise.all([
          db.getAccount(uid),
          db.listProfiles(uid),
          db.getUserSettings(uid),
          db.getAppSettings(),
        ]);
        setAccount(acct);
        setAppSettings(app);
        if (settings.theme) setTheme(settings.theme);
        if (settings.settings?.view) setView(settings.settings.view);
        if (settings.settings?.size) {
          setSize(settings.settings.size);
          localStorage.setItem("lib_size", settings.settings.size);
        }
        setPrefs(settings.settings ?? {});
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
    if (activeProfile) document.title = `${activeProfile.name} · AudioLib.io`;
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
          const excludeTitles = [
            ...current.map((b) => b.title),
            ...flattenBooks(current).map((b) => b.title),
            ...rejected,
          ];
          const isExcluded = (title) => excludeTitles.some((t) => sameTitle(t, title));
          const lovedAuthors = [...new Set(current.filter((b) => b.loved || Number(b.rating) >= 5).map((b) => b.author).filter(Boolean))];
          // Cold start (empty library): no assumptions about taste — pull
          // highly rated crowd-pleasers, each from a different genre, with
          // some randomness so every new library starts differently.
          const isEmpty = books.length === 0;
          const recGenres = current.filter((b) => b.status === "recommended").map((b) => b.genre).filter(Boolean);
          const query = isEmpty
            ? `This library is brand new and completely empty — assume NOTHING about taste. Recommend one broadly beloved, very highly rated audiobook. Be a little random and surprising in your pick rather than defaulting to the single most famous option.${recGenres.length ? ` It must be from a COMPLETELY different genre than: ${recGenres.join(", ")}.` : ""} Do not suggest: ${excludeTitles.join(", ") || "none"}.`
            : `Find me an audiobook ${lovedAuthors.length ? `similar to books by these loved authors: ${lovedAuthors.join(", ")}` : "that is highly rated and popular"}. Already in my library — do not suggest these: ${excludeTitles.join(", ") || "none"}. Return one well-known match.`;
          let rec = null;
          try {
            const result = await fetchRecommendations({
              books: current, profileName: name, ageGroup: age_group, query,
              model: appSettings.default_model, maxTokens: 2000,
            });
            rec = result.recommendations.find((r) => !isExcluded(r.title)) ?? null;
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
            status: "recommended", recommended_by: "AudioLib",
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

  // ---- Libby availability refresh ----
  // Recommended / Want books carry a cached availability state so cards render
  // instantly from the library load. Anything older than a day is refreshed in
  // the background, a few at a time — this hits an undocumented OverDrive
  // endpoint, so it stays deliberately unhurried and capped per visit.
  const libbyChecked = useRef(new Set());
  useEffect(() => {
    const key = prefs.libby_key;
    if (!booksReady || !activeId || !key) return;
    const mark = `${activeId}:${key}`;
    if (libbyChecked.current.has(mark)) return;
    libbyChecked.current.add(mark);

    const due = booksNeedingLibbyCheck(books, { limit: 40 });
    if (!due.length) return;

    const profileId = activeId;
    (async () => {
      const CONCURRENCY = 3;
      let cursor = 0;
      let changed = false;
      const worker = async () => {
        while (cursor < due.length) {
          const book = due[cursor++];
          if (activeIdRef.current !== profileId) return;
          let patch;
          try {
            patch = toLibbyState(await libbyAvailability(key, book.title, book.author));
          } catch {
            continue; // transient; try again next visit rather than caching a lie
          }
          try {
            await db.updateBook(book.id, { ...patch, libby_checked_at: new Date().toISOString() });
            changed = true;
          } catch { /* not worth surfacing — the badge just stays stale */ }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (changed && activeIdRef.current === profileId) await refreshBooks(profileId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booksReady, activeId, prefs.libby_key]);

  // ---- mutations ----
  const saveBook = async (fields, { targetSeriesId } = {}) => {
    const isNew = !fields.id;
    let created = null;
    if (fields.id) {
      const prev = books.flatMap((b) => (b.is_series ? [b, ...(b.books ?? [])] : [b])).find((b) => b.id === fields.id);
      await db.updateBook(fields.id, withAutoDates(fields, prev));
    } else if (targetSeriesId) {
      const series = books.find((b) => b.id === targetSeriesId);
      created = await db.createBook({
        ...withAutoDates(fields), profile_id: activeId, parent_id: targetSeriesId,
        series_position: (series?.books?.length ?? 0) + 1,
      });
    } else {
      created = await db.createBook({ ...withAutoDates(fields), profile_id: activeId });
    }
    await refreshBooks();
    if (isNew && !fields.is_series) maybePromoteAudible(fields);
    // Manually creating a new (empty) series: close the form and jump
    // straight into it, same as the "add entire series" flow below.
    if (isNew && fields.is_series && created) {
      setForm(null);
      setSeriesOpen(created.id);
    }
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

  // Apply smart-merge patches from a library update (re-import). Each entry is
  // { id, patch } produced by diffImport/mergeBook; refresh once at the end.
  const updateBooks = async (updates) => {
    for (const u of updates) await db.updateBook(u.id, u.patch);
    await refreshBooks();
  };

  const saveSeries = async (header, volumes) => {
    const parent = await db.createBook({ ...header, profile_id: activeId, is_series: true });
    if (volumes.length) {
      await db.createBooks(volumes.map((v) => ({ ...v, profile_id: activeId, parent_id: parent.id })));
    }
    await refreshBooks();
    setForm(null);
    setSeriesOpen(parent.id);
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

  // Deleting the series header cascades (books.parent_id is ON DELETE
  // CASCADE), so every volume in it goes too — SeriesModal warns first.
  const removeSeries = guard(async (series) => {
    await db.deleteBook(series.id);
    await refreshBooks();
    setSeriesOpen(null);
    setToast({ text: `Deleted "${series.title}" and its books` });
  });

  // ---- up-next queue ----
  const queue = useMemo(() => {
    const all = books.flatMap((b) => (b.is_series ? (b.books ?? []) : [b]));
    return all.filter((b) => b.queue_position != null).sort((a, b) => a.queue_position - b.queue_position);
  }, [books]);

  // Crowd-favorite nudge when the queue is empty: best publicly rated
  // Want-to-Listen book.
  const crowdPick = useMemo(() => {
    const candidates = flattenBooks(books).filter(
      (b) => b.status === "wanttoread" && Number(b.goodreads_rating) >= 4
    );
    if (!candidates.length) return null;
    return candidates.reduce((a, b) =>
      Number(b.goodreads_rating) > Number(a.goodreads_rating) ? b : a
    );
  }, [books]);

  const queueToggle = guard(async (book) => {
    const queued = book.queue_position != null;
    await db.updateBook(book.id, {
      queue_position: queued ? null : (queue[queue.length - 1]?.queue_position ?? 0) + 1,
    });
    await refreshBooks();
    setToast({ text: queued ? "Removed from Up Next" : "Added to Up Next" });
  });

  // ---- library holds ----
  // A hold is an indicator, not a status. The one status side effect: a book
  // you went and placed a hold on is plainly no longer just "recommended".
  const saveHold = guard(async (book, weeks) => {
    const stamp = { hold_weeks: weeks, hold_date: today() };
    if (book.id) {
      const patch = { ...stamp };
      if (book.status === "recommended") patch.status = "wanttoread";
      await db.updateBook(book.id, patch);
    } else {
      // Straight from the Recommend tab: the book isn't in the library yet, so
      // the hold is what files it. Enrich first — a cover and duration matter
      // on a shelf you'll be staring at for the next several weeks.
      let enriched = {};
      try {
        const { results } = await metaSearch(`${book.title} ${book.author ?? ""}`, 3);
        if (results[0]) enriched = resultToBook(results[0]);
      } catch { /* metadata is best-effort */ }
      await db.createBook({
        profile_id: activeId,
        author: book.author,
        genre: book.genre || "Science Fiction",
        subgenre: book.subgenre || "",
        recommended_by: "AudioLib",
        year: book.year ? Number(book.year) : null,
        ...enriched,
        title: enriched.title || book.title,
        status: "wanttoread",
        ...stamp,
      });
    }
    await refreshBooks();
    setHold(null);
    setToast({ text: `Hold saved — about ${weeks} week${weeks === 1 ? "" : "s"}` });
  });

  const clearHold = guard(async (book) => {
    await db.updateBook(book.id, { hold_weeks: null, hold_date: null });
    await refreshBooks();
    setHold(null);
    setToast({ text: "Hold cleared" });
  });

  // Raised when a Libby link is opened for a book that isn't borrowed yet.
  // Already holding it? Go straight to the editor rather than re-asking.
  // `suggestWeeks` carries Libby's own reported wait from the Recommend tab.
  const promptHold = (book, suggestWeeks = null) =>
    setHold({ book, editing: hasHold(book), suggestWeeks });

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
      setOnboarding(true);
      setSettingsOpen(true);
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
  // Filter dropdown only offers genres actually present in this library
  // (including inside series) — never the full master list. "All genres"
  // is prepended after sorting so it is always first.
  const genres = useMemo(
    () => ["all", ...[...new Set([...books, ...flattenBooks(books)].map((b) => b.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b))],
    [books]
  );

  // Distinct "recommended by" values across the library, for form typeahead.
  const recommenders = useMemo(
    () => [...new Set([...books, ...flattenBooks(books)].map((b) => b.recommended_by).filter(Boolean))].sort(),
    [books]
  );

  // Distinct tags across the library, for the tag-chip suggestions.
  const allTags = useMemo(
    () => [...new Set([...books, ...flattenBooks(books)].flatMap((b) => b.tags ?? []))].sort(),
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
      if (filter === "crowd" && crowdRating(b) < 4.5) return false;
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
        case "crowd": return crowdRating(b) - crowdRating(a) || (a.title ?? "").localeCompare(b.title ?? "");
        case "title": return (a.title ?? "").localeCompare(b.title ?? "");
        case "author": return (a.author ?? "").localeCompare(b.author ?? "");
        case "recent": return new Date(b.created_at) - new Date(a.created_at);
        case "duration": return (b.duration_minutes ?? 0) - (a.duration_minutes ?? 0);
        case "status":
        default: return sa - sb || rb - ra;
      }
    });
  }, [books, filter, genre, search, minRating, sortBy]);

  // ---- infinite scroll ----
  const PAGE_SIZE = 40;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef(null);
  // Reset to first page whenever the filtered set changes.
  useEffect(() => setVisibleCount(PAGE_SIZE), [filter, genre, search, minRating, sortBy, activeId]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisibleCount((n) => n + PAGE_SIZE); },
      { rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  });
  const page = useMemo(() => shown.slice(0, visibleCount), [shown, visibleCount]);

  // Interleave section headings into the page whenever the active sort
  // exposes info not otherwise shown on the card (see sortGroupLabel).
  const pageRows = useMemo(() => {
    let prevLabel;
    const rows = [];
    for (const b of page) {
      const label = sortGroupLabel(sortBy, b);
      if (label != null && label !== prevLabel) {
        rows.push({ type: "heading", label, key: `h-${rows.length}-${label}` });
        prevLabel = label;
      }
      rows.push({ type: "book", book: b });
    }
    return rows;
  }, [page, sortBy]);

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
    libbyKey: prefs.libby_key,
    affiliateTag: appSettings.affiliate_tag || null,
    onEdit: () => (b._parentSeries ? setSeriesOpen(b._parentSeries.id) : setForm({ book: b })),
    onDelete: () => removeBook(b),
    onOpen: b.is_series ? () => openSeries(b.id) : undefined,
    onQueueToggle: !b.is_series ? () => queueToggle(b) : undefined,
    onLibbyHold: !b.is_series ? promptHold : undefined,
  });

  // A fresh library holds only the two auto-recommended starter titles — show
  // an explainer card alongside them until the user adds a book of their own.
  const showRecExplainer = books.length === 2 && books.every((b) => getStatus(b) === "recommended");

  // Underline tabs: the row sits on a shared baseline and the active tab's
  // marker sits *on* that line (-mb-px), so the selected tab reads as connected
  // to the panel below rather than as one more button in a row of buttons.
  const tabBtn = (t, label) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      aria-current={tab === t ? "page" : undefined}
      className={`relative -mb-px shrink-0 whitespace-nowrap rounded-t-lg border-b-2 px-3.5 py-2 text-sm transition cursor-pointer ${
        tab === t
          ? "border-accent-500 bg-accent-50 font-semibold text-zinc-900 dark:bg-accent-700/15 dark:text-white"
          // hover:bg must differ from the page itself — body is bg-zinc-100 in
          // light mode, so hovering used to paint the tab the same colour as its
          // background and read as nothing happening.
          : "border-transparent font-medium text-zinc-500 hover:border-zinc-300 hover:bg-zinc-200 hover:text-zinc-800 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
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
            setOnboarding(true);
            setSettingsOpen(true);
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
          {/* library switcher — tabs extend down to the header's bottom border:
              extra bottom padding plus a negative margin canceling the header's py-2.5 */}
          <div className="flex flex-wrap items-center gap-1">
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => p.id !== activeId && selectProfile(p.id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition cursor-pointer ${
                  p.id === activeId
                    ? "bg-accent-500 text-zinc-900"
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

          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <ToolbarButton
              label={theme === "dark" ? "Light mode" : "Dark mode"}
              icon={theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                setTheme(next);
                db.saveUserSettings(uid, { theme: next }).catch(() => {});
              }}
            />
            <ToolbarButton
              label="Share library"
              icon={<Share2 className="h-4 w-4 shrink-0" />}
              onClick={() => setShareOpen(true)}
            />
            {/* Larger/Compact toggle is a no-op below 640px (size-large only
                scales at >=640px), so it's hidden on mobile. */}
            <span className="hidden sm:inline-flex">
              <ToolbarButton
                label={size === "large" ? "Compact view" : "Larger view"}
                icon={<ALargeSmall className="h-[19px] w-[19px] shrink-0" />}
                onClick={() => {
                  const next = size === "large" ? "compact" : "large";
                  setSize(next);
                  localStorage.setItem("lib_size", next);
                  savePrefs({ size: next });
                }}
              />
            </span>
            <ToolbarButton
              label="Contact us"
              icon={<HelpCircle className="h-4 w-4 shrink-0" />}
              onClick={() => setContactOpen(true)}
            />
            <ToolbarButton
              label="Settings"
              icon={<SettingsIcon className="h-4 w-4 shrink-0" />}
              onClick={() => setSettingsOpen(true)}
            />
            <button onClick={() => setForm({ book: null })} className={`${btnPrimary} !py-1.5`}><Plus className="h-4 w-4" /> Add</button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-5">
        {/* heading + stats */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{activeProfile?.name}</h1>
            <div className="mt-1 flex gap-4 text-xs text-zinc-500 dark:text-zinc-400">
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.read}</strong> finished</span>
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.reading}</strong> listening</span>
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.want}</strong> wanted</span>
              <span><strong className="text-zinc-600 dark:text-zinc-300">{stats.loved}</strong> loved</span>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
            {tabBtn("library", "Library")}
            {tabBtn("recommend", "Recommend")}
            {tabBtn("holds", "Libby Holds")}
            {tabBtn("stats", "Stats")}
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

        {account?.is_admin && appSettings?.ai_credit_exhausted && (
          <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400">
            <span>
              Anthropic API credit is exhausted — AI features are running on the Gemini Flash
              fallback. Add credits in the Anthropic console to restore Claude.
            </span>
            <button
              onClick={async () => {
                try {
                  await db.setAppSetting("ai_credit_exhausted", null);
                  setAppSettings({ ...appSettings, ai_credit_exhausted: null });
                } catch (e) {
                  setToast({ text: e.message, isError: true });
                }
              }}
              className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {tab === "library" && (
          <>
            <UpNext queue={queue} onReorder={async (entries) => { await db.setQueuePositions(entries); refreshBooks(); }} onRemove={queueToggle} onStart={startListening} />
            {queue.length === 0 && crowdPick && (
              <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-accent-200/70 bg-accent-50/50 px-3 py-2.5 text-sm dark:border-accent-700/30 dark:bg-accent-700/5">
                <span className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 shrink-0 text-accent-600" />
                  Your queue is empty — the crowd says start with{" "}
                  <strong>{crowdPick.title}</strong> ({Number(crowdPick.goodreads_rating)}★)
                </span>
                <button onClick={() => queueToggle(crowdPick)} className="ml-auto shrink-0 rounded-md bg-accent-500 px-2.5 py-1 text-xs font-bold text-zinc-900 hover:bg-accent-400 cursor-pointer">
                  Add to Up Next
                </button>
              </div>
            )}

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
                <div className="relative">
                  <input
                    value={search} onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search title, author, narrator…"
                    className={`${inputCls} !w-56 !py-1.5 ${search ? "!pr-7" : ""}`}
                  />
                  {search && (
                    <button
                      onClick={() => setSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <select value={genre} onChange={(e) => setGenre(e.target.value)} className={`${selectCls} !w-auto !py-1.5`} style={selectArrowStyle}>
                  {genres.map((g) => <option key={g} value={g}>{g === "all" ? "All genres" : g}</option>)}
                </select>
                <select value={minRating} onChange={(e) => setMinRating(Number(e.target.value))} className={`${selectCls} !w-auto !py-1.5`} style={selectArrowStyle}>
                  <option value={0}>Any rating</option><option value={4.5}>4.5★+</option><option value={4}>4★+</option><option value={3}>3★+</option>
                </select>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className={`${selectCls} !w-auto !py-1.5`} style={selectArrowStyle}>
                  {SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}
                </select>
                {(filter !== "all" || genre !== "all" || minRating !== 0 || sortBy !== "status" || search) && (
                  <button
                    onClick={() => { setFilter("all"); setGenre("all"); setMinRating(0); setSortBy("status"); setSearch(""); }}
                    className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    Clear filters
                  </button>
                )}
                {/* view toggle */}
                <div className="flex rounded-lg border border-zinc-300/90 p-0.5 dark:border-zinc-700">
                  {[["covers", Grid3x3], ["cards", LayoutGrid], ["list", List]].map(([v, Icon]) => (
                    <button
                      key={v}
                      onClick={() => { setView(v); savePrefs({ view: v }); }}
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
                    crowd: "No books in your library have crowd ratings of 4.5★ or higher yet. Books added via the search autofill include public ratings automatically — or run the metadata refresh script to backfill your existing library.",
                  }[filter] ?? "No books match the genre or rating filters — try widening them."
                )}
              </div>
            ) : view === "covers" ? (
              <>
                <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7">
                  {pageRows.map((row) =>
                    row.type === "heading"
                      ? <GroupHeading key={row.key} label={row.label} grid />
                      : <BookCoverTile key={row.book.id} {...cardProps(row.book)} />
                  )}
                  {showRecExplainer && <RecExplainerCard view="covers" />}
                </div>
                <div ref={sentinelRef} />
              </>
            ) : view === "list" ? (
              <>
                <div className="rounded-xl border border-zinc-300/90 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                  {pageRows.map((row) =>
                    row.type === "heading"
                      ? <GroupHeading key={row.key} label={row.label} />
                      : <BookListRow key={row.book.id} {...cardProps(row.book)} />
                  )}
                  {showRecExplainer && <RecExplainerCard view="list" />}
                </div>
                <div ref={sentinelRef} />
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {pageRows.map((row) =>
                    row.type === "heading"
                      ? <GroupHeading key={row.key} label={row.label} grid />
                      : <BookCardGrid key={row.book.id} {...cardProps(row.book)} />
                  )}
                  {showRecExplainer && <RecExplainerCard view="cards" />}
                </div>
                <div ref={sentinelRef} />
              </>
            )}
          </>
        )}

        {tab === "holds" && (
          <Holds
            books={books}
            libbyKey={prefs.libby_key}
            onEditHold={(book) => setHold({ book, editing: true })}
          />
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
            libbyKey={prefs.libby_key}
            affiliateTag={appSettings.affiliate_tag || null}
            onLibbyKeyChange={(k) => savePrefs({ libby_key: k })}
            onLibbyHold={promptHold}
            onAdd={async (fields) => { await db.createBook({ ...fields, profile_id: activeId }); refreshBooks(); maybePromoteAudible(fields); }}
            onToast={setToast}
          />
        )}

        {tab === "admin" && account?.is_admin && (
          <Admin appSettings={appSettings} onSettingsChange={setAppSettings} onToast={setToast} />
        )}
      </main>

      {appSettings.affiliate_tag && (
        <footer className="mt-8 pb-6 text-center text-xs text-zinc-400 dark:text-zinc-600 px-4">
          As an Amazon Associate, AudioLib.io earns from qualifying purchases.
        </footer>
      )}

      {/* ---- dialogs ---- */}
      {form && (
        <BookForm
          book={form.book}
          recommenders={recommenders}
          allTags={allTags}
          seriesList={books.filter((b) => b.is_series)}
          onSave={saveBook}
          onSaveSeries={saveSeries}
          onClose={() => setForm(null)}
          onToast={setToast}
        />
      )}

      {hold && (
        <HoldModal
          book={hold.book}
          editing={hold.editing}
          suggestWeeks={hold.suggestWeeks}
          willAdd={!hold.book.id}
          libbyKey={prefs.libby_key}
          onSave={(weeks) => saveHold(hold.book, weeks)}
          onClear={() => clearHold(hold.book)}
          onClose={() => setHold(null)}
        />
      )}

      {activeSeries && (
        <SeriesModal
          series={activeSeries}
          recommenders={recommenders}
          allTags={allTags}
          libbyKey={prefs.libby_key}
          onLibbyHold={promptHold}
          affiliateTag={appSettings.affiliate_tag || null}
          onClose={() => setSeriesOpen(null)}
          onEditHeader={() => { setForm({ book: activeSeries }); setSeriesOpen(null); }}
          onDeleteSeries={() => removeSeries(activeSeries)}
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

      {onboarding && activeProfile && (
        <OnboardingWizard
          profile={activeProfile}
          books={books}
          onRename={async (name) => {
            const p = await db.updateProfile(activeId, { name });
            setProfiles(profiles.map((x) => (x.id === activeId ? p : x)));
          }}
          onAgeGroupChange={async (age_group) => {
            const p = await db.updateProfile(activeId, { age_group });
            setProfiles(profiles.map((x) => (x.id === activeId ? p : x)));
          }}
          onImportBooks={importBooks}
          onUpdateBooks={updateBooks}
          onToast={setToast}
          onClose={() => { setOnboarding(false); setSettingsOpen(false); refreshBooks(); }}
        />
      )}

      {settingsOpen && !onboarding && activeProfile && (
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
          onUpdateBooks={updateBooks}
          onRefreshDone={refreshBooks}
          libbyKey={prefs.libby_key ?? ""}
          onLibbyKeyChange={(k) => savePrefs({ libby_key: k })}
          audibleSubscriber={!!prefs.audible_subscriber}
          onAudibleSubscriberChange={(v) => savePrefs({ audible_subscriber: v })}
          onClose={() => { setSettingsOpen(false); setOnboarding(false); }}
          onSignOut={onSignOut}
          onToast={setToast}
        />
      )}

      {contactOpen && (
        <ContactModal
          email={session.user.email}
          onClose={() => setContactOpen(false)}
          onToast={setToast}
        />
      )}

      {shareOpen && activeId && (
        <ShareModal
          profile={activeProfile}
          profileId={activeId}
          copied={shareCopied}
          onCopy={() => {
            navigator.clipboard.writeText(`${window.location.origin}/share/${activeId}`);
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 2000);
          }}
          onClose={() => setShareOpen(false)}
        />
      )}

      {/* Rendered last so it stacks on top of any open dialog (e.g. the add form). */}
      {audiblePromo && (
        <AudiblePromo
          book={audiblePromo}
          affiliateTag={appSettings.affiliate_tag || null}
          onSubscriber={() => { savePrefs({ audible_subscriber: true }); setAudiblePromo(null); }}
          onClose={() => setAudiblePromo(null)}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}

// Shown only when a library holds nothing but its two auto-recommended starter
// titles, explaining where those came from. Adapts to the active library view.
function RecExplainerCard({ view }) {
  const accent = "border-dashed border-accent-300 bg-accent-50/60 text-zinc-600 dark:border-accent-700/40 dark:bg-accent-700/5 dark:text-zinc-300";
  if (view === "list") {
    return (
      <div className={`flex items-center gap-2.5 border-t px-3 py-3 text-sm ${accent}`}>
        <Sparkles className="h-4 w-4 shrink-0 text-accent-600" />
        <span>These two popular titles were recommended for you by AudioLib to get you started — add a book of your own and your recommendations start matching your taste.</span>
      </div>
    );
  }
  if (view === "covers") {
    return (
      <div className={`flex aspect-[1/1.5] flex-col items-center justify-center rounded-lg border p-3 text-center ${accent}`}>
        <Sparkles className="mb-2 h-5 w-5 text-accent-600" />
        <p className="text-[11px] font-medium leading-snug">Two popular titles recommended for you by AudioLib to get you started</p>
      </div>
    );
  }
  // cards
  return (
    <div className={`flex items-center gap-3 rounded-xl border p-4 ${accent}`}>
      <Sparkles className="h-6 w-6 shrink-0 text-accent-600" />
      <p className="text-sm leading-snug">These two popular titles were recommended for you by AudioLib to get you started. Add a book of your own and your recommendations start matching your taste.</p>
    </div>
  );
}

function ShareModal({ profile, profileId, copied, onCopy, onClose }) {
  const url = `${window.location.origin}/share/${profileId}`;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-300/90 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold">Share "{profile?.name}"</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 cursor-pointer">✕</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Anyone with this link can browse this library and stats in read-only mode. Signed-in visitors can add books to their own library.
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-zinc-300/90 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900/60">
            <span className="flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">{url}</span>
            <button
              onClick={onCopy}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300/90 bg-white px-2.5 py-1.5 text-xs font-medium transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 cursor-pointer"
            >
              {copied ? <><Check className="h-3.5 w-3.5 text-emerald-500" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <a
              href={`/share/${profileId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-accent-600 hover:text-accent-700"
            >
              Preview →
            </a>
            <button onClick={onClose} className="rounded-lg border border-zinc-300/90 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800 cursor-pointer">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

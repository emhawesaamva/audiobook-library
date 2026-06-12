// Stats & goals tab: listening hours, yearly goals with progress, top
// authors/narrators/genres, rating distribution, superlatives, year selector.
import { useMemo, useState } from "react";
import { flattenBooks, fmtDuration } from "../lib/bookUtils.js";
import { inputCls, labelCls } from "./shared.jsx";
import { Ruler, Repeat, Ban, Users, Flame } from "lucide-react";

function StatCard({ value, label, sub }) {
  return (
    <div className="rounded-xl border border-zinc-300/90 bg-white p-4 text-center dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

function TopList({ title, items }) {
  if (!items.length) return null;
  const max = items[0][1];
  return (
    <div className="rounded-xl border border-zinc-300/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{title}</div>
      <div className="space-y-2">
        {items.map(([name, count]) => (
          <div key={name} className="flex items-center gap-2 text-sm">
            <span className="w-36 truncate shrink-0">{name}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full rounded-full bg-accent-500" style={{ width: `${(count / max) * 100}%` }} />
            </div>
            <span className="w-6 text-right text-xs text-zinc-500 dark:text-zinc-400">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GoalRing({ label, current, target, unit }) {
  const pct = Math.min(100, Math.round((current / target) * 100));
  const r = 34, c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4 rounded-xl border border-zinc-300/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90 shrink-0">
        <circle cx="42" cy="42" r={r} fill="none" strokeWidth="8" className="stroke-zinc-100 dark:stroke-zinc-800" />
        <circle cx="42" cy="42" r={r} fill="none" strokeWidth="8" strokeLinecap="round"
          className="stroke-accent-500 transition-all duration-700"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <div>
        <div className="text-xl font-bold">{pct}%</div>
        <div className="text-sm text-zinc-600 dark:text-zinc-400">{current} of {target} {unit}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      </div>
    </div>
  );
}

export default function Stats({ books, goals, onSetGoal }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);

  const flat = useMemo(() => flattenBooks(books), [books]);

  const years = useMemo(() => {
    const ys = new Set([thisYear]);
    for (const b of flat) if (b.date_finished) ys.add(new Date(b.date_finished + "T00:00:00").getFullYear());
    return [...ys].sort((a, b) => b - a);
  }, [flat, thisYear]);

  const stats = useMemo(() => {
    const finishedEver = flat.filter((b) => b.status === "read");
    const inYear = (b) => b.date_finished && new Date(b.date_finished + "T00:00:00").getFullYear() === year;
    const finishedThisYear = finishedEver.filter(inYear);
    // Undated finished books only count in all-time numbers.
    const minutesEver = finishedEver.reduce((s, b) => s + (b.duration_minutes ?? 0), 0);
    const minutesYear = finishedThisYear.reduce((s, b) => s + (b.duration_minutes ?? 0), 0);

    const tally = (list, key) => {
      const m = new Map();
      for (const b of list) {
        const v = b[key];
        if (!v) continue;
        for (const part of String(v).split(",").map((x) => x.trim()).filter(Boolean)) {
          m.set(part, (m.get(part) ?? 0) + 1);
        }
      }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    };

    const rated = finishedEver.filter((b) => Number(b.rating) > 0);
    const dist = new Map();
    for (const b of rated) {
      const r = Number(b.rating);
      dist.set(r, (dist.get(r) ?? 0) + 1);
    }

    const longest = finishedEver.reduce((a, b) => ((b.duration_minutes ?? 0) > (a?.duration_minutes ?? 0) ? b : a), null);
    const dnf = flat.filter((b) => b.status === "dnf").length;

    // "You vs the crowd": books carrying both your rating and a public one.
    const pairs = finishedEver.filter((b) => Number(b.rating) > 0 && Number(b.goodreads_rating) > 0);
    let crowd = null;
    if (pairs.length >= 3) {
      const delta = (b) => Number(b.rating) - Number(b.goodreads_rating);
      const avgDelta = pairs.reduce((s, b) => s + delta(b), 0) / pairs.length;
      const agree = pairs.filter((b) => Math.abs(delta(b)) <= 0.5).length;
      const spiciest = pairs.reduce((a, b) => (Math.abs(delta(b)) > Math.abs(delta(a)) ? b : a));
      crowd = {
        n: pairs.length,
        avgDelta: Math.round(avgDelta * 10) / 10,
        agreePct: Math.round((agree / pairs.length) * 100),
        spiciest,
      };
    }

    return {
      finishedEver: finishedEver.length,
      finishedThisYear: finishedThisYear.length,
      minutesEver, minutesYear,
      avg: rated.length ? (rated.reduce((s, b) => s + Number(b.rating), 0) / rated.length).toFixed(1) : "—",
      topAuthors: tally(finishedEver, "author"),
      topNarrators: tally(finishedEver, "narrator"),
      topGenres: tally(finishedEver, "genre"),
      dist, longest, dnf, crowd,
      rereads: flat.reduce((s, b) => s + (b.reread_count ?? 0), 0),
    };
  }, [flat, year]);

  const bookGoal = goals.find((g) => g.year === year && g.goal_type === "books");
  const hourGoal = goals.find((g) => g.year === year && g.goal_type === "hours");
  const maxDist = Math.max(1, ...stats.dist.values());

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Your year in audiobooks</h2>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={`${inputCls} !w-28`}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {/* goals */}
      <div className="grid gap-3 sm:grid-cols-2">
        {bookGoal
          ? <GoalRing label={`${year} book goal`} current={stats.finishedThisYear} target={bookGoal.target} unit="books" />
          : <GoalSetter label="books" year={year} onSet={(t) => onSetGoal(year, "books", t)} />}
        {hourGoal
          ? <GoalRing label={`${year} listening goal`} current={Math.round(stats.minutesYear / 60)} target={hourGoal.target} unit="hours" />
          : <GoalSetter label="hours" year={year} onSet={(t) => onSetGoal(year, "hours", t)} />}
      </div>

      {/* headline stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard value={stats.finishedThisYear} label={`Finished in ${year}`} />
        <StatCard value={`${Math.round(stats.minutesYear / 60)}h`} label={`Listened in ${year}`} />
        <StatCard value={stats.finishedEver} label="Finished all-time" sub={`${Math.round(stats.minutesEver / 60)}h total`} />
        <StatCard value={`${stats.avg}★`} label="Average rating" />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <TopList title="Top authors" items={stats.topAuthors} />
        <TopList title="Top narrators" items={stats.topNarrators} />
        <TopList title="Top genres" items={stats.topGenres} />
      </div>

      {/* rating distribution + superlatives */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-300/90 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Rating distribution</div>
          <div className="flex h-28 items-end gap-1.5">
            {[1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((r) => {
              const n = stats.dist.get(r) ?? 0;
              return (
                <div key={r} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{n || ""}</span>
                  <div className="w-full rounded-t bg-accent-500/80" style={{ height: `${(n / maxDist) * 80}px` }} />
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{r}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="space-y-3 rounded-xl border border-zinc-300/90 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Superlatives</div>
          {stats.longest && (
            <p className="flex items-center gap-2"><Ruler className="h-4 w-4 text-zinc-500 dark:text-zinc-400" /> <span>Longest listen: <strong>{stats.longest.title}</strong> ({fmtDuration(stats.longest.duration_minutes)})</span></p>
          )}
          <p className="flex items-center gap-2"><Repeat className="h-4 w-4 text-zinc-500 dark:text-zinc-400" /> <span>Re-listens: <strong>{stats.rereads}</strong></span></p>
          <p className="flex items-center gap-2"><Ban className="h-4 w-4 text-zinc-500 dark:text-zinc-400" /> <span>Did-not-finish: <strong>{stats.dnf}</strong></span></p>
          {stats.crowd && (
            <>
              <p className="flex items-center gap-2"><Users className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                <span>
                  You vs the crowd: you agree <strong>{stats.crowd.agreePct}%</strong> of the time
                  {stats.crowd.avgDelta !== 0 && (
                    <> and rate <strong>{Math.abs(stats.crowd.avgDelta)}★ {stats.crowd.avgDelta < 0 ? "tougher" : "kinder"}</strong></>
                  )}
                  {" "}({stats.crowd.n} books compared)
                </span>
              </p>
              <p className="flex items-center gap-2"><Flame className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                <span>
                  Hottest take: <strong>{stats.crowd.spiciest.title}</strong> — you: {Number(stats.crowd.spiciest.rating)}★, crowd: {Number(stats.crowd.spiciest.goodreads_rating)}★
                </span>
              </p>
            </>
          )}
          {!stats.longest && <p className="text-zinc-500 dark:text-zinc-400">Add durations to books (autofill does this) to unlock listening-time stats.</p>}
        </div>
      </div>
    </div>
  );
}

function GoalSetter({ label, year, onSet }) {
  const [v, setV] = useState("");
  return (
    <div className="flex items-end gap-3 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <div className="flex-1">
        <label className={labelCls}>Set a {year} {label} goal</label>
        <input type="number" min="1" value={v} onChange={(e) => setV(e.target.value)} className={inputCls} placeholder={label === "books" ? "e.g. 24" : "e.g. 200"} />
      </div>
      <button
        onClick={() => v > 0 && onSet(Number(v))}
        className="rounded-lg bg-accent-500 px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-accent-400 cursor-pointer"
      >
        Set
      </button>
    </div>
  );
}

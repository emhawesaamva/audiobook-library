// Migrates legacy audiobook_library JSON blobs into the v2 relational schema
// under the owner's account, and promotes the owner to admin.
//
// Usage: OWNER_EMAIL=you@gmail.com node scripts/migrate-legacy.js
//
// Idempotent: profiles are keyed by legacy_id, books by (profile_id, legacy_id),
// rejected titles by the unique index, snapshots by (profile_id, created_at).
// Safe to kill and re-run. Never writes to the legacy table.
import { rest, findUserByEmail } from "./common.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL;
if (!OWNER_EMAIL) {
  console.error("Set OWNER_EMAIL to the owner's sign-in email.");
  process.exit(1);
}

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn("WARN:", msg); };

const VALID_STATUS = new Set(["read", "reading", "wanttoread", "recommended", "dnf"]);
const mapStatus = (s, ctx) => {
  if (s == null) return null;
  if (VALID_STATUS.has(s)) return s;
  warn(`unknown status "${s}" on ${ctx} -> null`);
  return null;
};
const mapRating = (r) => (typeof r === "number" && r > 0 && r <= 5 ? r : null);
const mapYear = (y) => {
  const n = parseInt(y, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const mapGoodreads = (g) => {
  const n = parseFloat(g);
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : null;
};

function bookFields(e, ctx) {
  return {
    title: e.title ?? "(untitled)",
    author: e.author ?? null,
    genre: e.genre ?? null,
    subgenre: e.subgenre || null,
    loved: !!e.loved,
    notes: e.notes || null,
    year: mapYear(e.year),
    goodreads_rating: mapGoodreads(e.goodreads),
    goodreads_url: e.goodreads_url || null,
    rating: mapRating(e.rating),
    status: mapStatus(e.status, ctx),
  };
}

async function readLegacy(id) {
  const rows = await rest(`audiobook_library?select=data&id=eq.${encodeURIComponent(id)}`);
  return rows[0]?.data ?? null;
}

// ---- 1. Owner account ----
const owner = await findUserByEmail(OWNER_EMAIL);
if (!owner) {
  console.error(`No auth user found for ${OWNER_EMAIL}. Sign in once first, then re-run.`);
  process.exit(1);
}
console.log(`Owner: ${owner.email} (${owner.id})`);
await rest(`accounts?id=eq.${owner.id}`, { method: "PATCH", body: { is_admin: true } });
console.log("Owner promoted to admin.");

// ---- 2. Legacy profiles ----
const legacyProfiles = (await readLegacy("library-profiles")) ?? [
  { id: "em", name: "Em", ageGroup: "adult" },
  { id: "phoebe", name: "Phoebe", ageGroup: "children" },
];

for (const lp of legacyProfiles) {
  let [profile] = await rest(
    `profiles?select=id&account_id=eq.${owner.id}&legacy_id=eq.${encodeURIComponent(lp.id)}`
  );
  if (!profile) {
    [profile] = await rest("profiles", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        account_id: owner.id,
        name: lp.name,
        age_group: ["adult", "teens", "children"].includes(lp.ageGroup) ? lp.ageGroup : "adult",
        legacy_id: lp.id,
      },
    });
    console.log(`Created profile "${lp.name}" (${profile.id})`);
  } else {
    console.log(`Profile "${lp.name}" already migrated (${profile.id})`);
  }

  // ---- 3. Books ----
  const entries = (await readLegacy(`${lp.id}-library`)) ?? [];
  const existing = await rest(`books?select=legacy_id&profile_id=eq.${profile.id}&legacy_id=not.is.null`);
  const done = new Set(existing.map((b) => b.legacy_id));
  let created = 0;

  for (const e of entries) {
    if (done.has(e.id)) continue;
    if (e.series) {
      const [parent] = await rest("books", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: {
          profile_id: profile.id,
          is_series: true,
          ...bookFields(e, e.title),
          rating: null,   // derived from children
          status: null,
          legacy_id: e.id,
        },
      });
      created++;
      const subs = e.books ?? [];
      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        if (done.has(sub.id)) continue;
        await rest("books", {
          method: "POST",
          body: {
            profile_id: profile.id,
            parent_id: parent.id,
            is_series: false,
            ...bookFields(sub, `${e.title} / ${sub.title}`),
            series_position: i + 1,
            legacy_id: sub.id,
          },
        });
        created++;
      }
    } else {
      await rest("books", {
        method: "POST",
        body: {
          profile_id: profile.id,
          is_series: false,
          ...bookFields(e, e.title),
          legacy_id: e.id,
        },
      });
      created++;
    }
  }
  console.log(`  books: ${created} created (${done.size} already present)`);

  // ---- 4. Rejected recommendations ----
  const rejected = (await readLegacy(`${lp.id}-rejected`)) ?? [];
  const existingRej = await rest(`rejected_recommendations?select=title&profile_id=eq.${profile.id}`);
  const rejDone = new Set(existingRej.map((r) => r.title.toLowerCase()));
  for (const title of rejected) {
    if (rejDone.has(title.toLowerCase())) continue;
    await rest("rejected_recommendations", {
      method: "POST",
      body: { profile_id: profile.id, title },
    });
  }
  console.log(`  rejected: ${rejected.length} total`);

  // ---- 5. Snapshots ----
  const snapRows = await rest(
    `audiobook_library?select=id,data&id=like.${encodeURIComponent(`${lp.id}-library-snapshot-`)}*`
  );
  const existingSnaps = await rest(`library_snapshots?select=created_at&profile_id=eq.${profile.id}`);
  const snapDone = new Set(existingSnaps.map((s) => new Date(s.created_at).getTime()));
  let snapCreated = 0;
  for (const row of snapRows) {
    const ts = row.id.slice(`${lp.id}-library-snapshot-`.length);
    const when = new Date(ts);
    if (Number.isNaN(when.getTime())) { warn(`unparseable snapshot id ${row.id}`); continue; }
    if (snapDone.has(when.getTime())) continue;
    await rest("library_snapshots", {
      method: "POST",
      body: { profile_id: profile.id, data: row.data, created_at: when.toISOString() },
    });
    snapCreated++;
  }
  console.log(`  snapshots: ${snapCreated} created (${snapRows.length} legacy)`);
}

console.log(warnings.length ? `\nDone with ${warnings.length} warning(s).` : "\nDone, no warnings.");

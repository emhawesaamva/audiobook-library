// Verifies the legacy -> relational migration. Read-only.
// Usage: OWNER_EMAIL=you@gmail.com node scripts/verify-migration.js
import { rest, findUserByEmail } from "./common.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL;
if (!OWNER_EMAIL) { console.error("Set OWNER_EMAIL."); process.exit(1); }

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const readLegacy = async (id) =>
  (await rest(`audiobook_library?select=data&id=eq.${encodeURIComponent(id)}`))[0]?.data ?? null;

const owner = await findUserByEmail(OWNER_EMAIL);
if (!owner) { console.error("Owner auth user not found."); process.exit(1); }

const [account] = await rest(`accounts?select=is_admin&id=eq.${owner.id}`);
check("owner is admin", account?.is_admin === true);

const legacyProfiles = (await readLegacy("library-profiles")) ?? [];
const profiles = await rest(`profiles?select=id,name,age_group,legacy_id&account_id=eq.${owner.id}`);
check("profile count", profiles.length === legacyProfiles.length,
  `${profiles.length} vs legacy ${legacyProfiles.length}`);

for (const lp of legacyProfiles) {
  const profile = profiles.find((p) => p.legacy_id === lp.id);
  check(`profile "${lp.name}" exists`, !!profile);
  if (!profile) continue;
  check(`  age_group`, profile.age_group === (lp.ageGroup ?? "adult"),
    `${profile.age_group} vs ${lp.ageGroup ?? "adult"}`);

  const entries = (await readLegacy(`${lp.id}-library`)) ?? [];
  const topLevel = await rest(`books?select=id,legacy_id,title,author,rating,status,is_series&profile_id=eq.${profile.id}&parent_id=is.null`);
  check(`  top-level books`, topLevel.length === entries.length,
    `${topLevel.length} vs legacy ${entries.length}`);

  const legacyChildCount = entries.reduce((s, e) => s + (e.series ? (e.books?.length ?? 0) : 0), 0);
  const children = await rest(`books?select=id,parent_id,legacy_id&profile_id=eq.${profile.id}&parent_id=not.is.null`);
  check(`  series children`, children.length === legacyChildCount,
    `${children.length} vs legacy ${legacyChildCount}`);

  // Spot-check 5 random standalone entries field-by-field
  const standalone = entries.filter((e) => !e.series);
  for (let n = 0; n < Math.min(5, standalone.length); n++) {
    const e = standalone[Math.floor(Math.random() * standalone.length)];
    const row = topLevel.find((b) => b.legacy_id === e.id);
    const ok = row &&
      row.title === e.title &&
      (row.author ?? null) === (e.author ?? null) &&
      (row.rating == null ? !(e.rating > 0) : Number(row.rating) === e.rating) &&
      (row.status ?? null) === (e.status ?? null);
    check(`  spot "${e.title}"`, !!ok, ok ? "" : JSON.stringify({ legacy: e, row }));
  }

  const legacyRejected = (await readLegacy(`${lp.id}-rejected`)) ?? [];
  const rejected = await rest(`rejected_recommendations?select=id&profile_id=eq.${profile.id}`);
  check(`  rejected`, rejected.length === legacyRejected.length,
    `${rejected.length} vs legacy ${legacyRejected.length}`);

  const snapRows = await rest(
    `audiobook_library?select=id&id=like.${encodeURIComponent(`${lp.id}-library-snapshot-`)}*`
  );
  const snaps = await rest(`library_snapshots?select=id&profile_id=eq.${profile.id}`);
  check(`  snapshots`, snaps.length >= snapRows.length,
    `${snaps.length} vs legacy ${snapRows.length}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

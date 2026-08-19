// Ship a small change straight to production, skipping the PR gate.
//
// The normal path is a PR into master, where branch protection holds the merge
// — and with it the Vercel deploy — until the unit, E2E, and mobile suites all
// pass (~7 minutes). That is the right trade for anything with moving parts.
// For a copy tweak, a label rename, a spacing fix, this pushes straight to
// master instead and lets Vercel deploy it. Branch protection has
// enforce_admins off, so an admin push is allowed through.
//
// What it still runs, because together they take about two seconds and catch
// the mistakes that would white-screen the whole SPA:
//   - npm test        unit + import logic
//   - npm run build   a syntax error here is a blank page in production
// The Playwright suites are what this skips. They still run on the push, so a
// regression lands in Actions a few minutes later instead of blocking — you
// find out after users could, which is the trade being made.
//
// Paths that are never "minor" are refused outright: migrations and Supabase
// config, api/, dependency changes, workflows, and vercel.json all change
// behaviour no fast check covers.
//
// Usage: node scripts/quick-deploy.mjs "commit message" [--force] [--dry-run]
//   --force     skip the pre-flight suites and the risky-path refusal
//   --dry-run   run every check, print what would ship, push nothing
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const dryRun = argv.includes("--dry-run");
const message = argv.find((a) => !a.startsWith("--"));

const APP_URL = (readFileSync(resolve(root, "APP_URL.md"), "utf8").match(/https:\/\/\S+/) ?? [])[0];

// Anything here changes behaviour the two-second pre-flight cannot see.
const NEVER_MINOR = [
  ["supabase/", "database schema or auth config"],
  ["api/", "serverless functions"],
  ["package.json", "dependencies or scripts"],
  ["package-lock.json", "dependencies"],
  [".github/", "the CI pipeline itself"],
  ["vercel.json", "routing and rewrites"],
];

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---- where are we ----
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "master") {
  die(
    `On branch "${branch}". Quick deploy pushes master, and master is what Vercel serves.\n` +
    `  git checkout master     then re-run, or open a PR for this branch:\n` +
    `  gh pr create --base master`
  );
}

git("fetch", "origin", "master");
const behind = git("rev-list", "--count", "HEAD..origin/master");
if (behind !== "0") {
  die(`Local master is ${behind} commit(s) behind origin. Run:  git pull --rebase`);
}

// ---- what would ship ----
// Two explicit lists rather than parsing `status --porcelain`, whose leading
// status columns are easy to mis-slice — and a path silently losing its first
// character is a path the risky-check below stops recognising.
const lines = (out) => out.split("\n").map((l) => l.trim()).filter(Boolean);
const modified = lines(git("diff", "--name-only", "HEAD"));
const untracked = lines(git("ls-files", "--others", "--exclude-standard"));
const dirty = [...modified, ...untracked];
const unpushed = lines(git("log", "--oneline", "origin/master..HEAD"));

if (!dirty.length && !unpushed.length) die("Nothing to deploy — master is clean and matches origin.");
if (dirty.length && !message) {
  die(`Uncommitted changes need a message:  npm run deploy:quick -- "what changed"`);
}

const files = [...new Set([
  ...dirty,
  ...(unpushed.length ? lines(git("diff", "--name-only", "origin/master...HEAD")) : []),
])];

const risky = files.flatMap((f) => {
  const hit = NEVER_MINOR.find(([prefix]) => f === prefix || f.startsWith(prefix));
  return hit ? [`${f} — ${hit[1]}`] : [];
});
if (risky.length && !force) {
  die(
    `Not a minor change. These need the full gate:\n    ${risky.join("\n    ")}\n\n` +
    `  Open a PR instead:  git checkout -b <branch> && gh pr create --base master\n` +
    `  Or override if you are certain:  npm run deploy:quick -- "msg" --force`
  );
}

console.log(`\nShipping to ${APP_URL}:`);
for (const f of files) console.log(`  ${f}`);
if (risky.length) console.log(`\n⚠ forced past the risky-path check: ${risky.length} file(s)`);

// ---- pre-flight ----
if (force) {
  console.log("\n⚠ --force: skipping tests and build");
} else {
  for (const [label, args] of [["npm test", ["test"]], ["npm run build", ["run", "build"]]]) {
    process.stdout.write(`\n${label} … `);
    try {
      run("npm", args);
      console.log("pass");
    } catch (e) {
      die(`${label} failed — not deploying.\n\n${(e.stdout || "") + (e.stderr || "")}`);
    }
  }
}

// The asset hash changes whenever the bundle does, so it tells us the deploy
// actually reached the CDN rather than just that Vercel accepted the push.
const bundleHash = async () => {
  try {
    const html = await fetch(APP_URL, { cache: "no-store" }).then((r) => r.text());
    return (html.match(/assets\/index-[A-Za-z0-9_-]+\.js/) ?? ["unknown"])[0];
  } catch {
    return "unreachable";
  }
};
const before = await bundleHash();
const rollbackTo = git("rev-parse", "--short", "origin/master");

if (dryRun) {
  console.log(`\n--dry-run: would commit${message ? ` "${message}"` : ""} and push to master. Nothing sent.`);
  process.exit(0);
}

// ---- ship ----
if (dirty.length) {
  git("add", "-A");
  git("commit", "-m", message);
}
try {
  git("push", "origin", "master");
} catch (e) {
  die(
    `Push rejected — branch protection is enforcing checks for this account.\n` +
    `(enforce_admins was off when this was written; turning it on closes this path,\n` +
    `which is a reasonable thing to want.) The commit exists locally. To move it to\n` +
    `a branch and open a PR instead:\n` +
    `  git branch quick/<name>\n` +
    `  git reset --hard origin/master\n` +
    `  git checkout quick/<name> && git push -u origin quick/<name> && gh pr create --base master\n\n` +
    `${e.stderr || e.message || ""}`
  );
}
console.log(`\n✓ pushed — Vercel is building. Rollback point: ${rollbackTo}`);

process.stdout.write("waiting for the new bundle to serve … ");
const deadline = Date.now() + 180_000;
let live = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const now = await bundleHash();
  if (now !== before && now !== "unreachable") { live = true; break; }
}
console.log(live ? "live" : "not seen yet");

if (!live) {
  console.log(
    `The bundle at ${APP_URL} hasn't changed after 3 minutes. That is expected if\n` +
    `this change doesn't affect the built JS; otherwise check the Vercel dashboard.`
  );
}
console.log(
  `\nThe Playwright suites are running on this push, after the fact:\n` +
  `  gh run watch\n` +
  `If they come back red:\n` +
  `  git revert HEAD && git push origin master     (or reset to ${rollbackTo})\n`
);

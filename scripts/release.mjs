#!/usr/bin/env node
/**
 * One-command release: bump the version everywhere, commit, tag, and push.
 *
 *   pnpm release:tag patch        # 0.1.0 -> 0.1.1
 *   pnpm release:tag minor        # 0.1.0 -> 0.2.0
 *   pnpm release:tag major        # 0.1.0 -> 1.0.0
 *   pnpm release:tag 0.4.2        # explicit version
 *   pnpm release:tag patch --no-push   # bump + commit + tag locally, don't push
 *
 * Pushing the tag triggers .github/workflows/release.yml, which builds, signs,
 * and publishes the GitHub release (+ latest.json for the in-app updater).
 *
 * The version lives in four places here, and tauri.conf.json is the one that
 * matters most: its value is what lands in latest.json. If it lags behind the
 * tag, the updater compares against a stale version and silently never offers
 * the update. Nothing fails loudly, so every bump below asserts it matched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(root, "package.json");
const CONF = join(root, "src-tauri/tauri.conf.json");
// Workspace root, not src-tauri/Cargo.toml — every crate inherits the version
// with `version.workspace = true`.
const CARGO = join(root, "Cargo.toml");
const LOCK = join(root, "Cargo.lock");

const args = process.argv.slice(2);
const noPush = args.includes("--no-push");
const bump = args.find((a) => !a.startsWith("--"));

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

if (!bump) die("Usage: pnpm release:tag <patch|minor|major|x.y.z> [--no-push]");

// Run git with an argument array (no shell → no injection risk).
// Returns trimmed stdout, or '' when output is inherited (stdio: 'inherit').
function git(argv, opts = {}) {
  const out = execFileSync("git", argv, { cwd: root, stdio: "pipe", ...opts });
  return out ? out.toString().trim() : "";
}

// ── Compute the next version ────────────────────────────────────────────────
const current = JSON.parse(readFileSync(PKG, "utf8")).version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!m) die(`Current version "${current}" is not x.y.z`);
const [maj, min, pat] = m.slice(1).map(Number);

let next;
if (bump === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (bump === "minor") next = `${maj}.${min + 1}.0`;
else if (bump === "major") next = `${maj + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
else die(`Invalid version "${bump}". Use patch|minor|major or x.y.z`);

const tag = `v${next}`;

// ── Safety checks ───────────────────────────────────────────────────────────
if (git(["status", "--porcelain"])) {
  die("Working tree is not clean — commit or stash your changes first.");
}
if (git(["tag", "--list"]).split("\n").includes(tag)) {
  die(`Tag ${tag} already exists.`);
}

console.log(`\x1b[36mReleasing ${current} → ${next}  (${tag})\x1b[0m`);

/**
 * Replace and verify. A regex that matches nothing rewrites nothing and tells
 * no one, which is how a release ships with one file left behind. `expected`
 * is the number of matches the file must contain.
 */
function bumpFile(path, label, pattern, replacement, expected = 1) {
  const before = readFileSync(path, "utf8");
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const found = (before.match(new RegExp(pattern.source, flags)) ?? []).length;
  if (found !== expected) {
    die(`${label}: expected ${expected} version match(es), found ${found} — has the file's shape changed?`);
  }
  writeFileSync(path, before.replace(new RegExp(pattern.source, flags), replacement));
}

// Top-level "version" — verified to be the only one in each file.
bumpFile(PKG, "package.json", /"version":\s*"[^"]+"/, `"version": "${next}"`);
bumpFile(CONF, "tauri.conf.json", /"version":\s*"[^"]+"/, `"version": "${next}"`);

// [workspace.package] version. `[^[]*?` keeps the match inside that section so
// it cannot drift into the next table if the version is ever removed.
bumpFile(CARGO, "Cargo.toml", /(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]+(")/, `$1${next}$2`);

// All three workspace crates in the lock. `\r?\n` because git may check this
// file out CRLF while cargo rewrites it LF, so which is on disk depends on who
// touched it last.
bumpFile(
  LOCK,
  "Cargo.lock",
  /(name = "pob-(?:engine|redux|sync)"\r?\nversion = ")[^"]+(")/,
  `$1${next}$2`,
  3,
);

// ── Commit, tag, push ───────────────────────────────────────────────────────
git(["add", "package.json", "src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock"]);

// Releasing the current version (the very first release) writes no changes —
// only commit when the version actually moved.
let staged = true;
try {
  git(["diff", "--cached", "--quiet"]);
  staged = false;
} catch {
  staged = true;
}
if (staged) {
  git(["commit", "-m", `chore(release): ${tag}`]);
  console.log("\x1b[32m✓ committed version bump\x1b[0m");
} else {
  console.log(`\x1b[36mVersion already ${next} — tagging current commit.\x1b[0m`);
}

git(["tag", "-a", tag, "-m", `Release ${tag}`]);
console.log(`\x1b[32m✓ tagged ${tag}\x1b[0m`);

if (noPush) {
  console.log(`\nLocal only. To publish:\n  git push origin HEAD ${tag}`);
} else {
  console.log("Pushing…");
  // Push the branch and the tag explicitly. Pushing the tag by name is more
  // reliable than --follow-tags, which skips tags when the branch is unchanged.
  git(["push", "origin", "HEAD", tag], { stdio: "inherit" });
  console.log(`\n\x1b[32m✓ pushed ${tag}\x1b[0m — the release workflow will build and publish.`);
}

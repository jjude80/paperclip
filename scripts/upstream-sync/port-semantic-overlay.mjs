#!/usr/bin/env node
// NEXA-882: pre-port the server/ semantic overlay onto an upstream revision.
//
// The stage resolver (`resolve-server-conflicts.mjs`) takes upstream for the
// mechanical server paths and leaves the semantic ones unmerged. The semantic
// set is small but the hand work is easier if the fork delta is already applied
// on top of upstream, with only the real collisions left as markers.
//
// For every selected path this reads three blobs:
//   base    = the previous sync snapshot (fork delta origin, default 13ac9450)
//   ours    = the fork tip (default origin/master)
//   theirs  = the upstream revision (default MERGE_HEAD inside a stage merge)
// and runs `git merge-file` as theirs <- base -> ours, i.e. it applies the
// fork's post-snapshot change on top of upstream.
//
// It never commits. It never touches the worktree unless `--apply-clean` is
// given, and even then it only writes files that merged without a hunk. Any
// path with a conflict is written to the out-dir as a `.conflict` file for the
// operator to edit, and the process exits 3 so a caller cannot mistake a
// partial overlay for a resolved stage.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const json = has("--json");
const applyClean = has("--apply-clean");
const prefix = valueOf("--prefix", "server/");
const snapshot = valueOf("--snapshot", "13ac9450");
const forkTip = valueOf("--fork-tip", "origin/master");
const pathsFile = valueOf("--paths-file", null);
const outDirArg = valueOf("--out-dir", null);

const git = (gitArgs, opts = {}) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function fail(message, code = 2) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  else process.stderr.write(`port-semantic-overlay: ${message}\n`);
  process.exit(code);
}

try {
  git(["rev-parse", "--show-toplevel"]);
} catch {
  fail("not inside a git worktree");
}

let upstream = valueOf("--upstream", null);
if (!upstream) {
  try {
    upstream = git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).trim();
  } catch {
    fail("no --upstream given and no merge in progress (MERGE_HEAD absent)");
  }
}

for (const [flag, ref] of [["--snapshot", snapshot], ["--fork-tip", forkTip], ["--upstream", upstream]]) {
  try {
    git(["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  } catch {
    fail(`${flag} ref not found: ${ref}`);
  }
}

function readBlob(rev, path) {
  try {
    return git(["show", `${rev}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // A path that does not exist on one side is an add/add or delete/modify
    // conflict; an empty side is the correct merge-file input for both.
    if (error.status === 128) return null;
    throw error;
  }
}

// Selection: an explicit list wins; otherwise use the unmerged paths of the
// stage merge in progress, narrowed to the prefix and to the semantic rule the
// resolver uses (a post-snapshot fork commit touched it, or the fork blob still
// carries a NEXA-* marker).
let selected;
if (pathsFile) {
  selected = readFileSync(pathsFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => path.startsWith(prefix));
} else {
  let unmerged;
  try {
    unmerged = git(["diff", "--name-only", "--diff-filter=U", "-z"])
      .split("\0")
      .filter(Boolean)
      .filter((path) => path.startsWith(prefix));
  } catch {
    fail("no merge in progress; pass --paths-file <list> for a dry run");
  }
  const touched = new Set(
    git(["log", "--no-merges", "--format=", "--name-only", `${snapshot}..${forkTip}`, "--", prefix])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  let marked = new Set();
  try {
    marked = new Set(
      git(["grep", "-l", "-E", "NEXA-[0-9]+", forkTip, "--", prefix])
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(line.indexOf(":") + 1)),
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  selected = unmerged.filter((path) => touched.has(path) || marked.has(path));
}

if (selected.length === 0) {
  const empty = { ok: true, upstream, snapshot, forkTip, prefix, clean: [], conflicted: [], missing: [], outDir: null };
  process.stdout.write(json ? JSON.stringify(empty, null, 2) + "\n" : "no semantic paths selected\n");
  process.exit(0);
}

const upstreamShort = git(["rev-parse", "--short", upstream]).trim();
const outDir = outDirArg ?? join(".upstream-sync", "port", upstreamShort);
mkdirSync(outDir, { recursive: true });

const clean = [];
const conflicted = [];
const missing = [];
const scratch = mkdtempSync(join(tmpdir(), "semantic-overlay-"));

try {
  for (const path of selected) {
    const base = readBlob(snapshot, path);
    const ours = readBlob(forkTip, path);
    const theirs = readBlob(upstream, path);

    if (ours === null || theirs === null) {
      // One side deleted the path. That is a decision, never an automatic
      // overlay: record it and let the operator choose.
      missing.push({ path, sides: { base: base !== null, fork: ours !== null, upstream: theirs !== null } });
      continue;
    }

    const baseFile = join(scratch, "base");
    const oursFile = join(scratch, "ours");
    const theirsFile = join(scratch, "theirs");
    writeFileSync(baseFile, base ?? "");
    writeFileSync(oursFile, ours);
    writeFileSync(theirsFile, theirs);

    const merged = spawnMergeFile(theirsFile, baseFile, oursFile);
    const hunks = (merged.output.match(/^<<<<<<< /gm) ?? []).length;
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });

    if (merged.status === 0) {
      writeFileSync(target, merged.output);
      if (applyClean) writeFileSync(path, merged.output);
      clean.push({ path, output: target, applied: applyClean });
    } else {
      const conflictTarget = `${target}.conflict`;
      writeFileSync(conflictTarget, merged.output);
      conflicted.push({ path, hunks, output: conflictTarget });
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const result = {
  ok: true,
  upstream,
  snapshot,
  forkTip,
  prefix,
  outDir,
  clean,
  conflicted,
  missing,
};

if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
else {
  process.stdout.write(
    `semantic overlay onto ${upstreamShort}: ${selected.length} path(s), ` +
      `${clean.length} clean, ${conflicted.length} conflicted, ${missing.length} one-sided\n`,
  );
  for (const entry of clean) process.stdout.write(`  clean      ${entry.path}\n`);
  for (const entry of conflicted) {
    process.stdout.write(`  conflict   ${entry.path} (${entry.hunks} hunk(s)) -> ${entry.output}\n`);
  }
  for (const entry of missing) {
    process.stdout.write(
      `  one-sided  ${entry.path} (fork=${entry.sides.fork}, upstream=${entry.sides.upstream})\n`,
    );
  }
}

// Conflicted or one-sided paths still need a human decision.
process.exit(conflicted.length > 0 || missing.length > 0 ? 3 : 0);

function spawnMergeFile(current, base, other) {
  const result = spawnSync("git", ["merge-file", "-p", "--diff3", current, base, other], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout };
}

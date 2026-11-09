import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "port-semantic-overlay.mjs");

function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function commitAll(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", "commit", "-q", "-m", message]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "semantic-overlay-test-"));
  const repo = join(root, "repo");
  require0(git(root, ["init", "-q", "-b", "master", repo]));
  git(repo, ["config", "user.name", "Sync Test"]);
  git(repo, ["config", "user.email", "sync@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(repo, "server"), { recursive: true });
  writeFileSync(join(repo, "server", "clean.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "server", "clash.ts"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(repo, "server", "deleted.ts"), "delete me\n");
  commitAll(repo, "base");
  git(repo, ["branch", "snapshot"]);

  git(repo, ["checkout", "-q", "-b", "fork"]);
  writeFileSync(join(repo, "server", "clean.ts"), "one\ntwo\nthree\nfork line\n");
  writeFileSync(join(repo, "server", "clash.ts"), "alpha\nFORK\ngamma\n");
  writeFileSync(join(repo, "server", "deleted.ts"), "delete me\nfork edit\n");
  commitAll(repo, "fork delta");

  git(repo, ["checkout", "-q", "snapshot"]);
  git(repo, ["checkout", "-q", "-b", "upstream"]);
  writeFileSync(join(repo, "server", "clean.ts"), "upstream line\none\ntwo\nthree\n");
  writeFileSync(join(repo, "server", "clash.ts"), "alpha\nUPSTREAM\ngamma\n");
  git(repo, ["rm", "-q", "server/deleted.ts"]);
  commitAll(repo, "upstream delta");

  return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function require0(result) {
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function run(repo, extra) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--snapshot", "snapshot", "--fork-tip", "fork", "--upstream", "upstream", ...extra],
    { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

function writePaths(root, paths) {
  const file = join(root, "paths.txt");
  writeFileSync(file, paths.join("\n") + "\n");
  return file;
}

test("applies the fork delta onto upstream and reports each real collision", () => {
  const f = fixture();
  try {
    const out = join(f.root, "out");
    const paths = writePaths(f.root, ["server/clean.ts", "server/clash.ts", "server/deleted.ts"]);
    const result = run(f.repo, ["--paths-file", paths, "--out-dir", out, "--json"]);
    assert.equal(result.status, 3, result.stderr);
    const parsed = JSON.parse(result.stdout);

    assert.deepEqual(parsed.clean.map((entry) => entry.path), ["server/clean.ts"]);
    assert.equal(parsed.conflicted.length, 1);
    assert.equal(parsed.conflicted[0].path, "server/clash.ts");
    assert.equal(parsed.conflicted[0].hunks, 1);
    assert.deepEqual(parsed.missing.map((entry) => entry.path), ["server/deleted.ts"]);

    const merged = readFileSync(join(out, "server", "clean.ts"), "utf8");
    assert.match(merged, /^upstream line/m);
    assert.match(merged, /^fork line/m);

    const conflict = readFileSync(parsed.conflicted[0].output, "utf8");
    assert.match(conflict, /^<<<<<<< /m);
    assert.match(conflict, /^=======$/m);
  } finally {
    f.cleanup();
  }
});

test("exits 0 when every selected path ports cleanly", () => {
  const f = fixture();
  try {
    const paths = writePaths(f.root, ["server/clean.ts"]);
    const result = run(f.repo, ["--paths-file", paths, "--out-dir", join(f.root, "out2"), "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.clean.length, 1);
    assert.equal(parsed.conflicted.length, 0);
    assert.equal(parsed.missing.length, 0);
  } finally {
    f.cleanup();
  }
});

test("--apply-clean writes only conflict-free files into the worktree", () => {
  const f = fixture();
  try {
    git(f.repo, ["checkout", "-q", "fork"]);
    const paths = writePaths(f.root, ["server/clean.ts", "server/clash.ts"]);
    const result = run(f.repo, [
      "--paths-file", paths,
      "--out-dir", join(f.root, "out3"),
      "--apply-clean",
      "--json",
    ]);
    assert.equal(result.status, 3, result.stderr);
    assert.match(readFileSync(join(f.repo, "server", "clean.ts"), "utf8"), /^upstream line/m);
    // The conflicted file keeps the fork content: no marker is written into the
    // worktree.
    assert.match(readFileSync(join(f.repo, "server", "clash.ts"), "utf8"), /^FORK$/m);
  } finally {
    f.cleanup();
  }
});

test("refuses to guess when a path is deleted on one side", () => {
  const f = fixture();
  try {
    const paths = writePaths(f.root, ["server/deleted.ts"]);
    const result = run(f.repo, ["--paths-file", paths, "--out-dir", join(f.root, "out4"), "--json"]);
    assert.equal(result.status, 3, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.clean.length, 0);
    assert.deepEqual(parsed.missing, [
      { path: "server/deleted.ts", sides: { base: true, fork: true, upstream: false } },
    ]);
  } finally {
    f.cleanup();
  }
});

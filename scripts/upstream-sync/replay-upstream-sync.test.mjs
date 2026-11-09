import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "replay-upstream-sync.mjs",
);

function git(cwd, args, { allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function initWorkRepo(path) {
  git(path, ["init", "-q", "-b", "master"]);
  git(path, ["config", "user.name", "Sync Test"]);
  git(path, ["config", "user.email", "sync-test@example.invalid"]);
  git(path, ["config", "commit.gpgsign", "false"]);
}

function commitAll(path, message) {
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", message]);
}

/**
 * Builds fork + upstream repositories that share a base commit.
 * upstreamCommits is a list of {files, message}; each becomes one upstream
 * commit after the fork divergence.
 */
function createFixture(upstreamCommits, { forkCommon = "fork\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "upstream-sync-test-"));
  const originBare = join(root, "fork.git");
  const upstreamBare = join(root, "upstream.git");
  const upstreamWork = join(root, "upstream-work");
  const repo = join(root, "repo");
  git(root, ["init", "-q", "--bare", originBare]);
  git(root, ["init", "-q", "--bare", upstreamBare]);
  git(root, ["init", "-q", "-b", "master", upstreamWork]);
  git(upstreamWork, ["config", "user.name", "Upstream"]);
  git(upstreamWork, ["config", "user.email", "upstream@example.invalid"]);
  writeFileSync(join(upstreamWork, "common.txt"), "base\n");
  writeFileSync(join(upstreamWork, "base.txt"), "base\n");
  commitAll(upstreamWork, "base");
  git(upstreamWork, ["remote", "add", "origin", upstreamBare]);
  git(upstreamWork, ["push", "-q", "-u", "origin", "master"]);

  git(root, ["clone", "-q", upstreamBare, repo]);
  git(repo, ["remote", "rename", "origin", "upstream"]);
  git(repo, ["remote", "set-url", "--push", "upstream", "DISABLED-upstream-is-fetch-only"]);
  git(repo, ["remote", "add", "origin", originBare]);
  git(repo, ["push", "-q", "-u", "origin", "master"]);
  writeFileSync(join(repo, "common.txt"), forkCommon);
  writeFileSync(join(repo, "fork.txt"), "fork-only\n");
  commitAll(repo, "fork change");
  git(repo, ["push", "-q", "origin", "master"]);

  const stageShas = [];
  for (const [index, upstream] of upstreamCommits.entries()) {
    for (const [name, content] of Object.entries(upstream.files ?? {})) {
      writeFileSync(join(upstreamWork, name), content);
    }
    commitAll(upstreamWork, upstream.message ?? `upstream ${index + 1}`);
    git(upstreamWork, ["push", "-q", "origin", "master"]);
    stageShas.push(git(upstreamWork, ["rev-parse", "HEAD"]).stdout);
  }
  return { root, repo, stageShas, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeConfig(root, config) {
  const path = join(root, "stages.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, branch: "sync/test", stateDir: ".upstream-sync", ...config }, null, 2));
  return path;
}

function runReplay(repo, configPath, extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--repo", repo, "--config", configPath, ...extra],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
}

test("replays chronological stages and verifies each one before advancing", () => {
  const fixture = createFixture([
    { message: "upstream stage 1", files: { "stage1.txt": "one\n" } },
    { message: "upstream stage 2", files: { "stage2.txt": "two\n" } },
  ]);
  try {
    const config = writeConfig(fixture.root, {
      stages: [
        { id: "s1", upstream: fixture.stageShas[0], verify: ["test -f stage1.txt"] },
        { id: "s2", upstream: fixture.stageShas[1], verify: ["test -f stage1.txt", "test -f stage2.txt"] },
      ],
    });
    const result = runReplay(fixture.repo, config);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /all 2 stage\(s\) verified/);

    const branch = git(fixture.repo, ["symbolic-ref", "--short", "HEAD"]).stdout;
    assert.equal(branch, "sync/test");
    assert.equal(git(fixture.repo, ["rev-list", "--count", "--merges", "origin/master..HEAD"]).stdout, "2");
    assert.equal(git(fixture.repo, ["show", "HEAD:stage2.txt"]).stdout, "two");

    const state = JSON.parse(readFileSync(join(fixture.repo, ".upstream-sync", "state.json"), "utf8"));
    assert.equal(state.stages.s1.status, "verified");
    assert.equal(state.stages.s2.status, "verified");
    assert.ok(state.stages.s2.verifyResults.length === 2);

    // Re-running a fully verified replay is a no-op, not a second merge.
    const rerun = runReplay(fixture.repo, config);
    assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
    assert.equal(git(fixture.repo, ["rev-list", "--count", "--merges", "origin/master..HEAD"]).stdout, "2");
  } finally {
    fixture.cleanup();
  }
});

test("records conflicted paths and refuses to advance until they are resolved", () => {
  const fixture = createFixture([
    { message: "upstream edits common", files: { "common.txt": "upstream\n" } },
  ]);
  try {
    const config = writeConfig(fixture.root, {
      stages: [
        { id: "s1", upstream: fixture.stageShas[0], verify: ["grep -q resolved common.txt"] },
      ],
    });
    const conflicted = runReplay(fixture.repo, config);
    assert.equal(conflicted.status, 3, `${conflicted.stdout}\n${conflicted.stderr}`);
    const ledger = readFileSync(join(fixture.repo, ".upstream-sync", "ledgers", "s1.txt"), "utf8");
    assert.match(ledger, /common\.txt/);
    assert.equal(
      git(fixture.repo, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], { allowFail: true }).status,
      0,
      "the merge should be left in progress for a human/agent to resolve",
    );
    const state = JSON.parse(readFileSync(join(fixture.repo, ".upstream-sync", "state.json"), "utf8"));
    assert.equal(state.stages.s1.status, "conflicted");
    assert.deepEqual(state.stages.s1.conflicts, ["common.txt"]);

    // Still unresolved: a second run refuses again without advancing.
    const stillConflicted = runReplay(fixture.repo, config);
    assert.equal(stillConflicted.status, 3);

    writeFileSync(join(fixture.repo, "common.txt"), "resolved\n");
    git(fixture.repo, ["add", "common.txt"]);
    const resolved = runReplay(fixture.repo, config);
    assert.equal(resolved.status, 0, `${resolved.stdout}\n${resolved.stderr}`);
    const resolvedState = JSON.parse(readFileSync(join(fixture.repo, ".upstream-sync", "state.json"), "utf8"));
    assert.equal(resolvedState.stages.s1.status, "verified");
  } finally {
    fixture.cleanup();
  }
});

test("refuses to advance when a stage verification fails, and does not re-merge", () => {
  const fixture = createFixture([
    { message: "upstream stage 1", files: { "stage1.txt": "one\n" } },
  ]);
  try {
    const config = writeConfig(fixture.root, {
      stages: [{ id: "s1", upstream: fixture.stageShas[0], verify: ["test -f not-there.txt"] }],
    });
    const failed = runReplay(fixture.repo, config);
    assert.equal(failed.status, 4, `${failed.stdout}\n${failed.stderr}`);
    assert.match(failed.stderr, /refuses to advance/);
    const state = JSON.parse(readFileSync(join(fixture.repo, ".upstream-sync", "state.json"), "utf8"));
    assert.equal(state.stages.s1.status, "verify-failed");
    assert.equal(git(fixture.repo, ["rev-list", "--count", "--merges", "origin/master..HEAD"]).stdout, "1");

    const retried = runReplay(fixture.repo, config);
    assert.equal(retried.status, 4);
    assert.equal(git(fixture.repo, ["rev-list", "--count", "--merges", "origin/master..HEAD"]).stdout, "1");

    const fixedConfig = writeConfig(fixture.root, {
      stages: [{ id: "s1", upstream: fixture.stageShas[0], verify: ["test -f stage1.txt"] }],
    });
    const fixed = runReplay(fixture.repo, fixedConfig);
    assert.equal(fixed.status, 0, `${fixed.stdout}\n${fixed.stderr}`);
    assert.equal(git(fixture.repo, ["rev-list", "--count", "--merges", "origin/master..HEAD"]).stdout, "1");
  } finally {
    fixture.cleanup();
  }
});

test("refuses to use the fork master as the integration branch", () => {
  const fixture = createFixture([
    { message: "upstream stage 1", files: { "stage1.txt": "one\n" } },
  ]);
  try {
    const config = writeConfig(fixture.root, {
      branch: "master",
      stages: [{ id: "s1", upstream: fixture.stageShas[0], verify: ["true"] }],
    });
    const result = runReplay(fixture.repo, config);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /protected branch/);
  } finally {
    fixture.cleanup();
  }
});

test("plan mode resolves stages without creating the integration branch", () => {
  const fixture = createFixture([
    { message: "upstream stage 1", files: { "stage1.txt": "one\n" } },
  ]);
  try {
    const config = writeConfig(fixture.root, {
      stages: [{ id: "s1", upstream: fixture.stageShas[0], verify: ["true"] }],
    });
    const result = runReplay(fixture.repo, config, ["--plan"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /s1/);
    assert.notEqual(
      git(fixture.repo, ["rev-parse", "--verify", "refs/heads/sync/test"], { allowFail: true }).status,
      0,
      "plan mode must not create the integration branch",
    );
    assert.equal(existsSync(join(fixture.repo, ".upstream-sync", "state.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("refuses a plan with no stages until the triage plan lands", () => {
  const fixture = createFixture([], {});
  try {
    const config = writeConfig(fixture.root, { awaitingStagePlan: true, stages: [] });
    const result = runReplay(fixture.repo, config, ["--plan"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /NEXA-880/);
  } finally {
    fixture.cleanup();
  }
});

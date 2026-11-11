import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../worktree-bootstrap.sh", import.meta.url).pathname;

// Keep PATH minimal and deterministic: node must be reachable for the test
// runner, and no real `pnpm` may shadow the stub.
const testPath = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A checkout shaped like the repository: the bootstrap script under `scripts/`,
 * the workspace manifests at the root.
 */
function makeCheckout({ workspace = true } = {}) {
  const root = makeTempDir("paperclip-worktree-bootstrap-");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(script, path.join(root, "scripts", "worktree-bootstrap.sh"));
  fs.chmodSync(path.join(root, "scripts", "worktree-bootstrap.sh"), 0o755);
  if (workspace) {
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  }
  return root;
}

/**
 * A `pnpm` stub that records each invocation and, when asked to install, leaves
 * behind the two files the bootstrap script checks for. `installExit` lets a
 * test steer a failed install.
 */
function makePnpmStub({ installExit = 0 } = {}) {
  const bin = makeTempDir("paperclip-worktree-bootstrap-bin-");
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/sh
printf '%s\\n' "$*" >> pnpm-calls
case "$*" in
  install*)
    if [ ${installExit} -ne 0 ]; then exit ${installExit}; fi
    mkdir -p node_modules/.bin node_modules/typescript/bin
    : > node_modules/.bin/vitest
    chmod +x node_modules/.bin/vitest
    : > node_modules/typescript/bin/tsc
    exit 0
    ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  return bin;
}

function runBootstrap(root, bin, args = []) {
  return spawnSync(path.join(root, "scripts", "worktree-bootstrap.sh"), args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${testPath}` },
  });
}

function readCalls(root) {
  const callsPath = path.join(root, "pnpm-calls");
  if (!fs.existsSync(callsPath)) return [];
  return fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean);
}

test("a fresh worktree installs dependencies and then builds the dist-only packages", () => {
  const root = makeCheckout();
  const bin = makePnpmStub();

  const result = runBootstrap(root, bin);

  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(root);
  assert.equal(calls.length, 2, calls.join("\n"));
  assert.match(calls[0], /^install --frozen-lockfile$/);
  assert.match(calls[1], /^--filter @paperclipai\/plugin-sdk ensure-build-deps$/);
});

test("--offline keeps the install off the network", () => {
  const root = makeCheckout();
  const bin = makePnpmStub();

  const result = runBootstrap(root, bin, ["--offline"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readCalls(root)[0], /^install --offline --frozen-lockfile$/);
});

test("an already installed tree skips the install but still ensures the build", () => {
  const root = makeCheckout();
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", ".bin", "vitest"), "");
  fs.chmodSync(path.join(root, "node_modules", ".bin", "vitest"), 0o755);
  fs.mkdirSync(path.join(root, "node_modules", "typescript", "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "typescript", "bin", "tsc"), "");
  const bin = makePnpmStub();

  const result = runBootstrap(root, bin);

  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(root);
  assert.equal(calls.length, 1, calls.join("\n"));
  assert.match(calls[0], /ensure-build-deps$/);
});

test("--skip-install refuses to pretend an empty tree is bootstrapped", () => {
  const root = makeCheckout();
  const bin = makePnpmStub();

  const result = runBootstrap(root, bin, ["--skip-install"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TypeScript is missing from node_modules/);
  assert.deepEqual(readCalls(root), []);
});

test("a failed install fails the bootstrap instead of reporting it ready", () => {
  const root = makeCheckout();
  const bin = makePnpmStub({ installExit: 42 });

  const result = runBootstrap(root, bin);

  assert.equal(result.status, 42);
  assert.deepEqual(readCalls(root).length, 1);
  assert.doesNotMatch(result.stdout, /worktree-bootstrap: ready/);
});

test("an unknown option is a usage error", () => {
  const root = makeCheckout();
  const bin = makePnpmStub();

  const result = runBootstrap(root, bin, ["--offline-ish"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --offline-ish/);
  assert.deepEqual(readCalls(root), []);
});

test("a directory without the workspace manifests is refused", () => {
  const root = makeCheckout({ workspace: false });
  const bin = makePnpmStub();

  const result = runBootstrap(root, bin);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a Paperclip workspace/);
  assert.deepEqual(readCalls(root), []);
});

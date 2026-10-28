import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BARE_CLI_FILTER_PATTERN,
  collectScannableFiles,
  findBareCliFilterOffenses,
  runCheck,
} from "./check-vitest-project-filter.mjs";

test("pattern matches the bare CLI filter in command forms", () => {
  const cases = [
    "pnpm exec vitest run cli",
    "npx vitest run cli",
    "vitest run cli --reporter=dot",
    "vitest run cli some.test.ts",
    "vitest cli",
    'run: pnpm exec vitest run cli\n',
    '"test": "vitest run cli"',
  ];
  for (const text of cases) {
    assert.ok(BARE_CLI_FILTER_PATTERN.test(text), `expected a match for ${text}`);
  }
});

test("pattern allows explicit project selection and cli/ path filters", () => {
  const cases = [
    "pnpm exec vitest run --project paperclipai",
    "pnpm exec vitest run --project @paperclipai/server server/src/__tests__/a.test.ts",
    "vitest run cli/src/__tests__/context.test.ts",
    "vitest run cli-auth-routes.test.ts",
    "vitest run muse-client-contract.test.ts",
  ];
  for (const text of cases) {
    assert.ok(!BARE_CLI_FILTER_PATTERN.test(text), `unexpected match for ${text}`);
  }
});

test("findBareCliFilterOffenses reports the line that carries the command", () => {
  const text = ["set -euo pipefail", "pnpm exec vitest run cli", "echo done"].join("\n");
  const offenses = findBareCliFilterOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 2);
  assert.equal(offenses[0].line, "pnpm exec vitest run cli");
});

test("runCheck fails a script with a bare filter and passes an explicit project", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "vitest-project-filter-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "scripts/bad.sh"), "pnpm exec vitest run cli\n");
    writeFileSync(
      path.join(tmpRoot, "scripts/good.sh"),
      "pnpm exec vitest run --project paperclipai cli/src/__tests__/a.test.ts\n",
    );

    const quiet = () => {};
    assert.equal(runCheck({ repoRoot: tmpRoot, log: quiet, error: quiet }), 1);

    writeFileSync(path.join(tmpRoot, "scripts/bad.sh"), "pnpm exec vitest run --project paperclipai\n");
    assert.equal(runCheck({ repoRoot: tmpRoot, log: quiet, error: quiet }), 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("collectScannableFiles accepts a single package.json path and skips dependencies", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "vitest-project-filter-files-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts/node_modules/pkg"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "package.json"), "{}\n");
    writeFileSync(path.join(tmpRoot, "scripts/node_modules/pkg/index.js"), "vitest run cli\n");

    const rootFiles = collectScannableFiles(path.join(tmpRoot, "package.json"), tmpRoot);
    assert.deepEqual(
      rootFiles.map((entry) => entry.relative),
      ["package.json"],
    );

    const scriptFiles = collectScannableFiles(path.join(tmpRoot, "scripts"), tmpRoot);
    assert.deepEqual(scriptFiles, []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

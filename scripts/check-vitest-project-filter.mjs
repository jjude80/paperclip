#!/usr/bin/env node
/**
 * check-vitest-project-filter.mjs
 *
 * Static check that rejects a bare `vitest run cli` command in executable
 * surfaces. The positional argument to Vitest is a *test-path substring
 * filter*, not a project selector: `vitest run cli` also matches every
 * `paperclip*` and `*client*` path, so it runs the server, db and UI suites
 * alongside the CLI suite.
 *
 * Measured on master `76c0bbea`: `vitest list cli` selected 106 test files,
 * while `vitest list --project paperclipai` selected the 66 CLI test files.
 * That widened blast radius is what NEXA-582 and NEXA-714 were containing.
 *
 * Scope is command surfaces only -- shell scripts, CI workflows and
 * package.json scripts. Prose that describes the hazard (for example the
 * NEXA-714 regression comment in cli/src/__tests__) is deliberately not
 * scanned: it is not something a reader can execute by copy-paste.
 *
 * The correct forms are:
 *
 *   vitest run --project paperclipai <path>
 *   vitest run --project @paperclipai/server <path>
 *   vitest run --project @paperclipai/ui <path>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCAN_ROOTS = [
  "scripts",
  ".github/workflows",
  "package.json",
  "cli/package.json",
  "server/package.json",
  "ui/package.json",
];

const SCANNABLE_EXTENSIONS = new Set([".sh", ".bash", ".mjs", ".js", ".cjs", ".yml", ".yaml", ".json"]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
  ".git",
]);

const SKIP_FILENAME_SUFFIXES = [".test.mjs", ".test.js", ".test.cjs"];

// This check describes the hazard in its own documentation and fixtures, and
// its fixtures are not command surfaces. Everything else in `scripts/` is.
const SKIP_FILENAMES = new Set(["check-vitest-project-filter.mjs"]);


// A bare `cli` positional (optionally after `run`), not a path beginning with
// `cli/`, and not a longer token such as `cli-auth` or `client`. The trailing
// guard is what keeps `vitest run cli/src/__tests__/x.test.ts` legal.
export const BARE_CLI_FILTER_PATTERN = /\bvitest\s+(?:run\s+)?cli(?![A-Za-z0-9_./-])/;

export function findBareCliFilterOffenses(text) {
  const lines = text.split("\n");
  const offenses = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (BARE_CLI_FILTER_PATTERN.test(lines[index])) {
      offenses.push({ lineNumber: index + 1, line: lines[index].trimEnd() });
    }
  }

  return offenses;
}

function shouldScanFile(relativePath) {
  const base = path.basename(relativePath);
  if (SKIP_FILENAMES.has(base)) return false;
  if (SKIP_FILENAME_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  return SCANNABLE_EXTENSIONS.has(path.extname(relativePath));
}

export function collectScannableFiles(absoluteRoot, repoRoot) {
  const results = [];
  let stats;
  try {
    stats = statSync(absoluteRoot);
  } catch {
    return results;
  }

  if (stats.isFile()) {
    results.push({
      absolute: absoluteRoot,
      relative: path.relative(repoRoot, absoluteRoot).split(path.sep).join("/"),
    });
    return results;
  }
  if (!stats.isDirectory()) return results;

  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
      if (shouldScanFile(relative)) results.push({ absolute, relative });
    }
  }

  return results;
}

export function runCheck({
  repoRoot,
  scanRoots = DEFAULT_SCAN_ROOTS,
  log = console.log,
  error = console.error,
} = {}) {
  const allOffenses = [];

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.resolve(repoRoot, scanRoot);
    const files = collectScannableFiles(absoluteRoot, repoRoot);
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file.absolute, "utf8");
      } catch {
        continue;
      }
      for (const offense of findBareCliFilterOffenses(text)) {
        allOffenses.push({ relative: file.relative, ...offense });
      }
    }
  }

  if (allOffenses.length > 0) {
    error(
      "ERROR: bare `vitest run cli` found. The positional argument is a test-path substring filter, not the CLI project:\n",
    );
    for (const offense of allOffenses) {
      error(`  ${offense.relative}:${offense.lineNumber}: ${offense.line}`);
    }
    error(
      "\nSelect the project explicitly instead:\n" +
        "  pnpm exec vitest run --project paperclipai cli/src/__tests__/some.test.ts\n" +
        "  pnpm exec vitest run --project @paperclipai/server server/src/__tests__/some.test.ts\n" +
        "  pnpm exec vitest run --project @paperclipai/ui ui/src/pages/Some.test.tsx",
    );
    return 1;
  }

  log("  ✓  No bare `vitest run cli` project filter found.");
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repoRoot = process.cwd();
  process.exit(runCheck({ repoRoot }));
}

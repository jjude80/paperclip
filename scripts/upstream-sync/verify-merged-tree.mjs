#!/usr/bin/env node
/**
 * Structural gate for a freshly merged upstream-sync stage.
 *
 * This is the baseline verification command every stage can run without a
 * dependency install. It catches the failures this fork sync is known to
 * produce and that are invisible to a tree-level merge:
 *
 *   - unresolved conflict markers left in tracked files
 *   - duplicate 4-digit migration numbers (the fork's 0381 collides with
 *     upstream's 0381) and a journal that disagrees with the files
 *   - unparseable package.json / malformed workspace manifests
 *   - a missing or obviously broken pnpm lockfile
 *
 * Stage-specific build/typecheck/tests from NEXA-880 run in addition to this.
 *
 * Exit codes: 0 clean, 1 findings, 2 could not inspect.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const findings = [];

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.error) {
    console.error(`could not run git: ${result.error.message}`);
    process.exit(2);
  }
  return result;
}

// 1. Conflict markers in tracked or staged files.
const grep = git(["grep", "-n", "-E", "^(<<<<<<< |>>>>>>> )", "--"]);
if (grep.status === 0) {
  for (const line of grep.stdout.trim().split("\n")) {
    findings.push(`conflict marker: ${line}`);
  }
} else if (grep.status !== 1) {
  findings.push(`git grep failed: ${grep.stderr.trim()}`);
}

// 2. Migration numbering and journal consistency.
const migrationsDir = join(ROOT, "packages", "db", "src", "migrations");
const journalPath = join(migrationsDir, "meta", "_journal.json");
let migrationFiles = [];
try {
  migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
} catch (error) {
  findings.push(`cannot read migrations dir: ${error.message}`);
}

const seenNumbers = new Map();
for (const file of migrationFiles) {
  const match = file.match(/^(\d{4})_/);
  if (!match) {
    findings.push(`migration does not start with a 4-digit number: ${file}`);
    continue;
  }
  const other = seenNumbers.get(match[1]);
  if (other) findings.push(`duplicate migration number ${match[1]}: ${other}, ${file}`);
  else seenNumbers.set(match[1], file);
}

try {
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const tags = (journal.entries ?? []).map((entry) => entry?.tag).filter(Boolean);
  if (tags.length !== migrationFiles.length) {
    findings.push(
      `migration journal/file count mismatch: journal ${tags.length}, files ${migrationFiles.length}`,
    );
  }
  for (let index = 0; index < Math.min(tags.length, migrationFiles.length); index += 1) {
    if (`${tags[index]}.sql` !== migrationFiles[index]) {
      findings.push(
        `migration journal/file order mismatch at ${index}: journal ${tags[index]}.sql, file ${migrationFiles[index]}`,
      );
      break;
    }
  }
} catch (error) {
  findings.push(`cannot read migration journal: ${error.message}`);
}

// 3. Workspace manifests parse.
const manifests = git(["ls-files", "--", "*package.json", ":!**/node_modules/**"]);
if (manifests.status !== 0) {
  findings.push(`cannot list package.json files: ${manifests.stderr.trim()}`);
} else {
  for (const path of manifests.stdout.trim().split("\n").filter(Boolean)) {
    try {
      JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    } catch (error) {
      findings.push(`${path}: ${error.message}`);
    }
  }
}

// 4. Lockfile presence/shape (the replay must not resolve dependencies by hand).
try {
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  if (!/^lockfileVersion:/m.test(lock)) findings.push("pnpm-lock.yaml has no lockfileVersion");
} catch (error) {
  findings.push(`cannot read pnpm-lock.yaml: ${error.message}`);
}

if (findings.length > 0) {
  console.error(`merged-tree check failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(
  `merged-tree check passed (${migrationFiles.length} migrations, no conflict markers, manifests parse)`,
);

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../server/src/home-paths.js";
import {
  collectRunLogLiteralSecrets,
  redactRunLogText,
} from "../server/src/services/run-log-redaction.js";

// One-off remediation for run logs written before write-time redaction landed.
//
// Run logs are NDJSON files that keep raw tool output indefinitely. A log
// written before the sink redacted secrets can contain a credential value for
// as long as the file exists, even after that credential is rotated. This
// command rewrites those files with the same redaction the sink now applies and
// narrows the log tree to owner-only permissions.
//
// It is offline and dry-run by default. Files touched during the last
// `--min-age-minutes` are skipped so a live run is never rewritten underneath
// its writer. Nothing here prints a secret value: the summary counts files and
// bytes only.

const DEFAULT_MIN_AGE_MINUTES = 60;

type Options = {
  root: string;
  apply: boolean;
  minAgeMinutes: number;
};

function parseOptions(argv: string[]): Options {
  const valueAfter = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = valueAfter("--root") ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  const minAgeArg = valueAfter("--min-age-minutes");
  const minAgeMinutes = minAgeArg === undefined ? DEFAULT_MIN_AGE_MINUTES : Number(minAgeArg);
  if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0) {
    throw new Error("--min-age-minutes must be a non-negative number");
  }
  return { root, apply: argv.includes("--apply"), minAgeMinutes };
}

async function walk(current: string, files: string[], dirs: string[]) {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      dirs.push(target);
      await walk(target, files, dirs);
    } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
      files.push(target);
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const literals = await collectRunLogLiteralSecrets();
  const files: string[] = [];
  const dirs: string[] = [];
  await walk(options.root, files, dirs);

  const cutoff = Date.now() - options.minAgeMinutes * 60_000;
  let scanned = 0;
  let skippedRecent = 0;
  let changed = 0;
  let redactedBytes = 0;

  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs > cutoff) {
      skippedRecent += 1;
      continue;
    }
    scanned += 1;
    if (options.apply) await fs.chmod(file, 0o600).catch(() => undefined);
    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (content === null) continue;
    const redacted = redactRunLogText(content, literals);
    if (redacted === content) continue;
    changed += 1;
    redactedBytes += Buffer.byteLength(content, "utf8");
    if (!options.apply) continue;
    // Rewrite in place through a same-directory temporary so a reader never
    // observes a half-written log, and keep owner-only permissions.
    const temporary = `${file}.${process.pid}.redact`;
    try {
      await fs.writeFile(temporary, redacted, { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  if (options.apply) {
    for (const dir of dirs) await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.chmod(options.root, 0o700).catch(() => undefined);
  }

  console.log(
    `${options.apply ? "Redacted" : "Would redact"} ${changed} of ${scanned} run log files ` +
      `(${redactedBytes} bytes) under ${options.root}; skipped ${skippedRecent} recently written files` +
      (options.apply ? "" : "; re-run with --apply to persist changes"),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

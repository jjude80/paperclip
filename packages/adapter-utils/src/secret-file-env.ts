import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SECRET_FILE_CARRIERS } from "@paperclipai/shared/secret-carrier";

/**
 * Materialise NEXA-643's secret carriers as files.
 *
 * The carrier table and the read half live in `@paperclipai/shared/secret-carrier`
 * because the command-line clients that consume them (the connections CLI, the
 * MCP server) do not depend on this package. This module owns the write half.
 */
export type { SecretFileCarrier } from "@paperclipai/shared/secret-carrier";

export { SECRET_FILE_CARRIERS } from "@paperclipai/shared/secret-carrier";

/**
 * Rollback switch. Default is on, because "the values are gone" is the point of
 * the change; `PAPERCLIP_SECRET_FILE_ENV=0` restores the previous env injection
 * without a code change, which is the property the rollback step needs.
 */
export const SECRET_FILE_ENV_FLAG = "PAPERCLIP_SECRET_FILE_ENV";

/** Overrides where the per-run private directories live. */
export const SECRET_FILE_ENV_DIR = "PAPERCLIP_SECRET_FILE_DIR";

const DISABLED_FLAG_VALUES = new Set(["0", "false", "no", "off"]);

export function secretFileEnvEnabled(
  source: Record<string, string | undefined> = process.env,
): boolean {
  const raw = source[SECRET_FILE_ENV_FLAG] ?? process.env[SECRET_FILE_ENV_FLAG];
  if (typeof raw !== "string" || raw.trim().length === 0) return true;
  return !DISABLED_FLAG_VALUES.has(raw.trim().toLowerCase());
}

export function resolveSecretFileBaseDir(
  source: Record<string, string | undefined> = process.env,
): string {
  const configured = source[SECRET_FILE_ENV_DIR] ?? process.env[SECRET_FILE_ENV_DIR];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  return path.join(os.tmpdir(), "paperclip-secret-env");
}

export interface MaterializeSecretFileEnvResult {
  /** The environment to spawn with. Never contains a carrier value. */
  env: Record<string, string>;
  /** The private directory created for this run, or null when nothing was written. */
  dir: string | null;
  /** Carrier keys that were turned into a file path. */
  written: string[];
  /** Carrier keys that had no value in this environment. */
  absent: string[];
}

/**
 * Move every carrier value out of `env` and into a 0600 file in a fresh 0700
 * directory, leaving `<key>_FILE` behind.
 *
 * Fails closed: if a token file cannot be written the caller must not fall back
 * to exporting the value, so this throws rather than returning the input. A run
 * that cannot read its bearer fails loudly; a run that quietly leaks it does not.
 */
export async function materializeSecretFileEnv(input: {
  env: Record<string, string>;
  enabled?: boolean;
  baseDir?: string;
  /** Prefix for the directory name; the random suffix is added by mkdtemp. */
  label?: string;
}): Promise<MaterializeSecretFileEnvResult> {
  const env = { ...input.env };
  const enabled = input.enabled ?? secretFileEnvEnabled(env);
  if (!enabled) {
    return { env, dir: null, written: [], absent: [] };
  }

  const present = SECRET_FILE_CARRIERS.filter((carrier) => {
    const value = env[carrier.key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (present.length === 0) {
    return {
      env,
      dir: null,
      written: [],
      absent: SECRET_FILE_CARRIERS.map((carrier) => carrier.key),
    };
  }

  const baseDir = input.baseDir ? path.resolve(input.baseDir) : resolveSecretFileBaseDir(env);
  await fs.promises.mkdir(baseDir, { recursive: true, mode: 0o700 });
  // mkdir's mode is filtered by the umask, and an existing directory keeps
  // whatever mode it already had. Both are stated here rather than assumed.
  await fs.promises.chmod(baseDir, 0o700);
  const dir = await fs.promises.mkdtemp(path.join(baseDir, `${input.label ?? "run"}-`));
  await fs.promises.chmod(dir, 0o700);

  try {
    for (const carrier of present) {
      const value = env[carrier.key] as string;
      const file = path.join(dir, carrier.fileName);
      // `mode` on write only applies when the file is created; the explicit
      // chmod covers a umask that widened it.
      await fs.promises.writeFile(file, `${value}\n`, { mode: 0o600, flag: "wx" });
      await fs.promises.chmod(file, 0o600);
      env[carrier.fileKey] = file;
      delete env[carrier.key];
    }
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    env,
    dir,
    written: present.map((carrier) => carrier.key),
    absent: SECRET_FILE_CARRIERS.filter((carrier) => !present.includes(carrier)).map(
      (carrier) => carrier.key,
    ),
  };
}

/** Remove one run's private directory. Safe to call with null and safe to repeat. */
export async function disposeSecretFileEnv(dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Remove directories left behind by runs that died before cleanup.
 *
 * A token written here is a live bearer until the run record expires, so the
 * directory is minted per run and deleted when the run ends. A crash skips that
 * delete; this sweep is what keeps the population bounded, and it refuses to
 * follow symlinks out of the base directory.
 */
export async function sweepSecretFileDirs(input: {
  baseDir?: string;
  olderThanMs?: number;
  now?: number;
} = {}): Promise<string[]> {
  const baseDir = input.baseDir ? path.resolve(input.baseDir) : resolveSecretFileBaseDir();
  const olderThanMs = input.olderThanMs ?? 24 * 60 * 60 * 1000;
  const now = input.now ?? Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(baseDir, entry.name);
    try {
      const stat = await fs.promises.lstat(target);
      if (now - stat.mtimeMs < olderThanMs) continue;
      await fs.promises.rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      // A sweep that cannot remove one directory must not stop on it: the
      // alternative is that one stale, unlinkable directory halts all cleanup.
    }
  }
  return removed;
}

export { readSecretCarrier } from "@paperclipai/shared/secret-carrier";

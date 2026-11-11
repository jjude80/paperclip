import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * NEXA-947: a git worktree created for an execution workspace lives in the
 * *shared* `.git`, but git writes those files with the creator's umask. On this
 * host the server runs with `umask 0077`, so the branch ref, `.git/config` and
 * the per-worktree `index` land as `0600 jjude:jjude` with no ACL. The run that
 * receives the workspace then cannot read its own HEAD (`git rev-parse HEAD`
 * dies on `.git/config: Permission denied`) and every sibling agent's fetch
 * aborts on the unreadable ref.
 *
 * Repairing those files one at a time is a treadmill: each new workspace writes
 * new ones. The durable fix is *inheritance* — a default ACL on the shared git
 * directories so every file written there afterwards is readable by the git
 * directory's group, whatever umask the writer used. No per-agent uid list: the
 * group already names every seat, and a list goes stale the moment a seat
 * cycles.
 *
 * Read-only by design. The default entry gives the group `r-x` (traverse for
 * directories, read for files); write access, where a seat needs it, stays a
 * named entry so this function never widens it.
 */

const GIT_METADATA_DIRECTORIES = [
  "",
  "refs",
  "refs/heads",
  "refs/remotes",
  "refs/tags",
  "objects",
  "objects/info",
  "objects/pack",
  "worktrees",
] as const;

/** Files git rewrites after creation, so a one-time grant on them is lost. */
const GIT_METADATA_FILES = ["config", "HEAD", "packed-refs"] as const;

/** Files inside the per-worktree admin directory (`worktrees/<name>/`). */
const WORKTREE_ADMIN_FILES = ["HEAD", "index", "gitdir", "commondir", "ORIG_HEAD"] as const;

/** Bounded walk of `refs/`: refs trees are small, but never scan unbounded. */
const MAX_REF_FILES = 2_000;

export type GitWorktreeSharingStatus =
  /** Default ACLs and readable metadata are in place. */
  | "shared"
  /** Not a git worktree we could resolve; nothing to do. */
  | "not_a_worktree"
  /** `setfacl` is not installed on this host; no ACLs to inherit. */
  | "unsupported"
  /** The attempt ran but at least one operation failed; see `warnings`. */
  | "partial";

export interface GitWorktreeSharingResult {
  status: GitWorktreeSharingStatus;
  commonDir: string | null;
  worktreeGitDir: string | null;
  sharedGroupId: number | null;
  sharedGroupName: string | null;
  directories: string[];
  files: string[];
  warnings: string[];
}

export interface GitWorktreeSharingInput {
  worktreePath: string;
  /** Branch whose ref file should be made readable. Optional. */
  branchName?: string | null;
  /** Test seam. Defaults to `execFile`. */
  runCommand?: (command: string, args: string[], options: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
}

async function readGroupName(gid: number): Promise<string | null> {
  // /etc/group is enough here: the shared group is a local account group, and
  // reading it avoids spawning `getent` in a hot path. Failure is not fatal.
  try {
    return (await fs.readFile("/etc/group", "utf8"))
      .split("\n")
      .map((line) => line.split(":"))
      .find((parts) => parts.length >= 3 && Number(parts[2]) === gid)?.[0] ?? null;
  } catch {
    return null;
  }
}

async function resolveGitPath(
  run: NonNullable<GitWorktreeSharingInput["runCommand"]>,
  worktreePath: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", worktreePath, ...args], { cwd: worktreePath });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function resolveInCommonDir(commonDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(commonDir, value);
}

async function collectRefFiles(commonDir: string): Promise<string[]> {
  const root = path.join(commonDir, "refs");
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < MAX_REF_FILES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(target);
      } else if (entry.isFile() && !entry.name.endsWith(".lock")) {
        files.push(target);
        if (files.length >= MAX_REF_FILES) break;
      }
    }
  }
  return files;
}

async function hasSetfacl(
  run: NonNullable<GitWorktreeSharingInput["runCommand"]>,
): Promise<boolean> {
  try {
    await run("setfacl", ["--version"], {});
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function shareDirectory(
  run: NonNullable<GitWorktreeSharingInput["runCommand"]>,
  directory: string,
  gid: number,
  warnings: string[],
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  if (stat.gid !== gid) {
    try {
      // A directory the creator just made (the per-worktree admin dir) starts
      // in the creator's private group; setgid would then hand that private
      // group to `index` and every later rewrite. Move it first.
      await fs.chown(directory, -1, gid);
    } catch (error) {
      warnings.push(`could not set group ${gid} on ${directory}: ${(error as Error).message}`);
    }
  }
  // Setgid makes new entries inherit the *directory's* group. Without it git
  // creates files in the creator's private group even when the directory is
  // shared, which is exactly how `.git/config` ended up `jjude:jjude`.
  // `fs.constants` does not export `S_ISGID`; use the POSIX bit directly.
  try {
    if ((stat.mode & 0o2000) === 0) {
      await fs.chmod(directory, (stat.mode & 0o7777) | 0o2000);
    }
  } catch (error) {
    warnings.push(`could not set setgid on ${directory}: ${(error as Error).message}`);
  }
  try {
    await run("setfacl", [
      "-m", "g::r-x",
      "-m", "d:u::rwx",
      "-m", "d:g::r-x",
      "-m", "d:m::rwx",
      "-m", "d:o::---",
      directory,
    ], {});
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`could not install read inheritance on ${directory}: ${(error as Error).message}`);
    }
    return false;
  }
}

async function shareFile(
  run: NonNullable<GitWorktreeSharingInput["runCommand"]>,
  file: string,
  gid: number,
  warnings: string[],
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  let changed = false;
  if (stat.gid !== gid) {
    try {
      // Owner may move a file into a group it belongs to; if it cannot, the
      // group read below still leaves the file as it was.
      await fs.chown(file, -1, gid);
      changed = true;
    } catch (error) {
      warnings.push(`could not set group ${gid} on ${file}: ${(error as Error).message}`);
    }
  }
  try {
    // `g::r--` is what an agent that is *not* named in the ACL reads through.
    // `chmod` alone is not enough: on a file whose ACL has `group::---` the
    // group bits only move the mask, so the group still cannot read it.
    await run("setfacl", ["-m", "g::r--", "-m", "m::rw-", file], {});
    changed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`could not make ${file} group readable: ${(error as Error).message}`);
    }
  }
  return changed;
}

/**
 * Install read-only inheritance on the shared git metadata for a worktree and
 * make the metadata files that already exist readable by the git directory's
 * group. Best effort: it never throws, and any failure is reported in
 * `warnings` so workspace creation is not blocked by a host permission policy.
 */
export async function shareGitWorktreeWithGroup(
  input: GitWorktreeSharingInput,
): Promise<GitWorktreeSharingResult> {
  const run = input.runCommand ?? (async (command, args, options) => {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: options.cwd });
    return { stdout, stderr };
  });
  const result: GitWorktreeSharingResult = {
    status: "not_a_worktree",
    commonDir: null,
    worktreeGitDir: null,
    sharedGroupId: null,
    sharedGroupName: null,
    directories: [],
    files: [],
    warnings: [],
  };

  const worktreePath = path.resolve(input.worktreePath);
  const commonDirRaw = await resolveGitPath(run, worktreePath, ["rev-parse", "--git-common-dir"]);
  if (!commonDirRaw) return result;
  const commonDir = path.resolve(worktreePath, commonDirRaw);
  result.commonDir = commonDir;

  let commonStat;
  try {
    commonStat = await fs.stat(commonDir);
  } catch {
    return result;
  }
  const gid = commonStat.gid;
  result.sharedGroupId = gid;
  result.sharedGroupName = await readGroupName(gid);
  result.status = "shared";

  const worktreeGitDirRaw = await resolveGitPath(run, worktreePath, ["rev-parse", "--git-dir"]);
  const worktreeGitDir = worktreeGitDirRaw
    ? resolveInCommonDir(commonDir, worktreeGitDirRaw)
    : null;
  result.worktreeGitDir = worktreeGitDir;

  if (!await hasSetfacl(run)) {
    result.status = "unsupported";
    return result;
  }

  for (const relative of GIT_METADATA_DIRECTORIES) {
    const directory = relative ? path.join(commonDir, relative) : commonDir;
    if (await shareDirectory(run, directory, gid, result.warnings)) result.directories.push(directory);
  }
  // The per-worktree admin dir holds `index`, which git rewrites on the first
  // command after creation, so it needs the default entries too.
  if (worktreeGitDir && worktreeGitDir !== commonDir
    && await shareDirectory(run, worktreeGitDir, gid, result.warnings)) {
    result.directories.push(worktreeGitDir);
  }

  const files = new Set<string>();
  for (const relative of GIT_METADATA_FILES) files.add(path.join(commonDir, relative));
  if (worktreeGitDir) {
    for (const relative of WORKTREE_ADMIN_FILES) files.add(path.join(worktreeGitDir, relative));
  }
  if (input.branchName) files.add(path.join(commonDir, "refs", "heads", input.branchName));
  for (const refFile of await collectRefFiles(commonDir)) files.add(refFile);

  for (const file of files) {
    if (await shareFile(run, file, gid, result.warnings)) result.files.push(file);
  }

  if (result.warnings.length > 0) result.status = "partial";
  return result;
}

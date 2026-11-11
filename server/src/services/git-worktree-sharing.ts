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
 * A default entry only applies to directories created *after* it is installed,
 * so installing it on `refs/heads` and `objects` is not enough: the ref
 * namespaces (`refs/heads/nexa/`, `refs/heads/qa/`, …) and the `objects/??`
 * fan-out directories already exist, and a file written into one of them keeps
 * the writer's umask. Those pre-existing directories are walked and given the
 * same default, once, at realization — after that new ones inherit on their own.
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

/**
 * Bound for the pre-existing directory walk (`refs/**` and the 256 `objects/??`
 * fan-out dirs). Generous next to a real git dir, small enough that a corrupt
 * tree cannot turn workspace creation into a full-filesystem scan.
 */
const MAX_METADATA_DIRECTORIES = 4_096;

/** `setfacl` takes many paths per call; keep the argument list well under ARG_MAX. */
const SETFACL_BATCH_SIZE = 64;

export type GitWorktreeSharingStatus =
  /** Default ACLs and readable metadata are in place. */
  | "shared"
  /** Not a git worktree we could resolve; nothing to do. */
  | "not_a_worktree"
  /**
   * The git dir's group is this process's own group, so there is no second seat
   * to share with. Left untouched: installing `g::r-x` on a private checkout
   * would strip group write a developer may legitimately use.
   */
  | "not_shared"
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
  /**
   * Run even when the git dir's group is this process's own group. Test seam:
   * the fixture is a single-user checkout, but the mechanics still need proof.
   */
  shareOwnGroup?: boolean;
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

/**
 * Directories under `refs/` and `objects/` that already exist. A default ACL is
 * only inherited by entries created after it is installed, so these are the
 * ones that would otherwise keep writing unreadable refs and loose objects:
 * `refs/heads/<namespace>/` and the `objects/??` fan-out dirs. New children
 * inherit from their parent, which is why this is a one-time walk.
 */
async function collectMetadataDirectories(commonDir: string): Promise<string[]> {
  const directories: string[] = [];
  const queue = [path.join(commonDir, "refs"), path.join(commonDir, "objects")];
  while (queue.length > 0 && directories.length < MAX_METADATA_DIRECTORIES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(current, entry.name);
      directories.push(target);
      if (directories.length >= MAX_METADATA_DIRECTORIES) break;
      queue.push(target);
    }
  }
  return directories;
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

/**
 * Put a directory in the shared group and set setgid so entries created in it
 * inherit that group. The ACL itself is installed in batches below: `setfacl`
 * accepts many paths per call, and the walk can cover ~270 directories (the
 * `objects/??` fan-out), so one spawn per directory would add seconds to every
 * workspace realization.
 */
async function prepareDirectory(
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
  return true;
}

const DEFAULT_ACL_ARGS = [
  "-m", "g::r-x",
  "-m", "d:u::rwx",
  "-m", "d:g::r-x",
  "-m", "d:m::rwx",
  "-m", "d:o::---",
] as const;

/**
 * Install read inheritance on prepared directories. Returns the directories the
 * ACLs were actually applied to. A failed batch is retried path by path so one
 * unreadable directory cannot silently skip the other 63.
 */
async function installDefaultAcls(
  run: NonNullable<GitWorktreeSharingInput["runCommand"]>,
  directories: string[],
  warnings: string[],
): Promise<string[]> {
  const applied: string[] = [];
  for (let start = 0; start < directories.length; start += SETFACL_BATCH_SIZE) {
    const batch = directories.slice(start, start + SETFACL_BATCH_SIZE);
    try {
      await run("setfacl", [...DEFAULT_ACL_ARGS, ...batch], {});
      applied.push(...batch);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return applied;
    }
    for (const directory of batch) {
      try {
        await run("setfacl", [...DEFAULT_ACL_ARGS, directory], {});
        applied.push(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warnings.push(`could not install read inheritance on ${directory}: ${(error as Error).message}`);
        }
      }
    }
  }
  return applied;
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

  // A single-user checkout (`jjude:jjude`) has no second seat to share with, and
  // `g::r-x` there would remove group write from a directory the developer may
  // share with a colleague. The host this defect is about runs the server as
  // uid 1000 in group 1000 while the shared `.git` is `jjude:pcagents`, so the
  // real case still proceeds.
  if (!input.shareOwnGroup && typeof process.getegid === "function" && gid === process.getegid()) {
    result.status = "not_shared";
    return result;
  }

  const worktreeGitDirRaw = await resolveGitPath(run, worktreePath, ["rev-parse", "--git-dir"]);
  const worktreeGitDir = worktreeGitDirRaw
    ? resolveInCommonDir(commonDir, worktreeGitDirRaw)
    : null;
  result.worktreeGitDir = worktreeGitDir;

  if (!await hasSetfacl(run)) {
    result.status = "unsupported";
    return result;
  }

  const directories = new Set<string>();
  for (const relative of GIT_METADATA_DIRECTORIES) {
    const directory = relative ? path.join(commonDir, relative) : commonDir;
    directories.add(directory);
  }
  // The per-worktree admin dir holds `index`, which git rewrites on the first
  // command after creation, so it needs the default entries too.
  if (worktreeGitDir && worktreeGitDir !== commonDir) directories.add(worktreeGitDir);
  // Pre-existing ref namespaces and object fan-out dirs do not inherit from
  // their parent retroactively; walk them once so refs and loose objects
  // written into them after this point are readable too.
  for (const directory of await collectMetadataDirectories(commonDir)) directories.add(directory);

  const prepared: string[] = [];
  for (const directory of directories) {
    if (await prepareDirectory(directory, gid, result.warnings)) prepared.push(directory);
  }
  result.directories.push(...await installDefaultAcls(run, prepared, result.warnings));

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

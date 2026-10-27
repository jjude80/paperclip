/**
 * Shared classification of failed `git` invocations.
 *
 * Git's diagnostics are not a stable interface, and a caller that needs to
 * distinguish "this directory is not a repository" from "Git broke" must not
 * pin the whole sentence. Git 2.55 reworded the fatal from
 * `fatal: not a git repository (or any of the parent directories): .git` to
 * `fatal: not a git repository (or any parent up to mount point /)` and added a
 * second line. An exact match on the old sentence then treated every ordinary
 * non-repository directory as a real failure — on the CI runner first, because
 * its image ships the newer Git.
 *
 * Only the stable `fatal:` prefix is matched, and only for a completed process
 * (exit 128, no signal). Callers still decide whether inert `.git` metadata or
 * an explicit `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` makes the answer
 * ambiguous for their own directory.
 */

const NOT_A_REPOSITORY_FATAL = /^fatal: not a git repository\b/m;

function readStderrByteString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/**
 * True when Git ran to completion and reported that the working directory is
 * not inside a repository. Missing Git (`ENOENT`), signals, timeouts, and
 * non-128 failures are deliberately excluded: they are real failures.
 */
export function isCompletedNotAGitRepositoryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; signal?: unknown; stderr?: unknown };
  if (failure.code !== 128 || failure.signal != null) return false;
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return false;
  return NOT_A_REPOSITORY_FATAL.test(readStderrByteString(failure.stderr));
}

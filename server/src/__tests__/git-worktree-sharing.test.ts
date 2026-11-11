import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shareGitWorktreeWithGroup } from "../services/git-worktree-sharing.js";

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd, env });
  return { stdout, stderr };
}

async function git(cwd: string, args: string[]) {
  return (await run("git", args, cwd)).stdout.trim();
}

async function aclOf(target: string): Promise<string> {
  return (await run("getfacl", ["-p", target])).stdout;
}

async function hasHostAclTools(): Promise<boolean> {
  try {
    await run("setfacl", ["--version"]);
    await run("getfacl", ["--version"]);
    return process.platform === "linux";
  } catch {
    return false;
  }
}

/**
 * NEXA-947 regression: the worktree creator writes the branch ref, `.git/config`
 * and the per-worktree `index` with the server's umask. On this host that is
 * `umask 0077`, so the files land unreadable outside the owner and the workspace
 * cannot resolve its own HEAD. The unit under test is the sharing step that runs
 * after the worktree is created; these tests exercise the real git layout so a
 * change that only touches a mock cannot pass.
 *
 * The `second uid` half of the acceptance criteria is exercised when the suite
 * runs with privilege to become another account (`process.getuid() === 0` and a
 * member of the git directory's group). Non-root CI cannot switch uid, so there
 * it checks the property the switch relies on: a file written *after* the fix,
 * under the same `umask 0077`, is group readable and inherits the default ACL.
 */
describe("git worktree sharing", () => {
  let root: string;
  let repoRoot: string;
  let worktreePath: string;
  let branchName: string;
  let aclTools = false;

  beforeAll(async () => {
    aclTools = await hasHostAclTools();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-sharing-"));
    // A seat's temp directory can carry an inherited default ACL; strip it so
    // the fixture starts from a bare checkout and the precondition below is the
    // creator defect, not this runner's own grants.
    await run("setfacl", ["-b", "-k", root]).catch(() => {});
    repoRoot = path.join(root, "repo");
    worktreePath = path.join(root, "wt");
    branchName = "shared-branch";
    await fs.mkdir(repoRoot, { recursive: true });
    await git(repoRoot, ["init", "-b", "main"]);
    await git(repoRoot, ["config", "user.email", "paperclip@example.com"]);
    await git(repoRoot, ["config", "user.name", "Paperclip Test"]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "fixture\n", "utf8");
    await git(repoRoot, ["add", "README.md"]);
    await git(repoRoot, ["commit", "-m", "Initial commit"]);
    // The server writes with `umask 0077`; reproduce that for the creation so
    // the precondition is the real defect and not this test runner's umask.
    await run("sh", ["-c", `umask 077; git worktree add -q -b ${branchName} '${worktreePath}' HEAD`], repoRoot);
    // Directories that already exist when the sharing step runs. A default ACL
    // is only inherited by entries created afterwards, so these keep the writer's
    // umask unless the sharing step walks them: `refs/heads/<namespace>/` is
    // where the rewrite after the first commit lands, and `objects/??` is where
    // every loose object lands.
    await fs.mkdir(path.join(repoRoot, ".git", "refs", "heads", "nexa"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, ".git", "objects", "ab"), { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("reproduces the creator defect before sharing", async () => {
    const commonDir = await git(repoRoot, ["rev-parse", "--git-common-dir"]);
    const ref = path.join(path.resolve(repoRoot, commonDir), "refs", "heads", branchName);
    const stat = await fs.stat(ref);
    expect(stat.mode & 0o040).toBe(0);
    if (aclTools) {
      // No ACL at all, so there is no entry another seat could read through.
      expect(await aclOf(ref)).not.toContain("group::r--");
    }
  });

  it("makes the files written at creation group-readable and inheritable", async () => {
    if (!aclTools) return;
    const commonDir = path.resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim());
    const gitDir = path.resolve(worktreePath, (await git(worktreePath, ["rev-parse", "--git-dir"])).trim());
    const commonStat = await fs.stat(commonDir);
    const ref = path.join(commonDir, "refs", "heads", branchName);

    const result = await shareGitWorktreeWithGroup({ worktreePath, branchName, shareOwnGroup: true });

    expect(result.status).toBe("shared");
    expect(result.sharedGroupId).toBe(commonStat.gid);
    expect(result.commonDir).toBe(commonDir);
    expect(result.warnings).toEqual([]);
    expect(result.directories).toContain(commonDir);
    expect(result.directories).toContain(path.join(commonDir, "refs", "heads"));
    expect(result.directories).toContain(gitDir);
    expect(result.files).toContain(ref);
    expect(result.files).toContain(path.join(commonDir, "config"));
    expect(result.files).toContain(path.join(gitDir, "index"));

    // The files the workspace cannot read today.
    for (const file of [ref, path.join(commonDir, "config"), path.join(gitDir, "index")]) {
      const stat = await fs.stat(file);
      expect(stat.gid, `${file} group`).toBe(commonStat.gid);
      expect(stat.mode & 0o040, `${file} group read`).not.toBe(0);
      expect(await aclOf(file)).toContain("group::r--");
    }

    // Inheritance, not a one-time grant: the ref is rewritten by every commit.
    for (const directory of [commonDir, path.join(commonDir, "refs", "heads"), gitDir]) {
      const acl = await aclOf(directory);
      expect(acl, `${directory} default group`).toContain("default:group::r-x");
      expect(acl, `${directory} default mask`).toContain("default:mask::rwx");
      expect((await fs.stat(directory)).mode & 0o2000, `${directory} setgid`).not.toBe(0);
    }

    // A second agent's `git rev-parse HEAD` must resolve inside the worktree.
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(
      await git(repoRoot, ["rev-parse", "main"]),
    );

    // `index` is rewritten by the very first git command, so the grant has to
    // survive a rewrite. This is the file NEXA-946 measured as lost.
    await git(worktreePath, ["status", "--porcelain"]);
    const rewrittenIndex = await fs.stat(path.join(gitDir, "index"));
    expect(rewrittenIndex.gid).toBe(commonStat.gid);
    expect(rewrittenIndex.mode & 0o040).not.toBe(0);
  });

  it("inherits group read for refs written afterwards under umask 0077", async () => {
    if (!aclTools) return;
    const commonDir = path.resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim());
    const commonStat = await fs.stat(commonDir);
    const later = path.join(commonDir, "refs", "heads", "later-ref");
    await run("sh", ["-c", `umask 077; printf '%s\\n' '${await git(repoRoot, ["rev-parse", "HEAD"])}' > '${later}'`]);

    const stat = await fs.stat(later);
    expect(stat.gid).toBe(commonStat.gid);
    expect(stat.mode & 0o040).not.toBe(0);
    expect(await aclOf(later)).toMatch(/^group::r-x\s+#effective:r--$/m);
  });

  it("installs inheritance on pre-existing ref namespaces and object fan-out dirs", async () => {
    if (!aclTools) return;
    const commonDir = path.resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim());
    const group = (await fs.stat(commonDir)).gid;

    // These existed before the sharing step, so a default on `refs/heads` and
    // `objects` was not inherited by them. Without the walk they stay bare.
    for (const relative of ["refs/heads/nexa", "objects/ab"]) {
      const directory = path.join(commonDir, relative);
      expect((await fs.stat(directory)).gid, `${directory} group`).toBe(group);
      expect(await aclOf(directory), `${directory} default group`).toContain("default:group::r-x");
    }

    const head = await git(repoRoot, ["rev-parse", "HEAD"]);
    // A ref written into the pre-existing namespace after the fix: this is what
    // the first commit in a workspace does.
    const namespacedRef = path.join(commonDir, "refs", "heads", "nexa", "later-ref");
    await run("sh", ["-c", `umask 077; printf '%s\\n' '${head}' > '${namespacedRef}'`]);
    const refStat = await fs.stat(namespacedRef);
    expect(refStat.gid).toBe(group);
    expect(refStat.mode & 0o040).not.toBe(0);

    // A loose object written into the pre-existing fan-out dir.
    const looseObject = path.join(commonDir, "objects", "ab", "later-object");
    await run("sh", ["-c", `umask 077; printf 'fixture\\n' > '${looseObject}'`]);
    const objectStat = await fs.stat(looseObject);
    expect(objectStat.gid).toBe(group);
    expect(objectStat.mode & 0o040).not.toBe(0);
  });

  it("skips without POSIX ACLs instead of failing workspace creation", async () => {
    const result = await shareGitWorktreeWithGroup({ worktreePath, shareOwnGroup: true });
    if (aclTools) {
      expect(result.status).toBe("shared");
      return;
    }
    expect(result.status).toBe("unsupported");
    expect(result.warnings).toEqual([]);
  });

  it("leaves a single-user checkout alone", async () => {
    const commonDir = path.resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim());
    const result = await shareGitWorktreeWithGroup({ worktreePath });
    if ((await fs.stat(commonDir)).gid === process.getegid?.()) {
      // No second seat to share with; do not strip group write for a colleague.
      expect(result.status).toBe("not_shared");
      expect(result.directories).toEqual([]);
      expect(result.files).toEqual([]);
    } else {
      expect(result.status).toBe("shared");
    }
  });

  // The acceptance property: a second uid that is a member of the git
  // directory's group reads the metadata the created workspace needs. CI runs
  // unprivileged and cannot switch uid, so this is skipped there rather than
  // faked; the test above still proves the inheritance it depends on.
  it.skipIf(process.getuid?.() !== 0)("is readable as a second uid in the shared group", async () => {
    const commonDir = path.resolve(repoRoot, (await git(repoRoot, ["rev-parse", "--git-common-dir"])).trim());
    const gid = (await fs.stat(commonDir)).gid;
    const members = (await run("getent", ["group", String(gid)]).catch(() => ({ stdout: "" })))
      .stdout.trim().split(":")[3]?.split(",").filter(Boolean) ?? [];
    const account = members[0];
    expect(account, `group ${gid} must name a second account`).toBeTruthy();
    const mainSha = await git(repoRoot, ["rev-parse", "main"]);
    const refFile = path.join(commonDir, "refs", "heads", branchName);
    const asSecondUid = async (args: string[]) => (await run(
      "setpriv",
      [`--reuid=${account}`, `--regid=${gid}`, `--clear-groups`, ...args],
      worktreePath,
    )).stdout;
    expect(await asSecondUid(["cat", path.join(commonDir, "config")])).toContain("[core]");
    expect((await asSecondUid(["cat", refFile])).trim()).toBe(mainSha);
    expect((await asSecondUid(["git", "-c", "safe.directory=*", "rev-parse", "HEAD"])).trim()).toBe(mainSha);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { isCompletedNotAGitRepositoryFailure } from "./git-command-failure.js";

function gitFailure(stderr: string, overrides: Record<string, unknown> = {}) {
  return { code: 128, signal: null, stderr, ...overrides };
}

describe("isCompletedNotAGitRepositoryFailure", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("recognizes the pre-2.55 fatal", () => {
    expect(isCompletedNotAGitRepositoryFailure(
      gitFailure("fatal: not a git repository (or any of the parent directories): .git\n"),
    )).toBe(true);
  });

  it("recognizes the Git 2.55 fatal, including its filesystem-boundary line", () => {
    expect(isCompletedNotAGitRepositoryFailure(gitFailure(
      "fatal: not a git repository (or any parent up to mount point /)\n" +
      "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n",
    ))).toBe(true);
  });

  it("recognizes a Buffer stderr", () => {
    expect(isCompletedNotAGitRepositoryFailure(
      gitFailure(Buffer.from("fatal: not a git repository\n") as unknown as string),
    )).toBe(true);
  });

  it.each([
    ["a different fatal", gitFailure("fatal: bad object HEAD\n")],
    ["a permission error", gitFailure("fatal: cannot open .git: Permission denied\n")],
    ["a failed process", gitFailure("fatal: not a git repository\n", { code: 1 })],
    ["a signalled process", gitFailure("fatal: not a git repository\n", { signal: "SIGTERM" })],
    ["missing Git", Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })],
    ["no stderr", gitFailure("")],
  ])("rejects %s", (_label, failure) => {
    expect(isCompletedNotAGitRepositoryFailure(failure)).toBe(false);
  });

  it.each(["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])(
    "rejects when %s makes the probe ambiguous",
    (name) => {
      vi.stubEnv(name, "/tmp/somewhere-else");
      expect(isCompletedNotAGitRepositoryFailure(gitFailure("fatal: not a git repository\n"))).toBe(false);
    },
  );
});

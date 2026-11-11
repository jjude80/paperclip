import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import { dbBackupCommand } from "../commands/db-backup.js";

const db = vi.hoisted(() => ({
  runDatabaseBackup: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  runDatabaseBackup: db.runDatabaseBackup,
  formatDatabaseBackupResult: () => "paperclip-20260101-120000.sql.gz (1.0 MB)",
  embeddedPostgresUrl: () => "postgres://embedded@localhost:54329/paperclip",
  resolveEmbeddedPostgresDataDir: () => "/var/tmp/embedded-postgres",
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { message: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("../config/home.js", () => ({
  expandHomePrefix: (value: string) => value,
  resolveDefaultBackupDir: () => "/var/tmp/paperclip-backups",
  resolvePaperclipInstanceId: () => "default",
}));

vi.mock("../config/store.js", () => ({
  readConfig: () => null,
  resolveConfigPath: () => "/var/tmp/paperclip.json",
}));

const backupResult = {
  backupFile: "/var/tmp/paperclip-backups/paperclip-20260101-120000.sql.gz",
  sizeBytes: 1048576,
  prunedCount: 2,
};

describe("db:backup --json", () => {
  let stdout: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    stdout = "";
    delete process.env.DATABASE_URL;
    db.runDatabaseBackup.mockReset();
    vi.mocked(prompts.spinner).mockClear();
    vi.mocked(prompts.intro).mockClear();
    vi.mocked(prompts.outro).mockClear();
    vi.mocked(prompts.log.message).mockClear();
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      stdout += `${args.map(String).join(" ")}\n`;
    });
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    logSpy.mockRestore();
  });

  it("writes a single JSON document to stdout and nothing else", async () => {
    db.runDatabaseBackup.mockResolvedValue(backupResult);

    await dbBackupCommand({ json: true });

    // The whole stream must parse. Any banner, spinner or log line on stdout
    // fails here, which is the defect this test exists for.
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({
      backupFile: backupResult.backupFile,
      sizeBytes: backupResult.sizeBytes,
      prunedCount: backupResult.prunedCount,
      backupDir: "/var/tmp/paperclip-backups",
      retentionDays: 30,
      connectionSource: "embedded-postgres@54329",
    });
    expect(stdout.trimStart().startsWith("{")).toBe(true);
  });

  it("does not start the interactive banner, prompts or spinner in JSON mode", async () => {
    db.runDatabaseBackup.mockResolvedValue(backupResult);

    await dbBackupCommand({ json: true });

    expect(prompts.spinner).not.toHaveBeenCalled();
    expect(prompts.intro).not.toHaveBeenCalled();
    expect(prompts.outro).not.toHaveBeenCalled();
    expect(prompts.log.message).not.toHaveBeenCalled();
  });

  it("keeps stdout empty when the backup fails", async () => {
    db.runDatabaseBackup.mockRejectedValue(new Error("pg_dump failed"));

    await expect(dbBackupCommand({ json: true })).rejects.toThrow("pg_dump failed");
    expect(stdout).toBe("");
  });

  it("still reports progress when --json is absent", async () => {
    db.runDatabaseBackup.mockResolvedValue(backupResult);

    await dbBackupCommand({});

    // Human mode still gets the banner and the interactive progress UI.
    expect(prompts.spinner).toHaveBeenCalled();
    expect(prompts.intro).toHaveBeenCalled();
    expect(prompts.outro).toHaveBeenCalled();
    expect(stdout.trimStart().startsWith("{")).toBe(false);
  });
});

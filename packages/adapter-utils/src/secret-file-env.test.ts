import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SECRET_FILE_CARRIERS,
  disposeSecretFileEnv,
  materializeSecretFileEnv,
  readSecretCarrier,
  resolveSecretFileBaseDir,
  secretFileEnvEnabled,
  sweepSecretFileDirs,
} from "./secret-file-env.js";

const CARRIER_ENV = {
  PAPERCLIP_API_KEY: "board-jwt-value",
  PAPERCLIP_RUNTIME_TOOLS_TOKEN: "runtime-tools-value",
  PAPERCLIP_GITHUB_BROKER_TOKEN: "broker-value",
  PAPERCLIP_AGENT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nidentity\n-----END PRIVATE KEY-----",
};

async function mode(target: string): Promise<string> {
  const stat = await fs.stat(target);
  return (stat.mode & 0o777).toString(8).padStart(4, "0");
}

describe("materializeSecretFileEnv", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-secret-env-test-"));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("replaces every carrier value with a 0600 file and leaves no value behind", async () => {
    const result = await materializeSecretFileEnv({ env: { ...CARRIER_ENV }, baseDir });

    for (const carrier of SECRET_FILE_CARRIERS) {
      expect(result.env[carrier.key]).toBeUndefined();
      const file = result.env[carrier.fileKey];
      expect(file, `${carrier.fileKey} should be a path`).toBeTruthy();
      expect(path.dirname(file as string)).toBe(result.dir);
      expect(await fs.readFile(file as string, "utf8")).toBe(`${CARRIER_ENV[carrier.key as keyof typeof CARRIER_ENV]}\n`);
      expect(await mode(file as string)).toBe("0600");
    }
    expect(await mode(result.dir as string)).toBe("0700");
    // Nothing that looks like a bearer value survives anywhere in the env.
    expect(JSON.stringify(result.env)).not.toContain("board-jwt-value");
    expect(JSON.stringify(result.env)).not.toContain("runtime-tools-value");
    expect(JSON.stringify(result.env)).not.toContain("broker-value");
    expect(JSON.stringify(result.env)).not.toContain("BEGIN PRIVATE KEY");
  }, 15_000);

  it("uses the names the already-shipped consumers read", async () => {
    const result = await materializeSecretFileEnv({ env: { ...CARRIER_ENV }, baseDir });
    expect(result.env.PAPERCLIP_API_TOKEN_FILE).toBeTruthy();
    expect(result.env.PAPERCLIP_API_KEY_FILE).toBeUndefined();
    expect(result.env.PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE).toBeTruthy();
    expect(result.env.PAPERCLIP_GITHUB_BROKER_TOKEN_FILE).toBeTruthy();
    expect(result.env.PAPERCLIP_AGENT_PRIVATE_KEY_FILE).toBeTruthy();
  }, 15_000);

  it("leaves the environment alone when the rollback flag is set", async () => {
    const result = await materializeSecretFileEnv({
      env: { ...CARRIER_ENV, PAPERCLIP_SECRET_FILE_ENV: "0" },
      baseDir,
    });
    expect(result.env).toEqual({ ...CARRIER_ENV, PAPERCLIP_SECRET_FILE_ENV: "0" });
    expect(result.dir).toBeNull();
    expect(await fs.readdir(baseDir)).toEqual([]);
  });

  it("does not create a directory when no carrier has a value", async () => {
    const result = await materializeSecretFileEnv({ env: { PAPERCLIP_API_URL: "http://x" }, baseDir });
    expect(result.dir).toBeNull();
    expect(result.written).toEqual([]);
    expect(result.absent).toEqual(SECRET_FILE_CARRIERS.map((carrier) => carrier.key));
    expect(await fs.readdir(baseDir)).toEqual([]);
  });

  it("writes only the carriers that are present and reports the rest as absent", async () => {
    const result = await materializeSecretFileEnv({
      env: { PAPERCLIP_API_KEY: "only-board" },
      baseDir,
    });
    expect(result.written).toEqual(["PAPERCLIP_API_KEY"]);
    expect(result.absent).toEqual([
      "PAPERCLIP_RUNTIME_TOOLS_TOKEN",
      "PAPERCLIP_GITHUB_BROKER_TOKEN",
      "PAPERCLIP_AGENT_PRIVATE_KEY",
    ]);
    await expect(fs.stat(path.join(result.dir as string, "github-broker-token"))).rejects.toThrow();
  });

  it("fails closed instead of handing the value back when the file cannot be written", async () => {
    // A regular file where the base directory belongs: mkdir cannot succeed, and
    // the caller must see the failure rather than a value still in `env`.
    const notADirectory = path.join(baseDir, "not-a-directory");
    await fs.writeFile(notADirectory, "x");
    await expect(
      materializeSecretFileEnv({ env: { ...CARRIER_ENV }, baseDir: notADirectory }),
    ).rejects.toThrow();
    expect(await fs.readFile(notADirectory, "utf8")).toBe("x");
  });

  it("is repeatable: two runs never share a directory", async () => {
    const first = await materializeSecretFileEnv({ env: { ...CARRIER_ENV }, baseDir });
    const second = await materializeSecretFileEnv({ env: { ...CARRIER_ENV }, baseDir });
    expect(first.dir).not.toBe(second.dir);
    expect(first.env.PAPERCLIP_API_TOKEN_FILE).not.toBe(second.env.PAPERCLIP_API_TOKEN_FILE);
  });
});

describe("disposeSecretFileEnv", () => {
  it("removes the directory and tolerates null or a second call", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-secret-env-test-"));
    const result = await materializeSecretFileEnv({ env: { ...CARRIER_ENV }, baseDir });
    await disposeSecretFileEnv(result.dir);
    await expect(fs.stat(result.dir as string)).rejects.toThrow();
    await disposeSecretFileEnv(result.dir);
    await disposeSecretFileEnv(null);
    await fs.rm(baseDir, { recursive: true, force: true });
  });
});

describe("sweepSecretFileDirs", () => {
  it("removes directories older than the cutoff and keeps the rest", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-secret-env-test-"));
    const stale = path.join(baseDir, "run-stale");
    const fresh = path.join(baseDir, "run-fresh");
    await fs.mkdir(stale, { mode: 0o700 });
    await fs.mkdir(fresh, { mode: 0o700 });
    const now = Date.now();
    await fs.utimes(stale, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000));

    const removed = await sweepSecretFileDirs({ baseDir, olderThanMs: 24 * 60 * 60 * 1000, now });

    expect(removed).toEqual([stale]);
    await expect(fs.stat(stale)).rejects.toThrow();
    expect(await fs.stat(fresh)).toBeTruthy();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("returns an empty list when the base directory does not exist", async () => {
    expect(await sweepSecretFileDirs({ baseDir: path.join(os.tmpdir(), "paperclip-missing-base") })).toEqual([]);
  });
});

describe("secretFileEnvEnabled", () => {
  it.each([
    [undefined, true],
    ["1", true],
    ["true", true],
    ["0", false],
    ["off", false],
    ["false", false],
    ["", true],
  ])("%s -> %s", (raw, expected) => {
    expect(secretFileEnvEnabled(raw === undefined ? {} : { PAPERCLIP_SECRET_FILE_ENV: raw })).toBe(expected);
  });
});

describe("resolveSecretFileBaseDir", () => {
  it("honours the override and otherwise uses a private path under the temp root", () => {
    expect(resolveSecretFileBaseDir({ PAPERCLIP_SECRET_FILE_DIR: "/srv/secret-env" })).toBe(
      "/srv/secret-env",
    );
    expect(resolveSecretFileBaseDir({})).toBe(path.join(os.tmpdir(), "paperclip-secret-env"));
  });
});

describe("readSecretCarrier", () => {
  const carrier = { key: "PAPERCLIP_API_KEY", fileKey: "PAPERCLIP_API_TOKEN_FILE" };

  it("prefers the file and falls back to the legacy value", () => {
    expect(readSecretCarrier({ PAPERCLIP_API_TOKEN_FILE: "/tmp/x" }, carrier, () => "from-file\n")).toBe(
      "from-file",
    );
    expect(readSecretCarrier({ PAPERCLIP_API_KEY: "legacy" }, carrier, () => "")).toBe("legacy");
    expect(readSecretCarrier({}, carrier, () => "")).toBeNull();
  });
});

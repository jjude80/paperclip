import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_PASSWORD_FILENAME,
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  embeddedPostgresPasswordPath,
  embeddedPostgresUrl,
  generateEmbeddedPostgresPassword,
  persistEmbeddedPostgresPassword,
  resolveEmbeddedPostgresCredentials,
  resolveEmbeddedPostgresInitialisationPassword,
  rotateEmbeddedPostgresPassword,
} from "./embedded-postgres-credentials.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

function createTempDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pg-credentials-"));
  const dataDir = path.join(root, "db");
  fs.mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return dataDir;
}

describe("embedded postgres credentials", () => {
  it("keeps the password file inside the cluster data directory", () => {
    const dataDir = createTempDataDir();
    expect(embeddedPostgresPasswordPath(dataDir)).toBe(
      path.join(dataDir, EMBEDDED_POSTGRES_PASSWORD_FILENAME),
    );
  });

  it("falls back to the legacy password only while no credential file exists", () => {
    const dataDir = createTempDataDir();
    expect(resolveEmbeddedPostgresCredentials(dataDir)).toEqual({
      user: "paperclip",
      password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
      source: "legacy",
    });

    persistEmbeddedPostgresPassword(dataDir, "generated-value");

    expect(resolveEmbeddedPostgresCredentials(dataDir)).toEqual({
      user: "paperclip",
      password: "generated-value",
      source: "file",
    });
    expect(embeddedPostgresUrl({ dataDir, port: 54329, database: "paperclip" })).toBe(
      "postgres://paperclip:generated-value@127.0.0.1:54329/paperclip",
    );
  });

  it("writes the credential file with mode 0600 and no group/world access", () => {
    const dataDir = createTempDataDir();
    persistEmbeddedPostgresPassword(dataDir, "generated-value");

    const stat = fs.statSync(embeddedPostgresPasswordPath(dataDir));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("repairs a credential file that became group/world readable", () => {
    const dataDir = createTempDataDir();
    persistEmbeddedPostgresPassword(dataDir, "generated-value");
    fs.chmodSync(embeddedPostgresPasswordPath(dataDir), 0o644);

    resolveEmbeddedPostgresCredentials(dataDir);

    const stat = fs.statSync(embeddedPostgresPasswordPath(dataDir));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite a different stored password", () => {
    const dataDir = createTempDataDir();
    persistEmbeddedPostgresPassword(dataDir, "first-value");

    expect(() => persistEmbeddedPostgresPassword(dataDir, "second-value")).toThrow(
      /different credential is already stored/,
    );
    // Persisting the same value again is a no-op, not an error.
    expect(() => persistEmbeddedPostgresPassword(dataDir, "first-value")).not.toThrow();
  });

  it("reuses the stored password when a fresh cluster already has one", () => {
    const dataDir = createTempDataDir();
    persistEmbeddedPostgresPassword(dataDir, "stored-value");

    expect(resolveEmbeddedPostgresInitialisationPassword(dataDir)).toBe("stored-value");
  });

  it("generates a long random password when the cluster has none", () => {
    const dataDir = createTempDataDir();
    const first = resolveEmbeddedPostgresInitialisationPassword(dataDir);
    const second = resolveEmbeddedPostgresInitialisationPassword(dataDir);

    expect(first).not.toBe("paperclip");
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(first).not.toBe(second);
    // Reading the initialisation password must not persist it: initdb has not
    // run yet, so the data directory has to stay usable for initdb.
    expect(fs.readdirSync(dataDir)).toEqual([]);
  });

  it("URL-encodes a password containing reserved characters", () => {
    const dataDir = createTempDataDir();
    persistEmbeddedPostgresPassword(dataDir, "a/b+c=d@e");

    expect(embeddedPostgresUrl({ dataDir, port: 54329, database: "postgres" })).toBe(
      "postgres://paperclip:a%2Fb%2Bc%3Dd%40e@127.0.0.1:54329/postgres",
    );
  });

  it("never returns the legacy password twice in a row", () => {
    const password = generateEmbeddedPostgresPassword();
    expect(password).not.toBe(generateEmbeddedPostgresPassword());
    expect(password).not.toBe(LEGACY_EMBEDDED_POSTGRES_PASSWORD);
  });
});

type LegacyCluster = {
  dataDir: string;
  port: number;
  stop: () => Promise<void>;
};

/**
 * Builds the exact pre-NEXA-749 shape: a cluster initialised with the shipped
 * literal and no credential file.
 */
async function startLegacyCluster(): Promise<LegacyCluster> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  const dataDir = createTempDataDir();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  const stop = async () => {
    await instance.stop().catch(() => undefined);
  };
  cleanups.push(stop);
  return { dataDir, port, stop };
}

describeEmbeddedPostgres("embedded postgres credential rotation", () => {
  it(
    "rotates a legacy cluster onto a generated password and the legacy literal stops working",
    async () => {
      const cluster = await startLegacyCluster();

      const rotated = await rotateEmbeddedPostgresPassword({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(rotated.source).toBe("file");
      expect(rotated.password).not.toBe(LEGACY_EMBEDDED_POSTGRES_PASSWORD);
      expect(fs.statSync(embeddedPostgresPasswordPath(cluster.dataDir)).mode & 0o777).toBe(0o600);

      const newUrl = embeddedPostgresUrl({
        dataDir: cluster.dataDir,
        port: cluster.port,
        database: "postgres",
      });
      const sql = postgres(newUrl, { max: 1, onnotice: () => {} });
      try {
        await expect(sql`select 1 as ok`).resolves.toBeDefined();
      } finally {
        await sql.end({ timeout: 5 });
      }

      const legacyUrl = `postgres://paperclip:${LEGACY_EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${cluster.port}/postgres`;
      const legacy = postgres(legacyUrl, { max: 1, onnotice: () => {} });
      try {
        await expect(legacy`select 1 as ok`).rejects.toMatchObject({ code: "28P01" });
      } finally {
        await legacy.end({ timeout: 5 });
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "is a no-op once a credential file exists",
    async () => {
      const cluster = await startLegacyCluster();
      const first = await rotateEmbeddedPostgresPassword({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });
      const second = await rotateEmbeddedPostgresPassword({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(second.password).toBe(first.password);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "fails loudly without writing a file when the legacy password is rejected",
    async () => {
      const { default: EmbeddedPostgres } = await import("embedded-postgres");
      await prepareEmbeddedPostgresNativeRuntime();
      const dataDir = createTempDataDir();
      const port = 20000 + Math.floor(Math.random() * 20000);
      const instance = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "paperclip",
        password: "not-the-legacy-literal",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
        onLog: () => {},
        onError: () => {},
      });
      await instance.initialise();
      await instance.start();
      cleanups.push(async () => {
        await instance.stop().catch(() => undefined);
      });

      await expect(
        rotateEmbeddedPostgresPassword({ dataDir, port }),
      ).rejects.toMatchObject({ code: "28P01" });
      expect(fs.existsSync(embeddedPostgresPasswordPath(dataDir))).toBe(false);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});

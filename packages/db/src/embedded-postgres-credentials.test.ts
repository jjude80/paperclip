import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_PASSWORD_FILENAME,
  EMBEDDED_POSTGRES_ADMIN_PASSWORD_FILENAME,
  EMBEDDED_POSTGRES_ADMIN_USER,
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  embeddedPostgresPasswordPath,
  embeddedPostgresAdminPasswordPath,
  embeddedPostgresUrl,
  embeddedPostgresAdminUrl,
  generateEmbeddedPostgresPassword,
  persistEmbeddedPostgresPassword,
  persistEmbeddedPostgresAdminPassword,
  resolveEmbeddedPostgresCredentials,
  resolveEmbeddedPostgresAdminCredentials,
  resolveEmbeddedPostgresInitialisationPassword,
  resolveEmbeddedPostgresAdminInitialisationPassword,
  rotateEmbeddedPostgresPassword,
  embeddedPostgresHbaPath,
  ensureEmbeddedPostgresScramAuth,
  ensureEmbeddedPostgresAdminRole,
  restrictEmbeddedPostgresApplicationRole,
  provisionEmbeddedPostgresApplicationRole,
  roleAttributeRestoreClauses,
  suppressCredentialStatementLogging,
  planCleartextAuthRewrite,
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

describe("embedded postgres admin credentials", () => {
  it("keeps the admin credential inside the cluster data directory", () => {
    const dataDir = createTempDataDir();
    expect(embeddedPostgresAdminPasswordPath(dataDir)).toBe(
      path.join(dataDir, EMBEDDED_POSTGRES_ADMIN_PASSWORD_FILENAME),
    );
  });

  it("reports no admin credential until control 2 has created one", () => {
    const dataDir = createTempDataDir();
    expect(resolveEmbeddedPostgresAdminCredentials(dataDir)).toBeNull();
    expect(() => embeddedPostgresAdminUrl({ dataDir, port: 54329, database: "postgres" })).toThrow(
      /No embedded PostgreSQL administrative credential/,
    );
  });

  it("stores the bootstrap admin credential at 0600 and refuses to overwrite it", () => {
    const dataDir = createTempDataDir();
    persistEmbeddedPostgresAdminPassword(dataDir, "admin-first-value");

    expect(fs.statSync(embeddedPostgresAdminPasswordPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(resolveEmbeddedPostgresAdminCredentials(dataDir)).toEqual({
      user: EMBEDDED_POSTGRES_ADMIN_USER,
      password: "admin-first-value",
    });
    expect(() => persistEmbeddedPostgresAdminPassword(dataDir, "admin-second-value")).toThrow(
      /different credential is already stored/,
    );
  });

  it("generates and reuses the bootstrap admin initialisation password", () => {
    const dataDir = createTempDataDir();
    const generated = resolveEmbeddedPostgresAdminInitialisationPassword(dataDir);
    expect(generated).not.toBe(EMBEDDED_POSTGRES_ADMIN_USER);
    expect(generated.length).toBeGreaterThanOrEqual(40);
    // Reading it must not persist it: initdb has not run yet.
    expect(fs.readdirSync(dataDir)).toEqual([]);

    persistEmbeddedPostgresAdminPassword(dataDir, generated);
    expect(resolveEmbeddedPostgresAdminInitialisationPassword(dataDir)).toBe(generated);
  });
});

describe("application-role rollback planning (NEXA-814)", () => {
  it("restores only the attributes the restriction actually removed", () => {
    // Prior non-bootstrap shape: only CREATEROLE was taken away.
    expect(
      roleAttributeRestoreClauses({ rolsuper: false, rolcreaterole: true }, false),
    ).toEqual(["CREATEROLE"]);
    // Prior non-bootstrap superuser: only SUPERUSER was taken away.
    expect(
      roleAttributeRestoreClauses({ rolsuper: true, rolcreaterole: false }, false),
    ).toEqual(["SUPERUSER"]);
    // Bootstrap superuser: SUPERUSER is untouchable, so only CREATEROLE returns.
    expect(
      roleAttributeRestoreClauses({ rolsuper: true, rolcreaterole: true }, true),
    ).toEqual(["CREATEROLE"]);
    // Nothing was removed: a rollback must grant nothing.
    expect(
      roleAttributeRestoreClauses({ rolsuper: true, rolcreaterole: false }, true),
    ).toEqual([]);
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

/**
 * A legacy cluster whose server stderr is captured, for assertions about what
 * PostgreSQL writes to its log.
 */
async function startLegacyClusterWithLogs(): Promise<LegacyCluster & { logs: string[] }> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  const dataDir = createTempDataDir();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const logs: string[] = [];
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message) => logs.push(String(message)),
    onError: (message) => logs.push(String(message)),
  });
  await instance.initialise();
  await instance.start();
  const stop = async () => {
    await instance.stop().catch(() => undefined);
  };
  cleanups.push(stop);
  return { dataDir, port, stop, logs };
}

async function startAdminBootstrappedCluster(): Promise<LegacyCluster> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  const dataDir = createTempDataDir();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const adminPassword = resolveEmbeddedPostgresAdminInitialisationPassword(dataDir);
  const applicationPassword = resolveEmbeddedPostgresInitialisationPassword(dataDir);
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: EMBEDDED_POSTGRES_ADMIN_USER,
    password: adminPassword,
    port,
    persistent: false,
    authMethod: "scram-sha-256" as const,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  persistEmbeddedPostgresAdminPassword(dataDir, adminPassword);
  persistEmbeddedPostgresPassword(dataDir, applicationPassword);
  await instance.start();
  const stop = async () => {
    await instance.stop().catch(() => undefined);
  };
  cleanups.push(stop);
  return { dataDir, port, stop };
}


const LEGACY_HBA = `# PostgreSQL Client Authentication Configuration File
# TYPE  DATABASE        USER            ADDRESS                 METHOD

local   all             all                                     password
host    all             all             127.0.0.1/32            password
host    all             all             ::1/128                 password
local   replication     all                                     password
host    replication     all             127.0.0.1/32            password
host    replication     all             ::1/128                 password

# Other methods are not ours to change.
local   all             postgres                                peer
host    all             all             10.0.0.0/8              trust
host    all             all             192.168.0.0/16          md5
`;

describe("cleartext pg_hba.conf rewrite", () => {
  it("moves every cleartext password rule to scram-sha-256 and nothing else", () => {
    const plan = planCleartextAuthRewrite(LEGACY_HBA);

    expect(plan.rewrittenLines).toBe(6);
    expect(plan.contents).not.toMatch(/\bpassword\b\s*$/m);
    expect(plan.contents).not.toContain("password");
    // Untouched methods stay exactly as they were.
    expect(plan.contents).toContain("local   all             postgres                                peer");
    expect(plan.contents).toContain("host    all             all             10.0.0.0/8              trust");
    expect(plan.contents).toContain("host    all             all             192.168.0.0/16          md5");
    // Spacing and comments are preserved, so the change reads as a one-token diff.
    expect(plan.contents).toContain(
      "local   all             all                                     scram-sha-256",
    );
    expect(plan.contents).toContain("# Other methods are not ours to change.");
  });

  it("is idempotent: a SCRAM file is left byte-identical", () => {
    const once = planCleartextAuthRewrite(LEGACY_HBA);
    const twice = planCleartextAuthRewrite(once.contents);

    expect(twice.rewrittenLines).toBe(0);
    expect(twice.contents).toBe(once.contents);
  });

  it("keeps a trailing comment on the same line", () => {
    const plan = planCleartextAuthRewrite("host all all 127.0.0.1/32 password # legacy cleartext\n");

    expect(plan.rewrittenLines).toBe(1);
    expect(plan.contents).toBe("host all all 127.0.0.1/32 scram-sha-256 # legacy cleartext\n");
  });

  it("preserves CRLF line endings", () => {
    const plan = planCleartextAuthRewrite("host all all 127.0.0.1/32 password\r\nhost all all ::1/128 scram-sha-256\r\n");

    expect(plan.contents).toBe(
      "host all all 127.0.0.1/32 scram-sha-256\r\nhost all all ::1/128 scram-sha-256\r\n",
    );
  });

  it("leaves a body with no rules and no trailing newline unchanged", () => {
    expect(planCleartextAuthRewrite("").contents).toBe("");
    expect(planCleartextAuthRewrite("# nothing here").rewrittenLines).toBe(0);
    expect(planCleartextAuthRewrite("# nothing here").contents).toBe("# nothing here");
  });

  it("does not guess at an unknown record type", () => {
    const plan = planCleartextAuthRewrite("magic all all 127.0.0.1/32 password\n");

    expect(plan.rewrittenLines).toBe(0);
  });
});

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

  it(
    "rewrites a legacy cluster's pg_hba.conf to scram and keeps the stored credential working",
    async () => {
      const cluster = await startLegacyCluster();
      await rotateEmbeddedPostgresPassword({ dataDir: cluster.dataDir, port: cluster.port });

      const hbaPath = embeddedPostgresHbaPath(cluster.dataDir);
      const before = fs.readFileSync(hbaPath, "utf8");
      expect(before).toMatch(/password/);

      const outcome = await ensureEmbeddedPostgresScramAuth({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(outcome.status).toBe("rewritten");
      const after = fs.readFileSync(hbaPath, "utf8");
      expect(after).not.toMatch(/\spassword\b/);
      expect(after).toContain("scram-sha-256");
      expect(fs.statSync(hbaPath).mode & 0o777).toBe(0o600);

      // The reloaded rules still accept the stored credential on a fresh
      // connection: the rewrite did not lock the cluster out of itself.
      const sql = postgres(
        embeddedPostgresUrl({ dataDir: cluster.dataDir, port: cluster.port, database: "postgres" }),
        { max: 1, onnotice: () => {} },
      );
      try {
        await expect(sql`select 1 as ok`).resolves.toBeDefined();
      } finally {
        await sql.end({ timeout: 5 });
      }

      // A second start is a no-op, not a rewrite loop.
      const again = await ensureEmbeddedPostgresScramAuth({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });
      expect(again.status).toBe("unchanged");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to rewrite while the cluster still uses the shipped literal",
    async () => {
      const cluster = await startLegacyCluster();

      const outcome = await ensureEmbeddedPostgresScramAuth({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(outcome).toMatchObject({ status: "skipped", reason: "legacy-credential" });
      expect(fs.readFileSync(embeddedPostgresHbaPath(cluster.dataDir), "utf8")).toContain("password");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});

describeEmbeddedPostgres("embedded postgres least privilege (NEXA-755 control 2)", () => {
  async function readApplicationRole(url: string) {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }[]>`
        select rolsuper, rolcreaterole, rolcreatedb
        from pg_roles where rolname = current_user
      `;
      return rows[0];
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  async function prepareCluster() {
    const cluster = await startLegacyCluster();
    const rotated = await rotateEmbeddedPostgresPassword({
      dataDir: cluster.dataDir,
      port: cluster.port,
    });
    await ensureEmbeddedPostgresScramAuth({ dataDir: cluster.dataDir, port: cluster.port });
    return { cluster, rotated };
  }

  it(
    "creates a separate admin superuser and removes CREATEROLE from the bootstrap application role",
    async () => {
      const { cluster, rotated } = await prepareCluster();
      const applicationUrl = embeddedPostgresUrl({
        dataDir: cluster.dataDir,
        port: cluster.port,
        database: "postgres",
      });
      expect((await readApplicationRole(applicationUrl))?.rolsuper).toBe(true);

      const adminOutcome = await ensureEmbeddedPostgresAdminRole({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });
      expect(adminOutcome.status).toBe("created");

      const adminPath = embeddedPostgresAdminPasswordPath(cluster.dataDir);
      expect(fs.statSync(adminPath).mode & 0o777).toBe(0o600);
      const admin = resolveEmbeddedPostgresAdminCredentials(cluster.dataDir);
      expect(admin).not.toBeNull();
      expect(admin?.password).not.toBe(rotated.password);

      // The administrative role is a working superuser login.
      const adminSql = postgres(
        embeddedPostgresAdminUrl({ dataDir: cluster.dataDir, port: cluster.port, database: "postgres" }),
        { max: 1, onnotice: () => {} },
      );
      try {
        const [{ rolsuper }] = await adminSql<{ rolsuper: boolean }[]>`
          select rolsuper from pg_roles where rolname = current_user
        `;
        expect(rolsuper).toBe(true);

        const restricted = await restrictEmbeddedPostgresApplicationRole({
          dataDir: cluster.dataDir,
          port: cluster.port,
        });
        // PostgreSQL 18 refuses to remove SUPERUSER from the bootstrap
        // superuser (`paperclip` is OID 10 here), so the reachable state is
        // CREATEROLE removed and SUPERUSER retained.
        expect(restricted).toEqual({
          status: "createrole-restricted",
          retained: "bootstrap-superuser",
        });

        // A fresh application connection still works, keeps CREATEDB for
        // first-run database creation, and keeps the engine-mandated SUPERUSER.
        const attributes = await readApplicationRole(applicationUrl);
        expect(attributes).toMatchObject({
          rolsuper: true,
          rolcreaterole: false,
          rolcreatedb: true,
        });

        // The admin path survived, and it is the documented rollback: it can
        // hand CREATEROLE back to the application role.
        await adminSql.unsafe("ALTER ROLE paperclip CREATEROLE");
        expect((await readApplicationRole(applicationUrl))?.rolcreaterole).toBe(true);
      } finally {
        await adminSql.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "is idempotent and keeps the same admin credential on the next start",
    async () => {
      const { cluster } = await prepareCluster();
      expect(
        (await ensureEmbeddedPostgresAdminRole({ dataDir: cluster.dataDir, port: cluster.port })).status,
      ).toBe("created");
      const first = resolveEmbeddedPostgresAdminCredentials(cluster.dataDir)?.password;
      expect(
        (await ensureEmbeddedPostgresAdminRole({ dataDir: cluster.dataDir, port: cluster.port })).status,
      ).toBe("existing");
      expect(resolveEmbeddedPostgresAdminCredentials(cluster.dataDir)?.password).toBe(first);

      expect(
        await restrictEmbeddedPostgresApplicationRole({ dataDir: cluster.dataDir, port: cluster.port }),
      ).toEqual({ status: "createrole-restricted", retained: "bootstrap-superuser" });
      expect(
        await restrictEmbeddedPostgresApplicationRole({ dataDir: cluster.dataDir, port: cluster.port }),
      ).toEqual({ status: "createrole-restricted", retained: "bootstrap-superuser" });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "does not create an admin role while the cluster still uses the shipped literal",
    async () => {
      const cluster = await startLegacyCluster();

      const outcome = await ensureEmbeddedPostgresAdminRole({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(outcome).toEqual({ status: "skipped", reason: "legacy-credential" });
      expect(fs.existsSync(embeddedPostgresAdminPasswordPath(cluster.dataDir))).toBe(false);
      const sql = postgres(
        `postgres://paperclip:${LEGACY_EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${cluster.port}/postgres`,
        { max: 1, onnotice: () => {} },
      );
      try {
        const [{ count }] = await sql<{ count: number }[]>`
          select count(*)::int as count from pg_roles where rolname = 'paperclip_admin'
        `;
        expect(count).toBe(0);
      } finally {
        await sql.end({ timeout: 5 }).catch(() => undefined);
      }
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "skips the demotion when no admin credential exists",
    async () => {
      const { cluster } = await prepareCluster();
      const applicationUrl = embeddedPostgresUrl({
        dataDir: cluster.dataDir,
        port: cluster.port,
        database: "postgres",
      });

      const outcome = await restrictEmbeddedPostgresApplicationRole({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(outcome).toEqual({ status: "skipped", reason: "no-admin-credential" });
      expect((await readApplicationRole(applicationUrl))?.rolsuper).toBe(true);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "keeps control 1 working after the application role is demoted",
    async () => {
      const { cluster } = await prepareCluster();
      await ensureEmbeddedPostgresAdminRole({ dataDir: cluster.dataDir, port: cluster.port });
      expect(
        (await restrictEmbeddedPostgresApplicationRole({ dataDir: cluster.dataDir, port: cluster.port })).status,
      ).toBe("createrole-restricted");

      // Simulate an operator restoring a pre-upgrade pg_hba.conf.
      const hbaPath = embeddedPostgresHbaPath(cluster.dataDir);
      const demotedHba = fs.readFileSync(hbaPath, "utf8").replace(/scram-sha-256/g, "password");
      expect(demotedHba).toMatch(/\spassword\b/);
      fs.writeFileSync(hbaPath, demotedHba);

      // The rewrite reads the verifier through the administrative role, which
      // is the only superuser left.
      const outcome = await ensureEmbeddedPostgresScramAuth({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });
      expect(outcome.status).toBe("rewritten");
      expect(fs.readFileSync(hbaPath, "utf8")).not.toMatch(/\spassword\b/);

      const attributes = await readApplicationRole(
        embeddedPostgresUrl({ dataDir: cluster.dataDir, port: cluster.port, database: "postgres" }),
      );
      // SUPERUSER is retained because the engine forbids removing it from the
      // bootstrap superuser; CREATEROLE is gone, which is the reachable limit.
      expect(attributes).toMatchObject({ rolsuper: true, rolcreaterole: false });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});

describeEmbeddedPostgres("embedded postgres role model (NEXA-805)", () => {
  async function readCurrentRole(url: string) {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
      }[]>`
        select rolsuper, rolcreaterole, rolcreatedb
        from pg_roles where rolname = current_user
      `;
      return rows[0];
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  }

  it(
    "creates the application role as a non-superuser that can still create its own database",
    async () => {
      const cluster = await startAdminBootstrappedCluster();
      const outcome = await provisionEmbeddedPostgresApplicationRole({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });
      expect(outcome).toEqual({ status: "created" });

      const applicationUrl = embeddedPostgresUrl({
        dataDir: cluster.dataDir,
        port: cluster.port,
        database: "postgres",
      });
      const attributes = await readCurrentRole(applicationUrl);
      expect(attributes).toMatchObject({
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: true,
      });

      // First-run database creation still works with the least-privilege role.
      const applicationSql = postgres(applicationUrl, { max: 1, onnotice: () => {} });
      try {
        await applicationSql.unsafe('create database nexa805_probe');
      } finally {
        await applicationSql.end({ timeout: 5 }).catch(() => undefined);
      }

      // An admin-bootstrapped cluster reaches the fully restricted state: the
      // application role is not the bootstrap superuser, so nothing is retained.
      expect(
        await restrictEmbeddedPostgresApplicationRole({
          dataDir: cluster.dataDir,
          port: cluster.port,
        }),
      ).toEqual({ status: "restricted" });

      // Provisioning is idempotent across restarts.
      expect(
        await provisionEmbeddedPostgresApplicationRole({
          dataDir: cluster.dataDir,
          port: cluster.port,
        }),
      ).toEqual({ status: "existing" });
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it(
    "skips provisioning when the cluster has no administrative credential",
    async () => {
      const cluster = await startLegacyCluster();
      await rotateEmbeddedPostgresPassword({ dataDir: cluster.dataDir, port: cluster.port });

      const outcome = await provisionEmbeddedPostgresApplicationRole({
        dataDir: cluster.dataDir,
        port: cluster.port,
      });

      expect(outcome).toEqual({ status: "skipped", reason: "no-admin-credential" });
      // The historical role is untouched: still the bootstrap superuser.
      expect(
        (await readCurrentRole(
          embeddedPostgresUrl({ dataDir: cluster.dataDir, port: cluster.port, database: "postgres" }),
        ))?.rolsuper,
      ).toBe(true);
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});

describeEmbeddedPostgres("credential statement logging (NEXA-806)", () => {
  const waitForLog = async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  };

  it(
    "keeps a failing credential statement out of the server log",
    async () => {
      const cluster = await startLegacyClusterWithLogs();
      const url = `postgres://paperclip:${LEGACY_EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${cluster.port}/postgres`;

      // Control: PostgreSQL logs a failing statement by default, including the
      // rendered credential. This is the defect NEXA-806 records.
      const control = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await control
          .unsafe(`ALTER ROLE no_such_role_nexa806 WITH PASSWORD 'CANARY-CONTROL-123'`)
          .catch(() => undefined);
      } finally {
        await control.end({ timeout: 5 }).catch(() => undefined);
      }
      await waitForLog();
      expect(cluster.logs.join("")).toContain("CANARY-CONTROL-123");

      // The real credential path: suppress before the statement is sent.
      cluster.logs.length = 0;
      const suppressed = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await suppressCredentialStatementLogging(suppressed, "test a credential statement");
        await suppressed
          .unsafe(`ALTER ROLE no_such_role_nexa806 WITH PASSWORD 'CANARY-SUPPRESSED-456'`)
          .catch(() => undefined);
      } finally {
        await suppressed.end({ timeout: 5 }).catch(() => undefined);
      }
      await waitForLog();
      expect(cluster.logs.join("")).not.toContain("CANARY-SUPPRESSED-456");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});

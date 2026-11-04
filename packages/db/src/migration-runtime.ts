import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import {
  embeddedPostgresUrl,
  persistEmbeddedPostgresPassword,
  resolveEmbeddedPostgresCredentials,
  resolveEmbeddedPostgresInitialisationPassword,
  rotateEmbeddedPostgresPassword,
  ensureEmbeddedPostgresScramAuth,
} from "./embedded-postgres-credentials.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  authMethod?: "scram-sha-256" | "password" | "md5";
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 20;
  let port = startPort;
  for (let i = 0; i < maxLookahead; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a free port from ${startPort} to ${startPort + maxLookahead - 1}`,
  );
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const preferredAdminConnectionString = embeddedPostgresUrl({
    dataDir,
    port: preferredPort,
    database: "postgres",
  });
  const logBuffer = createEmbeddedPostgresLogBuffer();

  // Another process owns this cluster: use its credentials, never rotate them.
  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "paperclip");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      return {
        connectionString: embeddedPostgresUrl({ dataDir, port: preferredPort, database: "paperclip" }),
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch {
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    const adminConnectionString = embeddedPostgresUrl({ dataDir, port, database: "postgres" });
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    return {
      connectionString: embeddedPostgresUrl({ dataDir, port, database: "paperclip" }),
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const clusterAlreadyInitialised = existsSync(pgVersionFile);
  // A brand new cluster gets a generated password before `initdb` runs, so the
  // cluster never exists with the shipped literal (NEXA-749).
  const initialPassword = clusterAlreadyInitialised
    ? resolveEmbeddedPostgresCredentials(dataDir).password
    : resolveEmbeddedPostgresInitialisationPassword(dataDir);

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: initialPassword,
    port: selectedPort,
    persistent: true,
    ...(clusterAlreadyInitialised ? {} : { authMethod: "scram-sha-256" as const }),
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!clusterAlreadyInitialised) {
    try {
      await instance.initialise();
      // initdb created the data directory; persist the credential now so the
      // cluster is never left with a password nobody stored (NEXA-749).
      persistEmbeddedPostgresPassword(dataDir, initialPassword);
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  // This process started the cluster, so it is the owner and may rotate a
  // pre-NEXA-749 cluster off the shipped literal. A cluster whose credential
  // file already exists is left alone.
  await rotateEmbeddedPostgresPassword({ dataDir, port: selectedPort });
  // Same ownership window: move a legacy cluster's pg_hba.conf off cleartext
  // password auth once the credential is provably SCRAM (NEXA-755).
  await ensureEmbeddedPostgresScramAuth({ dataDir, port: selectedPort });

  const adminConnectionString = embeddedPostgresUrl({
    dataDir,
    port: selectedPort,
    database: "postgres",
  });
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    connectionString: embeddedPostgresUrl({ dataDir, port: selectedPort, database: "paperclip" }),
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      await instance.stop();
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}

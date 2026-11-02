import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { expandHomePrefix, resolveDefaultEmbeddedPostgresDir } from "@paperclipai/shared/home-paths";
import postgres from "postgres";

/**
 * Embedded PostgreSQL credentials.
 *
 * A managed cluster listens on loopback, but loopback is a network boundary,
 * not an identity boundary: any local account can reach the port. That makes
 * the cluster password the access control for the whole board database, so it
 * must not be a value that ships with the bundle (NEXA-749).
 *
 * Rules this module enforces:
 *  - a fresh cluster always gets a random 32-byte password, handed to `initdb`
 *    and then stored at `<dataDir>/embedded-postgres.password` (0600), so the
 *    credential travels with the cluster it belongs to;
 *  - an already-initialised cluster created before this module existed is
 *    rotated exactly once, by the process that starts the cluster itself;
 *  - a caller that only *adopts* a cluster someone else started never rotates
 *    it, so a CLI command cannot invalidate the running server's pool;
 *  - if a credential file is missing and the legacy password is rejected, we
 *    fail loudly instead of generating a new secret the running server does
 *    not know.
 */

export const EMBEDDED_POSTGRES_USER = "paperclip";

/**
 * The literal shipped by every build before NEXA-749 was fixed. It is kept only
 * so a pre-existing cluster can be rotated onto a generated password; no
 * connection path may use it once a credential file exists.
 */
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

export const EMBEDDED_POSTGRES_PASSWORD_FILENAME = "embedded-postgres.password";

const ROTATION_LOCK_FILENAME = ".embedded-postgres-rotation.lock";
const ROTATION_LOCK_STALE_MS = 60_000;
const ROTATION_LOCK_TIMEOUT_MS = 15_000;
const PASSWORD_FILE_MODE = 0o600;

export type EmbeddedPostgresCredentialSource = "file" | "legacy";

export type EmbeddedPostgresCredentials = {
  user: string;
  password: string;
  source: EmbeddedPostgresCredentialSource;
};

export type EmbeddedPostgresUrlOptions = {
  dataDir: string;
  port: number;
  database: string;
};

/**
 * Resolves the embedded data directory the same way every entry point does:
 * an explicit config value (with `~` expanded) or the instance default.
 */
export function resolveEmbeddedPostgresDataDir(
  configuredDataDir?: string | null,
  options?: { homeDir?: string; instanceId?: string },
): string {
  const trimmed = configuredDataDir?.trim();
  if (trimmed) return path.resolve(expandHomePrefix(trimmed));
  return resolveDefaultEmbeddedPostgresDir(options);
}

export function embeddedPostgresPasswordPath(dataDir: string): string {
  // Inside the data directory: the password belongs to this cluster, and any
  // copy or move of the cluster must carry it. `initdb` refuses to initialise
  // into a non-empty directory, so a fresh cluster's file is written right
  // after `initdb` succeeds, never before.
  return path.resolve(dataDir, EMBEDDED_POSTGRES_PASSWORD_FILENAME);
}

function isCredentialFilePrivate(filePath: string): boolean {
  try {
    return (statSync(filePath).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function repairCredentialFileMode(filePath: string): void {
  if (isCredentialFilePrivate(filePath)) return;
  chmodSync(filePath, PASSWORD_FILE_MODE);
  process.emitWarning(
    `Embedded PostgreSQL password file ${filePath} was readable by group/other; mode repaired to 0600.`,
    "EmbeddedPostgresCredentialWarning",
  );
}

function readPasswordFile(dataDir: string): string | null {
  const filePath = embeddedPostgresPasswordPath(dataDir);
  if (!existsSync(filePath)) return null;

  const password = readFileSync(filePath, "utf8").trim();
  if (password.length === 0) {
    throw new Error(
      `Embedded PostgreSQL password file ${filePath} is empty; refusing to start with an unusable credential.`,
    );
  }
  repairCredentialFileMode(filePath);
  return password;
}

/**
 * Returns the credentials to use for the cluster in `dataDir`. A missing file
 * means the cluster predates NEXA-749, so the legacy password is returned and
 * the caller decides whether it is allowed to rotate (see
 * `rotateEmbeddedPostgresPassword`).
 */
export function resolveEmbeddedPostgresCredentials(dataDir: string): EmbeddedPostgresCredentials {
  const password = readPasswordFile(dataDir);
  if (password) {
    return { user: EMBEDDED_POSTGRES_USER, password, source: "file" };
  }
  return {
    user: EMBEDDED_POSTGRES_USER,
    password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
    source: "legacy",
  };
}

/** True when the cluster already has a generated password. */
export function hasEmbeddedPostgresPassword(dataDir: string): boolean {
  return existsSync(embeddedPostgresPasswordPath(dataDir));
}

function writePasswordFile(dataDir: string, password: string): void {
  const filePath = embeddedPostgresPasswordPath(dataDir);
  const directory = path.dirname(filePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, `${password}\n`, { mode: PASSWORD_FILE_MODE });
  chmodSync(temporaryPath, PASSWORD_FILE_MODE);
  renameSync(temporaryPath, filePath);
}

export function generateEmbeddedPostgresPassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Password to hand to `initdb` for a brand new cluster. Uses the stored value
 * when one exists and otherwise generates one that the caller must persist
 * with `persistEmbeddedPostgresPassword` once `initdb` has created the data
 * directory.
 */
export function resolveEmbeddedPostgresInitialisationPassword(dataDir: string): string {
  return readPasswordFile(dataDir) ?? generateEmbeddedPostgresPassword();
}

/**
 * Stores the password `initdb` was given. Refuses to overwrite a different
 * stored value, so a lost race cannot silently orphan the real credential.
 */
export function persistEmbeddedPostgresPassword(dataDir: string, password: string): void {
  const existing = readPasswordFile(dataDir);
  if (existing) {
    if (existing === password) return;
    throw new Error(
      `Refusing to replace the embedded PostgreSQL password at ${embeddedPostgresPasswordPath(dataDir)}: a different credential is already stored for this cluster.`,
    );
  }
  writePasswordFile(dataDir, password);
}

function encodeUrlComponent(value: string): string {
  return encodeURIComponent(value);
}

function buildUrl(
  credentials: EmbeddedPostgresCredentials,
  port: number,
  database: string,
): string {
  return `postgres://${encodeUrlComponent(credentials.user)}:${encodeUrlComponent(credentials.password)}@127.0.0.1:${port}/${database}`;
}

/**
 * Connection URL for the embedded cluster, using the stored password when one
 * exists and the legacy literal otherwise. Prefer `resolveEmbeddedPostgresUrl`
 * when the caller also needs to know which source it got.
 */
export function embeddedPostgresUrl(options: EmbeddedPostgresUrlOptions): string {
  return buildUrl(resolveEmbeddedPostgresCredentials(options.dataDir), options.port, options.database);
}

export type ResolvedEmbeddedPostgresUrl = {
  url: string;
  credentials: EmbeddedPostgresCredentials;
};

export function resolveEmbeddedPostgresUrl(
  options: EmbeddedPostgresUrlOptions,
): ResolvedEmbeddedPostgresUrl {
  const credentials = resolveEmbeddedPostgresCredentials(options.dataDir);
  return { url: buildUrl(credentials, options.port, options.database), credentials };
}

async function acquireRotationLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + ROTATION_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > ROTATION_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the embedded PostgreSQL rotation lock at ${lockPath}. Another process may be rotating the password; retry once it finishes.`,
        );
      }

      // This runs once per instance, at startup only: a short wait is enough
      // for a concurrent rotation to finish and write the credential file.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export type RotateEmbeddedPostgresPasswordOptions = {
  dataDir: string;
  port: number;
};

/**
 * Rotates a pre-NEXA-749 cluster from the shipped literal onto a generated
 * password, then writes the credential file.
 *
 * Only call this from the process that starts the cluster itself: rotating a
 * cluster another live process is using would invalidate that process's new
 * connections. When the file already exists this is a no-op.
 *
 * Throws (without writing anything) when the legacy password is rejected, so a
 * missing credential file cannot silently turn into a fresh, unknown secret.
 */
export async function rotateEmbeddedPostgresPassword(
  options: RotateEmbeddedPostgresPasswordOptions,
): Promise<EmbeddedPostgresCredentials> {
  const existingPassword = readPasswordFile(options.dataDir);
  if (existingPassword) {
    return { user: EMBEDDED_POSTGRES_USER, password: existingPassword, source: "file" };
  }

  const lockPath = path.resolve(options.dataDir, ROTATION_LOCK_FILENAME);
  const releaseLock = await acquireRotationLock(lockPath);
  try {
    // Another process may have rotated while we waited for the lock.
    const rotatedByPeer = readPasswordFile(options.dataDir);
    if (rotatedByPeer) {
      return { user: EMBEDDED_POSTGRES_USER, password: rotatedByPeer, source: "file" };
    }

    const legacyUrl = buildUrl(
      {
        user: EMBEDDED_POSTGRES_USER,
        password: LEGACY_EMBEDDED_POSTGRES_PASSWORD,
        source: "legacy",
      },
      options.port,
      "postgres",
    );
    const sql = postgres(legacyUrl, { max: 1, onnotice: () => {} });
    try {
      // Store a SCRAM verifier even if the cluster's pg_hba still asks for
      // cleartext `password` auth. The value is passed as a bind parameter and
      // rendered server-side with format(), so it never reaches a log line.
      await sql.unsafe("SET password_encryption = 'scram-sha-256'").catch(() => undefined);
      const password = generateEmbeddedPostgresPassword();
      // Render the ALTER ROLE server-side so the password is a bind parameter
      // and never appears in query text, a log line, or a statement timeout dump.
      const [{ statement }] = await sql<{ statement: string }[]>`
        select format('ALTER ROLE %I WITH PASSWORD %L', current_user, ${password}::text) as statement
      `;
      await sql.unsafe(statement);

      writePasswordFile(options.dataDir, password);

      // Prove the persisted credential before returning: a rotation that
      // "succeeded" but left an unusable file must fail here, not on the next
      // board start.
      const verificationUrl = buildUrl(
        { user: EMBEDDED_POSTGRES_USER, password, source: "file" },
        options.port,
        "postgres",
      );
      const verification = postgres(verificationUrl, { max: 1, onnotice: () => {} });
      try {
        await verification`select 1 as ok`;
      } catch (error) {
        throw new Error(
          `Rotated the embedded PostgreSQL role password and wrote ${embeddedPostgresPasswordPath(options.dataDir)}, but a fresh connection with the new credential failed: ${
            error instanceof Error ? error.message : String(error)
          }. The cluster now requires the value in that file.`,
        );
      } finally {
        await verification.end({ timeout: 5 }).catch(() => undefined);
      }

      return { user: EMBEDDED_POSTGRES_USER, password, source: "file" };
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }
  } finally {
    releaseLock();
  }
}

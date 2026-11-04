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
 * Separate administrative role (NEXA-755, control 2).
 *
 * The application role is the bootstrap superuser `initdb` creates. PostgreSQL
 * 18 forbids removing `SUPERUSER` from that role, so the application role keeps
 * it on an existing cluster (see `restrictEmbeddedPostgresApplicationRole`).
 * This role is still required: it is an independent privileged credential that
 * survives losing the application credential, and it is the intended bootstrap
 * superuser for clusters that are rebuilt with least privilege from the start.
 */
export const EMBEDDED_POSTGRES_ADMIN_USER = "paperclip_admin";

/**
 * The literal shipped by every build before NEXA-749 was fixed. It is kept only
 * so a pre-existing cluster can be rotated onto a generated password; no
 * connection path may use it once a credential file exists.
 */
export const LEGACY_EMBEDDED_POSTGRES_PASSWORD = "paperclip";

export const EMBEDDED_POSTGRES_PASSWORD_FILENAME = "embedded-postgres.password";
export const EMBEDDED_POSTGRES_ADMIN_PASSWORD_FILENAME = "embedded-postgres-admin.password";

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

export type EmbeddedPostgresAdminCredentials = {
  user: string;
  password: string;
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

export function embeddedPostgresAdminPasswordPath(dataDir: string): string {
  return path.resolve(dataDir, EMBEDDED_POSTGRES_ADMIN_PASSWORD_FILENAME);
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

function readPasswordFileAt(filePath: string): string | null {
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

function readPasswordFile(dataDir: string): string | null {
  return readPasswordFileAt(embeddedPostgresPasswordPath(dataDir));
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

function writePasswordFileAt(filePath: string, password: string): void {
  const directory = path.dirname(filePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, `${password}\n`, { mode: PASSWORD_FILE_MODE });
  chmodSync(temporaryPath, PASSWORD_FILE_MODE);
  renameSync(temporaryPath, filePath);
}

function writePasswordFile(dataDir: string, password: string): void {
  writePasswordFileAt(embeddedPostgresPasswordPath(dataDir), password);
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

/**
 * Credentials for the administrative role, or `null` while the cluster has no
 * admin credential yet. A cluster that predates control 2 has no admin path, so
 * callers must create one before removing the application role's superuser.
 */
export function resolveEmbeddedPostgresAdminCredentials(
  dataDir: string,
): EmbeddedPostgresAdminCredentials | null {
  const password = readPasswordFileAt(embeddedPostgresAdminPasswordPath(dataDir));
  if (!password) return null;
  return { user: EMBEDDED_POSTGRES_ADMIN_USER, password };
}

/** True when the cluster has a stored administrative credential. */
export function hasEmbeddedPostgresAdminPassword(dataDir: string): boolean {
  return existsSync(embeddedPostgresAdminPasswordPath(dataDir));
}

function encodeUrlComponent(value: string): string {
  return encodeURIComponent(value);
}

type UrlCredentials = { user: string; password: string };

function buildUrl(
  credentials: UrlCredentials,
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

/**
 * Connection URL for the administrative role. Throws when the cluster has no
 * stored admin credential: an empty password would be a silent misconfiguration
 * in exactly the path an operator reaches for when something is already wrong.
 */
export function embeddedPostgresAdminUrl(options: EmbeddedPostgresUrlOptions): string {
  const credentials = resolveEmbeddedPostgresAdminCredentials(options.dataDir);
  if (!credentials) {
    throw new Error(
      `No embedded PostgreSQL administrative credential exists at ${embeddedPostgresAdminPasswordPath(options.dataDir)}.`,
    );
  }
  return buildUrl(credentials, options.port, options.database);
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
      { user: EMBEDDED_POSTGRES_USER, password: LEGACY_EMBEDDED_POSTGRES_PASSWORD },
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
        { user: EMBEDDED_POSTGRES_USER, password },
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

export const EMBEDDED_POSTGRES_HBA_FILENAME = "pg_hba.conf";

const CLEARTEXT_AUTH_METHOD = "password";
const SCRAM_AUTH_METHOD = "scram-sha-256";

export function embeddedPostgresHbaPath(dataDir: string): string {
  return path.resolve(dataDir, EMBEDDED_POSTGRES_HBA_FILENAME);
}

export type CleartextAuthRewritePlan = {
  /** The rewritten file body. Identical to the input when nothing matched. */
  contents: string;
  /** Number of host/local lines whose method was changed. */
  rewrittenLines: number;
};

type HbaField = { text: string; start: number; end: number };

function splitFields(line: string): HbaField[] {
  const fields: HbaField[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    fields.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return fields;
}

function rewriteCleartextAuthLine(line: string): { line: string; changed: boolean } {
  // Comments may follow the rule on the same line; keep them byte-for-byte.
  const commentIndex = line.indexOf("#");
  const code = commentIndex === -1 ? line : line.slice(0, commentIndex);
  const comment = commentIndex === -1 ? "" : line.slice(commentIndex);

  const fields = splitFields(code);
  if (fields.length === 0) return { line, changed: false };

  const recordType = fields[0].text.toLowerCase();
  // pg_hba.conf field order: `local DATABASE USER METHOD`, and
  // `host TYPE DATABASE USER ADDRESS METHOD`. Any other record type is left
  // alone rather than guessed at.
  const methodIndex = recordType === "local" ? 3 : recordType.startsWith("host") ? 4 : -1;
  if (methodIndex < 0 || fields.length <= methodIndex) return { line, changed: false };

  const method = fields[methodIndex];
  if (method.text.toLowerCase() !== CLEARTEXT_AUTH_METHOD) return { line, changed: false };

  const rewritten = `${code.slice(0, method.start)}${SCRAM_AUTH_METHOD}${code.slice(method.end)}`;
  return { line: `${rewritten}${comment}`, changed: true };
}

/**
 * Rewrites every cleartext `password` auth method in a `pg_hba.conf` body to
 * `scram-sha-256` (NEXA-755).
 *
 * Only the auth method changes. Comments, whitespace, ordering and every other
 * method (`trust`, `peer`, `md5`, `cert`, ...) are preserved verbatim, so the
 * result is reviewable as a diff against the file the cluster wrote.
 *
 * This is a pure transformation: it does not read or write anything, which is
 * what makes it cheap to test against real cluster files.
 */
export function planCleartextAuthRewrite(contents: string): CleartextAuthRewritePlan {
  const eol = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  let rewrittenLines = 0;
  const rewritten = lines.map((line) => {
    const result = rewriteCleartextAuthLine(line);
    if (result.changed) rewrittenLines += 1;
    return result.line;
  });
  return { contents: rewritten.join(eol), rewrittenLines };
}

export type EnsureEmbeddedPostgresScramAuthOptions = {
  dataDir: string;
  port: number;
};

export type EmbeddedPostgresScramAuthOutcome =
  | { status: "rewritten"; rewrittenLines: number }
  | { status: "unchanged"; rewrittenLines: 0 }
  | { status: "no-hba-file"; rewrittenLines: 0 }
  | {
      status: "skipped";
      rewrittenLines: 0;
      reason: "legacy-credential" | "verifier-not-scram" | "verifier-unreadable";
      detail?: string;
    };

function writeHbaFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporaryPath, contents, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, filePath);
}

async function readStoredPasswordVerifier(dataDir: string, port: number): Promise<string | null> {
  // Prefer the administrative role (NEXA-755, control 2): once the application
  // role is no longer a superuser it cannot read `pg_authid`. Falling back to
  // the application credentials keeps a cluster without an admin path working
  // exactly as it did before control 2 existed.
  const admin = resolveEmbeddedPostgresAdminCredentials(dataDir);
  const credentials: UrlCredentials = admin ?? resolveEmbeddedPostgresCredentials(dataDir);
  const sql = postgres(buildUrl(credentials, port, "postgres"), { max: 1, onnotice: () => {} });
  try {
    // `pg_authid` is superuser-only. A caller that cannot read it gets a clear
    // "unknown" rather than a guess: rewriting the method for a verifier we
    // cannot see is how a cluster gets locked out of itself.
    const rows = await sql<{ rolpassword: string | null }[]>`
      select rolpassword from pg_authid where rolname = ${EMBEDDED_POSTGRES_USER}
    `;
    return rows[0]?.rolpassword ?? null;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Rewrites a cluster's `pg_hba.conf` from cleartext `password` auth to
 * `scram-sha-256`, then reloads it (NEXA-755, control 1).
 *
 * Only call this from the process that started the cluster: it is the owner of
 * the data directory and the credential, exactly like
 * `rotateEmbeddedPostgresPassword`. A cluster another process owns must not have
 * its auth rewritten underneath it.
 *
 * Safety properties, in the order they are checked:
 *  - no rewrite when the credential is still the shipped legacy literal, or
 *    when the stored verifier is not SCRAM. Either case means switching the
 *    method would break the next connection;
 *  - no rewrite when the verifier cannot be read (no superuser), because
 *    "cannot see" is not "is SCRAM";
 *  - the file is replaced atomically and kept at 0600;
 *  - after `pg_reload_conf()` a *fresh* connection is opened with the stored
 *    credential. If it fails, the original file contents are restored, the
 *    cluster is reloaded again, and the call throws. A rewrite that breaks
 *    authentication never outlives the call that made it.
 */
export async function ensureEmbeddedPostgresScramAuth(
  options: EnsureEmbeddedPostgresScramAuthOptions,
): Promise<EmbeddedPostgresScramAuthOutcome> {
  const hbaPath = embeddedPostgresHbaPath(options.dataDir);
  if (!existsSync(hbaPath)) return { status: "no-hba-file", rewrittenLines: 0 };

  const original = readFileSync(hbaPath, "utf8");
  const plan = planCleartextAuthRewrite(original);
  if (plan.rewrittenLines === 0) return { status: "unchanged", rewrittenLines: 0 };

  const credentials = resolveEmbeddedPostgresCredentials(options.dataDir);
  if (credentials.source === "legacy") {
    // The rotation step has not run (or was not allowed to). Do not change the
    // method while the only known credential is the shipped literal.
    return { status: "skipped", rewrittenLines: 0, reason: "legacy-credential" };
  }

  let verifier: string | null;
  try {
    verifier = await readStoredPasswordVerifier(options.dataDir, options.port);
  } catch (error) {
    return {
      status: "skipped",
      rewrittenLines: 0,
      reason: "verifier-unreadable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (verifier === null || !verifier.startsWith("SCRAM-SHA-256$")) {
    return { status: "skipped", rewrittenLines: 0, reason: "verifier-not-scram" };
  }

  writeHbaFileAtomically(hbaPath, plan.contents);

  const reloadAndVerify = async (): Promise<void> => {
    const sql = postgres(
      buildUrl(credentials, options.port, "postgres"),
      { max: 1, onnotice: () => {} },
    );
    try {
      await sql`select pg_reload_conf()`;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => undefined);
    }

    // Reload is asynchronous: the postmaster processes SIGHUP between
    // connections. A fresh connection is the only proof that the new rules are
    // in force and that we can still authenticate under them.
    const verification = postgres(
      buildUrl(credentials, options.port, "postgres"),
      { max: 1, onnotice: () => {} },
    );
    try {
      await verification`select 1 as ok`;
    } finally {
      await verification.end({ timeout: 5 }).catch(() => undefined);
    }
  };

  try {
    await reloadAndVerify();
  } catch (error) {
    writeHbaFileAtomically(hbaPath, original);
    const rollbackSql = postgres(
      buildUrl(credentials, options.port, "postgres"),
      { max: 1, onnotice: () => {} },
    );
    try {
      await rollbackSql`select pg_reload_conf()`;
    } catch {
      // Best effort: the error below already names the restored file, which is
      // what a human needs to finish the rollback by hand.
    } finally {
      await rollbackSql.end({ timeout: 5 }).catch(() => undefined);
    }
    throw new Error(
      `Rewrote ${hbaPath} to SCRAM authentication and reloaded it, but a fresh connection with the stored credential failed: ${
        error instanceof Error ? error.message : String(error)
      }. The original file contents were restored; the cluster was not left on rules it cannot satisfy.`,
    );
  }

  return { status: "rewritten", rewrittenLines: plan.rewrittenLines };
}

export type EnsureEmbeddedPostgresAdminRoleOptions = {
  dataDir: string;
  port: number;
};

export type EmbeddedPostgresAdminRoleOutcome =
  | { status: "skipped"; reason: "legacy-credential" }
  | { status: "created" }
  | { status: "existing" };

function openConnection(credentials: UrlCredentials, port: number, database = "postgres") {
  return postgres(buildUrl(credentials, port, database), { max: 1, onnotice: () => {} });
}

async function assertAdminRoleUsable(
  admin: EmbeddedPostgresAdminCredentials,
  port: number,
): Promise<void> {
  const sql = openConnection(admin, port);
  try {
    const rows = await sql<{ rolsuper: boolean; rolcanlogin: boolean }[]>`
      select rolsuper, rolcanlogin from pg_roles where rolname = current_user
    `;
    const role = rows[0];
    if (!role?.rolcanlogin || !role.rolsuper) {
      throw new Error(
        `Embedded PostgreSQL administrative role ${EMBEDDED_POSTGRES_ADMIN_USER} is not a usable superuser login.`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/**
 * Creates (or repairs) the separate administrative role `paperclip_admin`
 * (NEXA-755, control 2).
 *
 * The caller must be the process that started the cluster, exactly like
 * `rotateEmbeddedPostgresPassword`. A cluster that still uses the shipped
 * literal is skipped: the administrative credential must never be created from
 * a value that ships with the bundle.
 *
 * Safety properties:
 *  - the role is a `LOGIN SUPERUSER` with a generated password, never the
 *    application role's value;
 *  - the credential is only written after a fresh connection proves the role is
 *    a usable superuser, so the file never vouches for an unusable path;
 *  - a crash between role creation and file write is recoverable on the next
 *    start while the application role can still manage roles;
 *  - when the application role can no longer manage roles and the stored admin
 *    credential is unusable, the call throws instead of guessing: the cluster
 *    has no verifiable administrative path.
 */
export async function ensureEmbeddedPostgresAdminRole(
  options: EnsureEmbeddedPostgresAdminRoleOptions,
): Promise<EmbeddedPostgresAdminRoleOutcome> {
  const application = resolveEmbeddedPostgresCredentials(options.dataDir);
  if (application.source === "legacy") {
    return { status: "skipped", reason: "legacy-credential" };
  }

  const stored = resolveEmbeddedPostgresAdminCredentials(options.dataDir);
  if (stored) {
    try {
      await assertAdminRoleUsable(stored, options.port);
      return { status: "existing" };
    } catch {
      // Fall through and reset the password while the application role still can.
    }
  }

  let password: string;
  const sql = openConnection(application, options.port);
  try {
    const roles = await sql<{ manageable: boolean }[]>`
      select (rolsuper or rolcreaterole) as manageable
      from pg_roles where rolname = current_user
    `;
    if (!roles[0]?.manageable) {
      throw new Error(
        `Embedded PostgreSQL administrative role ${EMBEDDED_POSTGRES_ADMIN_USER} is unusable and application role ${EMBEDDED_POSTGRES_USER} can no longer manage roles. ` +
          `The cluster has no verified administrative path: restore ${embeddedPostgresAdminPasswordPath(options.dataDir)} or use single-user mode.`,
      );
    }

    password = generateEmbeddedPostgresPassword();
    const known = await sql<{ exists: boolean }[]>`
      select exists(select 1 from pg_roles where rolname = ${EMBEDDED_POSTGRES_ADMIN_USER}) as exists
    `;
    const [{ statement }] = known[0]?.exists
      ? await sql<{ statement: string }[]>`
          select format(
            'ALTER ROLE %I WITH LOGIN SUPERUSER PASSWORD %L',
            ${EMBEDDED_POSTGRES_ADMIN_USER}::text,
            ${password}::text
          ) as statement
        `
      : await sql<{ statement: string }[]>`
          select format(
            'CREATE ROLE %I WITH LOGIN SUPERUSER PASSWORD %L',
            ${EMBEDDED_POSTGRES_ADMIN_USER}::text,
            ${password}::text
          ) as statement
        `;
    // Rendered server-side, so the password is a bind parameter and never
    // appears in query text, a log line, or a statement timeout dump.
    await sql.unsafe(statement);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }

  const created: EmbeddedPostgresAdminCredentials = {
    user: EMBEDDED_POSTGRES_ADMIN_USER,
    password,
  };
  await assertAdminRoleUsable(created, options.port);
  writePasswordFileAt(embeddedPostgresAdminPasswordPath(options.dataDir), password);
  return { status: "created" };
}

export type RestrictEmbeddedPostgresApplicationRoleOptions = {
  dataDir: string;
  port: number;
};

export type EmbeddedPostgresApplicationRoleOutcome =
  | { status: "restricted" }
  | { status: "createrole-restricted"; retained: "bootstrap-superuser" }
  | {
      status: "skipped";
      reason: "legacy-credential" | "no-admin-credential" | "application-role-missing";
    };

/**
 * The role `initdb` created with `-U` is PostgreSQL's *bootstrap superuser*.
 * PostgreSQL 18 refuses to remove its `SUPERUSER` attribute ("The bootstrap
 * superuser must have the SUPERUSER attribute", SQLSTATE 0A000), and the
 * glossary states that its superuser status cannot be removed. The first role
 * in a cluster always has OID 10.
 */
const BOOTSTRAP_SUPERUSER_OID = 10;

/**
 * Removes `CREATEROLE` from the application role and removes `SUPERUSER` when
 * the engine allows it, while keeping `CREATEDB` (first-run
 * `ensurePostgresDatabase` still creates the board database). This is control 2
 * of NEXA-755.
 *
 * The change is only made after the administrative role is proven usable, and
 * the administrative role is used to make it, so the role being demoted never
 * demotes itself. After the change a fresh application connection must connect
 * and report the demoted attributes; on any failure the administrative role
 * restores the previous attributes.
 *
 * On PostgreSQL 18 the application role is normally the bootstrap superuser, so
 * `SUPERUSER` cannot be removed. The call then keeps `SUPERUSER` (the engine
 * forbids it), still removes `CREATEROLE`, and reports
 * `createrole-restricted` instead of claiming a least-privilege state the
 * cluster cannot reach.
 */
export async function restrictEmbeddedPostgresApplicationRole(
  options: RestrictEmbeddedPostgresApplicationRoleOptions,
): Promise<EmbeddedPostgresApplicationRoleOutcome> {
  const application = resolveEmbeddedPostgresCredentials(options.dataDir);
  if (application.source === "legacy") {
    return { status: "skipped", reason: "legacy-credential" };
  }

  const admin = resolveEmbeddedPostgresAdminCredentials(options.dataDir);
  if (!admin) {
    return { status: "skipped", reason: "no-admin-credential" };
  }

  // Prove the path back before giving anything up. If this throws, nothing has
  // changed yet and the application role is still the bootstrap superuser.
  await assertAdminRoleUsable(admin, options.port);

  const applicationSql = openConnection(application, options.port);
  let current: { rolsuper: boolean; rolcreaterole: boolean; isBootstrap: boolean } | undefined;
  try {
    const rows = await applicationSql<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      isBootstrap: boolean;
    }[]>`
      select rolsuper, rolcreaterole, oid = ${BOOTSTRAP_SUPERUSER_OID} as "isBootstrap"
      from pg_roles where rolname = ${EMBEDDED_POSTGRES_USER}
    `;
    current = rows[0];
  } finally {
    await applicationSql.end({ timeout: 5 }).catch(() => undefined);
  }
  if (!current) return { status: "skipped", reason: "application-role-missing" };

  // `SUPERUSER` is untouchable for the bootstrap superuser. Detect it up front
  // so the steady state is a no-op instead of an error-driven retry on every
  // start.
  const superuserRetained = current.rolsuper && current.isBootstrap;
  if (!current.rolcreaterole && (!current.rolsuper || superuserRetained)) {
    return superuserRetained
      ? { status: "createrole-restricted", retained: "bootstrap-superuser" }
      : { status: "restricted" };
  }

  const adminSql = openConnection(admin, options.port);
  let changed = false;
  try {
    // CREATEROLE first: it is the attribute that actually narrows what the
    // application role can grant.
    if (current.rolcreaterole) {
      const [{ statement }] = await adminSql<{ statement: string }[]>`
        select format('ALTER ROLE %I NOCREATEROLE', ${EMBEDDED_POSTGRES_USER}::text) as statement
      `;
      await adminSql.unsafe(statement);
      changed = true;
    }
    if (current.rolsuper && !superuserRetained) {
      const [{ statement }] = await adminSql<{ statement: string }[]>`
        select format('ALTER ROLE %I NOSUPERUSER', ${EMBEDDED_POSTGRES_USER}::text) as statement
      `;
      await adminSql.unsafe(statement);
      changed = true;
    }

    // A fresh application connection is the only proof that the board can still
    // reach its database and that the attributes actually changed.
    const verification = openConnection(application, options.port);
    try {
      const rows = await verification<{ rolsuper: boolean; rolcreaterole: boolean }[]>`
        select rolsuper, rolcreaterole from pg_roles where rolname = current_user
      `;
      const role = rows[0];
      if (
        !role ||
        role.rolcreaterole ||
        (role.rolsuper && !superuserRetained)
      ) {
        throw new Error(
          `Application role ${EMBEDDED_POSTGRES_USER} still reports SUPERUSER/CREATEROLE after ALTER ROLE.`,
        );
      }
    } finally {
      await verification.end({ timeout: 5 }).catch(() => undefined);
    }

    // The administrative path is what makes this reversible; it must still work
    // after the application role lost its privileges.
    await assertAdminRoleUsable(admin, options.port);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    if (changed) {
      try {
        const [{ statement }] = await adminSql<{ statement: string }[]>`
          select format(
            'ALTER ROLE %I SUPERUSER CREATEROLE',
            ${EMBEDDED_POSTGRES_USER}::text
          ) as statement
        `;
        await adminSql.unsafe(statement);
      } catch (rollbackError) {
        throw new Error(
          `Restricting embedded PostgreSQL application role ${EMBEDDED_POSTGRES_USER} failed and the automatic rollback also failed. ` +
            `Use the administrative credential at ${embeddedPostgresAdminPasswordPath(options.dataDir)} to run ` +
            `ALTER ROLE ${EMBEDDED_POSTGRES_USER} SUPERUSER CREATEROLE by hand. Cause: ${cause}; rollback error: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`,
        );
      }
    }
    throw new Error(
      `Refused to leave embedded PostgreSQL application role ${EMBEDDED_POSTGRES_USER} restricted: ${
        changed ? "the change was rolled back via the administrative role. " : ""
      }Cause: ${cause}`,
    );
  } finally {
    await adminSql.end({ timeout: 5 }).catch(() => undefined);
  }

  return superuserRetained
    ? { status: "createrole-restricted", retained: "bootstrap-superuser" }
    : { status: "restricted" };
}

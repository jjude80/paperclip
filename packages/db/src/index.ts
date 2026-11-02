export {
  createDb,
  withDedicatedDbConnection,
  livenessDb,
  closeLivenessDb,
  closeRegisteredClients,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  resetPostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export {
  EMBEDDED_POSTGRES_USER,
  LEGACY_EMBEDDED_POSTGRES_PASSWORD,
  EMBEDDED_POSTGRES_PASSWORD_FILENAME,
  embeddedPostgresPasswordPath,
  embeddedPostgresUrl,
  resolveEmbeddedPostgresDataDir,
  resolveEmbeddedPostgresUrl,
  resolveEmbeddedPostgresCredentials,
  hasEmbeddedPostgresPassword,
  generateEmbeddedPostgresPassword,
  resolveEmbeddedPostgresInitialisationPassword,
  persistEmbeddedPostgresPassword,
  rotateEmbeddedPostgresPassword,
  type EmbeddedPostgresCredentials,
  type EmbeddedPostgresCredentialSource,
  type EmbeddedPostgresUrlOptions,
  type ResolvedEmbeddedPostgresUrl,
  type RotateEmbeddedPostgresPasswordOptions,
} from "./embedded-postgres-credentials.js";
export { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";

export { signalDatabaseWork, subscribeDatabaseWork, databaseWorkPending, reconcileDatabaseWork } from "./work-signals.js";

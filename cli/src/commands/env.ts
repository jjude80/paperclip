import { createHash } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { PaperclipConfig } from "../config/schema.js";
import { configExists, readConfig, resolveConfigPath } from "../config/store.js";
import {
  readAgentJwtSecretFromEnv,
  readAgentJwtSecretFromEnvFile,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import {
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";

type EnvSource = "env" | "config" | "file" | "default" | "missing";

export type EnvVarRow = {
  key: string;
  value: string;
  source: EnvSource;
  required: boolean;
  note: string;
};

/**
 * Key suffixes whose values are credentials rather than configuration.
 *
 * `paperclipai env` is the command an operator reaches for when a deployment
 * looks broken, and its output is pasted into issues, agent transcripts and
 * run logs. Printing the value of any of these keys turns a diagnostic into a
 * disclosure, so they are rendered as a fingerprint instead.
 *
 * Matching is on the whole suffix rather than a substring, so
 * `PAPERCLIP_SECRETS_PROVIDER` and `PAPERCLIP_SECRETS_MASTER_KEY_FILE` (a path)
 * stay readable. `DATABASE_URL` is handled separately because the credential
 * is embedded in a connection string.
 */
const SENSITIVE_KEY_SUFFIXES = [
  "_SECRET",
  "_PASSWORD",
  "_PASSPHRASE",
  "_TOKEN",
  "_PRIVATE_KEY",
  "_API_KEY",
  "_ACCESS_KEY",
  "_CREDENTIALS",
];

export function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (normalized === "DATABASE_URL" || normalized === "DATABASE_CONNECTION_STRING") return true;
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * A redaction that still lets an operator match the value they are looking at
 * against the value in a file or a record, without reproducing it.
 */
export function formatRedactedValue(value: string): string {
  if (value === "") return "<empty>";
  return `<redacted sha256:${fingerprint(value)} len=${value.length}>`;
}

/** Keeps scheme, user, host, port and database; drops the password. */
export function redactDatabaseUrl(value: string): string {
  if (value === "") return "<empty>";
  try {
    const url = new URL(value);
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return formatRedactedValue(value);
  }
}

export function displayValueForRow(row: EnvVarRow): string {
  if (row.source === "missing") return "";
  if (!isSensitiveEnvKey(row.key)) return quoteShellValue(row.value);
  if (row.key.toUpperCase().startsWith("DATABASE_")) return redactDatabaseUrl(row.value);
  return formatRedactedValue(row.value);
}

const SOURCE_LABELS: Record<EnvSource, string> = {
  env: "environment",
  config: "config",
  file: "file",
  default: "default",
  missing: "missing",
};

/** One line per variable, in the `KEY set [source] note => value` shape. */
export function formatEnvRowLines(rows: EnvVarRow[]): string[] {
  return rows.map((row) => {
    const status =
      row.source === "missing"
        ? pc.red("missing")
        : row.source === "default"
          ? pc.yellow("default")
          : pc.green("set");
    const value = row.source === "missing" ? "" : ` ${pc.dim("=>")} ${pc.white(displayValueForRow(row))}`;
    return `${pc.cyan(row.key)} ${status.padEnd(7)} ${pc.dim(`[${SOURCE_LABELS[row.source]}] ${row.note}`)}${value}`;
  });
}

/**
 * The copy-paste export block. A sensitive row emits a comment naming the
 * fingerprint and where the value lives; it never emits the value.
 */
export function buildExportBlock(rows: EnvVarRow[]): string {
  const exportRows = rows.map((row) => (row.source === "missing" ? { ...row, value: "<set-this-value>" } : row));
  return uniqueByKey(exportRows)
    .map((row) => {
      if (row.source !== "missing" && isSensitiveEnvKey(row.key)) {
        const described = row.key.toUpperCase().startsWith("DATABASE_")
          ? redactDatabaseUrl(row.value)
          : formatRedactedValue(row.value);
        return `# ${row.key} redacted (${described}) - source: ${SOURCE_LABELS[row.source]}`;
      }
      return `export ${row.key}=${quoteShellValue(row.value)}`;
    })
    .join("\n");
}


const DEFAULT_AGENT_JWT_TTL_SECONDS = "172800";
const DEFAULT_AGENT_JWT_ISSUER = "paperclip";
const DEFAULT_AGENT_JWT_AUDIENCE = "paperclip-api";
const DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS = "30000";
const DEFAULT_SECRETS_PROVIDER = "local_encrypted";
const DEFAULT_STORAGE_PROVIDER = "local_disk";
function defaultSecretsKeyFilePath(): string {
  return resolveDefaultSecretsKeyFilePath(resolvePaperclipInstanceId());
}
function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export async function envCommand(opts: { config?: string }): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" paperclip env ")));

  const configPath = resolveConfigPath(opts.config);
  let config: PaperclipConfig | null = null;
  let configReadError: string | null = null;

  if (configExists(opts.config)) {
    p.log.message(pc.dim(`Config file: ${configPath}`));
    try {
      config = readConfig(opts.config);
    } catch (err) {
      configReadError = err instanceof Error ? err.message : String(err);
      p.log.message(pc.yellow(`Could not parse config: ${configReadError}`));
    }
  } else {
    p.log.message(pc.dim(`Config file missing: ${configPath}`));
  }

  const rows = collectDeploymentEnvRows(config, configPath);
  const missingRequired = rows.filter((row) => row.required && row.source === "missing");
  const sortedRows = rows.sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key));

  const requiredRows = sortedRows.filter((row) => row.required);
  const optionalRows = sortedRows.filter((row) => !row.required);

  const formatSection = (title: string, entries: EnvVarRow[]) => {
    if (entries.length === 0) return;

    p.log.message(pc.bold(title));
    for (const line of formatEnvRowLines(entries)) p.log.message(line);
  };

  formatSection("Required environment variables", requiredRows);
  formatSection("Optional environment variables", optionalRows);

  const exportBlock = buildExportBlock(rows);
  const redactedKeys = uniqueByKey(rows)
    .filter((row) => row.source !== "missing" && isSensitiveEnvKey(row.key))
    .map((row) => row.key);

  if (configReadError) {
    p.log.error(`Could not load config cleanly: ${configReadError}`);
  }

  p.note(
    exportBlock || "No values detected. Set required variables manually.",
    "Deployment export block",
  );

  if (redactedKeys.length > 0) {
    p.log.message(
      pc.dim(
        `Redacted in this report: ${redactedKeys.join(", ")}. Values are shown as a sha256 fingerprint so you can match them without printing them; read the value from its source above (the signing secret lives in the 0600 env file).`,
      ),
    );
  }

  if (missingRequired.length > 0) {
    p.log.message(
      pc.yellow(
        `Missing required values: ${missingRequired.map((row) => row.key).join(", ")}. Set these before deployment.`,
      ),
    );
  } else {
    p.log.message(pc.green("All required deployment variables are present."));
  }
  p.outro("Done");
}

function collectDeploymentEnvRows(config: PaperclipConfig | null, configPath: string): EnvVarRow[] {
  const agentJwtEnvFile = resolveAgentJwtEnvFile(configPath);
  const jwtEnv = readAgentJwtSecretFromEnv(configPath);
  const jwtFile = jwtEnv ? null : readAgentJwtSecretFromEnvFile(agentJwtEnvFile);
  const jwtSource = jwtEnv ? "env" : jwtFile ? "file" : "missing";

  const dbUrl = process.env.DATABASE_URL ?? config?.database?.connectionString ?? "";
  const databaseMode = config?.database?.mode ?? "embedded-postgres";
  const dbUrlSource: EnvSource = process.env.DATABASE_URL ? "env" : config?.database?.connectionString ? "config" : "missing";
  const publicUrl =
    process.env.PAPERCLIP_PUBLIC_URL ??
    process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL ??
    process.env.BETTER_AUTH_URL ??
    process.env.BETTER_AUTH_BASE_URL ??
    config?.auth?.publicBaseUrl ??
    "";
  const publicUrlSource: EnvSource =
    process.env.PAPERCLIP_PUBLIC_URL
      ? "env"
      : process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL || process.env.BETTER_AUTH_URL || process.env.BETTER_AUTH_BASE_URL
        ? "env"
        : config?.auth?.publicBaseUrl
          ? "config"
          : "missing";
  let trustedOriginsDefault = "";
  if (publicUrl) {
    try {
      trustedOriginsDefault = new URL(publicUrl).origin;
    } catch {
      trustedOriginsDefault = "";
    }
  }

  const heartbeatInterval = process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ?? DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS;
  const heartbeatEnabled = process.env.HEARTBEAT_SCHEDULER_ENABLED ?? "true";
  const secretsProvider =
    process.env.PAPERCLIP_SECRETS_PROVIDER ??
    config?.secrets?.provider ??
    DEFAULT_SECRETS_PROVIDER;
  const secretsStrictMode =
    process.env.PAPERCLIP_SECRETS_STRICT_MODE ??
    String(config?.secrets?.strictMode ?? false);
  const secretsKeyFilePath =
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE ??
    config?.secrets?.localEncrypted?.keyFilePath ??
    defaultSecretsKeyFilePath();
  const storageProvider =
    process.env.PAPERCLIP_STORAGE_PROVIDER ??
    config?.storage?.provider ??
    DEFAULT_STORAGE_PROVIDER;
  const storageLocalDir =
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR ??
    config?.storage?.localDisk?.baseDir ??
    defaultStorageBaseDir();
  const storageS3Bucket =
    process.env.PAPERCLIP_STORAGE_S3_BUCKET ??
    config?.storage?.s3?.bucket ??
    "paperclip";
  const storageS3Region =
    process.env.PAPERCLIP_STORAGE_S3_REGION ??
    config?.storage?.s3?.region ??
    "us-east-1";
  const storageS3Endpoint =
    process.env.PAPERCLIP_STORAGE_S3_ENDPOINT ??
    config?.storage?.s3?.endpoint ??
    "";
  const storageS3Prefix =
    process.env.PAPERCLIP_STORAGE_S3_PREFIX ??
    config?.storage?.s3?.prefix ??
    "";
  const storageS3ForcePathStyle =
    process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE ??
    String(config?.storage?.s3?.forcePathStyle ?? false);

  const rows: EnvVarRow[] = [
    {
      key: "PAPERCLIP_AGENT_JWT_SECRET",
      value: jwtEnv ?? jwtFile ?? "",
      source: jwtSource,
      required: true,
      note:
        jwtSource === "missing"
          ? "Generate during onboard or set manually (required for local adapter authentication)"
          : jwtSource === "env"
            ? "Set in process environment"
            : `Set in ${agentJwtEnvFile}`,
    },
    {
      key: "DATABASE_URL",
      value: dbUrl,
      source: dbUrlSource,
      required: true,
      note:
        databaseMode === "postgres"
          ? "Configured for postgres mode (required)"
          : "Required for live deployment with managed PostgreSQL",
    },
    {
      key: "PORT",
      value:
        process.env.PORT ??
        (config?.server?.port !== undefined ? String(config.server.port) : "3100"),
      source: process.env.PORT ? "env" : config?.server?.port !== undefined ? "config" : "default",
      required: false,
      note: "HTTP listen port",
    },
    {
      key: "PAPERCLIP_PUBLIC_URL",
      value: publicUrl,
      source: publicUrlSource,
      required: false,
      note: "Canonical public URL for auth/callback/invite origin wiring",
    },
    {
      key: "BETTER_AUTH_TRUSTED_ORIGINS",
      value: process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? trustedOriginsDefault,
      source: process.env.BETTER_AUTH_TRUSTED_ORIGINS
        ? "env"
        : trustedOriginsDefault
          ? "default"
          : "missing",
      required: false,
      note: "Comma-separated auth origin allowlist (auto-derived from PAPERCLIP_PUBLIC_URL when possible)",
    },
    {
      key: "PAPERCLIP_AGENT_JWT_TTL_SECONDS",
      value: process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS ?? DEFAULT_AGENT_JWT_TTL_SECONDS,
      source: process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS ? "env" : "default",
      required: false,
      note: "JWT lifetime in seconds",
    },
    {
      key: "PAPERCLIP_AGENT_JWT_ISSUER",
      value: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? DEFAULT_AGENT_JWT_ISSUER,
      source: process.env.PAPERCLIP_AGENT_JWT_ISSUER ? "env" : "default",
      required: false,
      note: "JWT issuer",
    },
    {
      key: "PAPERCLIP_AGENT_JWT_AUDIENCE",
      value: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? DEFAULT_AGENT_JWT_AUDIENCE,
      source: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ? "env" : "default",
      required: false,
      note: "JWT audience",
    },
    {
      key: "HEARTBEAT_SCHEDULER_INTERVAL_MS",
      value: heartbeatInterval,
      source: process.env.HEARTBEAT_SCHEDULER_INTERVAL_MS ? "env" : "default",
      required: false,
      note: "Heartbeat worker interval in ms",
    },
    {
      key: "HEARTBEAT_SCHEDULER_ENABLED",
      value: heartbeatEnabled,
      source: process.env.HEARTBEAT_SCHEDULER_ENABLED ? "env" : "default",
      required: false,
      note: "Set to `false` to disable timer scheduling",
    },
    {
      key: "PAPERCLIP_SECRETS_PROVIDER",
      value: secretsProvider,
      source: process.env.PAPERCLIP_SECRETS_PROVIDER
        ? "env"
        : config?.secrets?.provider
          ? "config"
          : "default",
      required: false,
      note: "Default provider for new secrets",
    },
    {
      key: "PAPERCLIP_SECRETS_STRICT_MODE",
      value: secretsStrictMode,
      source: process.env.PAPERCLIP_SECRETS_STRICT_MODE
        ? "env"
        : config?.secrets?.strictMode !== undefined
          ? "config"
          : "default",
      required: false,
      note: "Require secret refs for sensitive env keys",
    },
    {
      key: "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
      value: secretsKeyFilePath,
      source: process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE
        ? "env"
        : config?.secrets?.localEncrypted?.keyFilePath
          ? "config"
          : "default",
      required: false,
      note: "Path to local encrypted secrets key file",
    },
    {
      key: "PAPERCLIP_STORAGE_PROVIDER",
      value: storageProvider,
      source: process.env.PAPERCLIP_STORAGE_PROVIDER
        ? "env"
        : config?.storage?.provider
          ? "config"
          : "default",
      required: false,
      note: "Storage provider (local_disk or s3)",
    },
    {
      key: "PAPERCLIP_STORAGE_LOCAL_DIR",
      value: storageLocalDir,
      source: process.env.PAPERCLIP_STORAGE_LOCAL_DIR
        ? "env"
        : config?.storage?.localDisk?.baseDir
          ? "config"
          : "default",
      required: false,
      note: "Local storage base directory for local_disk provider",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_BUCKET",
      value: storageS3Bucket,
      source: process.env.PAPERCLIP_STORAGE_S3_BUCKET
        ? "env"
        : config?.storage?.s3?.bucket
          ? "config"
          : "default",
      required: false,
      note: "S3 bucket name for s3 provider",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_REGION",
      value: storageS3Region,
      source: process.env.PAPERCLIP_STORAGE_S3_REGION
        ? "env"
        : config?.storage?.s3?.region
          ? "config"
          : "default",
      required: false,
      note: "S3 region for s3 provider",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_ENDPOINT",
      value: storageS3Endpoint,
      source: process.env.PAPERCLIP_STORAGE_S3_ENDPOINT
        ? "env"
        : config?.storage?.s3?.endpoint
          ? "config"
          : "default",
      required: false,
      note: "Optional custom endpoint for S3-compatible providers",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_PREFIX",
      value: storageS3Prefix,
      source: process.env.PAPERCLIP_STORAGE_S3_PREFIX
        ? "env"
        : config?.storage?.s3?.prefix
          ? "config"
          : "default",
      required: false,
      note: "Optional object key prefix",
    },
    {
      key: "PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE",
      value: storageS3ForcePathStyle,
      source: process.env.PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE
        ? "env"
        : config?.storage?.s3?.forcePathStyle !== undefined
          ? "config"
          : "default",
      required: false,
      note: "Set true for path-style access on compatible providers",
    },
  ];

  const defaultConfigPath = resolveConfigPath();
  if (process.env.PAPERCLIP_CONFIG || configPath !== defaultConfigPath) {
    rows.push({
      key: "PAPERCLIP_CONFIG",
      value: process.env.PAPERCLIP_CONFIG ?? configPath,
      source: process.env.PAPERCLIP_CONFIG ? "env" : "default",
      required: false,
      note: "Optional path override for config file",
    });
  }

  return rows;
}

function uniqueByKey(rows: EnvVarRow[]): EnvVarRow[] {
  const seen = new Set<string>();
  const result: EnvVarRow[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    result.push(row);
  }
  return result;
}

function quoteShellValue(value: string): string {
  if (value === "") return "\"\"";
  return `'${value.replaceAll("'", "'\\''")}'`;
}

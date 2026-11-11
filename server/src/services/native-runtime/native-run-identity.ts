import { createHash } from "node:crypto";

/**
 * Run-scoped Paperclip identity delivered to a native provider process.
 *
 * Some providers (notably the OpenCode server) run shell commands from the
 * provider process, not from a Paperclip-spawned child. Their environment is
 * frozen when the provider starts, so every value here must be the current
 * heartbeat run's value. They are deliberately not part of the configured
 * environment projection, which is reserved for agent-selected configuration
 * and excludes generated runtime keys.
 */
export const NATIVE_RUN_IDENTITY_ENV_KEYS = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
] as const;

export type NativeRunIdentityEnvironmentInput = {
  apiKey: string | null | undefined;
  apiUrl: string | null | undefined;
  agentId: string;
  companyId: string;
  runId: string;
  taskId: string | null | undefined;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A run-scoped credential is a short-lived local agent JWT, never a
 * long-lived board key. Missing values are omitted rather than inherited from
 * the service process.
 */
export function buildNativeRunIdentityEnvironment(
  input: NativeRunIdentityEnvironmentInput,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PAPERCLIP_AGENT_ID: input.agentId,
    PAPERCLIP_COMPANY_ID: input.companyId,
    PAPERCLIP_RUN_ID: input.runId,
  };
  const apiKey = nonEmpty(input.apiKey);
  const apiUrl = nonEmpty(input.apiUrl);
  const taskId = nonEmpty(input.taskId);
  if (apiKey) environment.PAPERCLIP_API_KEY = apiKey;
  if (apiUrl) environment.PAPERCLIP_API_URL = apiUrl;
  if (taskId) environment.PAPERCLIP_TASK_ID = taskId;
  return environment;
}

/**
 * Fingerprint of the identity a provider process actually launched with.
 *
 * A warm provider keeps the environment it was spawned with. When this digest
 * changes between runs the process must be replaced; otherwise the next run's
 * shell would still present the previous (possibly terminal) run id and its
 * expired credential.
 */
export function nativeRunIdentityEnvironmentDigest(
  environment: NodeJS.ProcessEnv | null | undefined,
): string {
  if (!environment) return "";
  const selected = NATIVE_RUN_IDENTITY_ENV_KEYS.map((key) => {
    const value = nonEmpty(environment[key]);
    // A local agent JWT is re-minted for every execution of the same run (new
    // `iat`/`jti`). Its exact value is not part of the provider's identity:
    // the same run re-minting an equivalent credential must not force a warm
    // provider replacement. Presence still matters, and a different run
    // changes `PAPERCLIP_RUN_ID` (and therefore the digest).
    if (key === "PAPERCLIP_API_KEY") {
      return [key, value === null ? null : "<present>"];
    }
    return [key, value];
  });
  if (selected.every(([, value]) => value === null)) return "";
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(selected))
    .digest("hex")}`;
}

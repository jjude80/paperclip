import { readFileSync } from "node:fs";

/**
 * Bearer values that must not reach a run's process environment, and the file
 * path each one is carried by instead. NEXA-643.
 *
 * This table is the single definition: the adapter writes the files, and the
 * command-line clients (`paperclipai connections`, the MCP server, the GitHub
 * launcher) read them. A consumer that invents its own spelling strands a run;
 * see `SECRET_FILE_CARRIERS` in the adapter for the write half.
 *
 * `PAPERCLIP_API_TOKEN_FILE` is deliberately not `PAPERCLIP_API_KEY_FILE`. Two
 * board scripts (`agent-report.sh`, `check-disposition.sh`) and the agent error
 * watchdog already read that exact name, and NEXA-636's store scan already
 * treats it as a path rather than a value.
 */
export interface SecretFileCarrier {
  /** Environment variable that carried the value before NEXA-643. */
  key: string;
  /** Environment variable that carries the file path instead. */
  fileKey: string;
  /** Basename inside the per-run private directory. Never contains a value. */
  fileName: string;
}

export const SECRET_FILE_CARRIERS: readonly SecretFileCarrier[] = [
  { key: "PAPERCLIP_API_KEY", fileKey: "PAPERCLIP_API_TOKEN_FILE", fileName: "board-token" },
  {
    key: "PAPERCLIP_RUNTIME_TOOLS_TOKEN",
    fileKey: "PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE",
    fileName: "runtime-tools-token",
  },
  {
    key: "PAPERCLIP_GITHUB_BROKER_TOKEN",
    fileKey: "PAPERCLIP_GITHUB_BROKER_TOKEN_FILE",
    fileName: "github-broker-token",
  },
  {
    key: "PAPERCLIP_AGENT_PRIVATE_KEY",
    fileKey: "PAPERCLIP_AGENT_PRIVATE_KEY_FILE",
    fileName: "agent-identity.pem",
  },
];

/**
 * Read a carrier from its file, falling back to the legacy environment value so
 * one binary works before and after the migration is live on the board.
 *
 * An unreadable file falls through to the legacy value rather than reporting
 * "no credential": the two are different answers and the caller must be able to
 * tell an empty environment from a broken carrier.
 */
export function readSecretCarrier(
  env: Record<string, string | undefined>,
  carrier: Pick<SecretFileCarrier, "key" | "fileKey">,
  readFile: (file: string) => string = (file) => readFileSync(file, "utf8"),
): string | null {
  const file = env[carrier.fileKey];
  if (typeof file === "string" && file.trim().length > 0) {
    try {
      const value = readFile(file.trim()).trim();
      if (value.length > 0) return value;
    } catch {
      // Fall through to the legacy value.
    }
  }
  const legacy = env[carrier.key];
  return typeof legacy === "string" && legacy.trim().length > 0 ? legacy.trim() : null;
}

/** The board bearer, from `PAPERCLIP_API_TOKEN_FILE` or the legacy variable. */
export function readBoardToken(env: Record<string, string | undefined> = process.env): string | null {
  return readSecretCarrier(env, { key: "PAPERCLIP_API_KEY", fileKey: "PAPERCLIP_API_TOKEN_FILE" });
}

/** The runtime-tools bearer used by `paperclipai connections` and the MCP server. */
export function readRuntimeToolsToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return readSecretCarrier(env, {
    key: "PAPERCLIP_RUNTIME_TOOLS_TOKEN",
    fileKey: "PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE",
  });
}

/** The GitHub broker capability used by the staged launcher. */
export function readGithubBrokerToken(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return readSecretCarrier(env, {
    key: "PAPERCLIP_GITHUB_BROKER_TOKEN",
    fileKey: "PAPERCLIP_GITHUB_BROKER_TOKEN_FILE",
  });
}

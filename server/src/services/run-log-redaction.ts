import { promises as fs } from "node:fs";
import path from "node:path";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// Secret material reaches the run log through ordinary tool output: an agent
// can `cat` a token file, print its environment, or echo a credential in a
// failing command. Redacting at the read/API boundary is not enough because the
// NDJSON file is readable on disk (and mirrored to object storage) long after
// the run finishes. This module is the write-time filter for that sink.
//
// Two classes are handled:
//   1. Literal values this process already knows: its own environment, the
//      instance secrets directory, `*_FILE` credential files, and the per-run
//      registry of secrets injected into a run.
//   2. Credential shapes for tokens that may never appear as a literal here
//      (for example a value an operator pasted into a terminal): Paperclip
//      board/agent keys, GitHub tokens, provider API keys, bearer headers,
//      private-key blocks and credentialed connection strings.
//
// A short tail is held back between chunks so a value split across two output
// chunks is still matched as a whole. This mirrors the agent identity redactor
// and is required because adapters stream token deltas.

const MIN_LITERAL_LENGTH = 8;
const MAX_SECRET_FILE_BYTES = 256 * 1024;
// A held token prefix is bounded so a malformed one cannot stall the log tail.
const MAX_HELD_TOKEN_PREFIX = 4_096;

const SECRET_ENV_NAME_RE =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIALS?|AUTH)(?:_|$)/i;
const NON_VALUE_ENV_NAME_RE =
  /(?:PUBLIC|_NAME|_PATH|_FILE|_URL|_URI|_DIR|_ID|_MODE|_TYPE|_EXPIRES?|_ALGORITHM|_HEADER|_PREFIX|_ENABLED|_REQUIRED)$/i;

type RedactionPattern = {
  kind: string;
  regex: RegExp;
  replacement: string;
};

// Order matters: the more specific Paperclip prefixes must win before the
// generic `pcp_` agent-key shape.
const CREDENTIAL_PATTERNS: RedactionPattern[] = [
  {
    kind: "pem_private_key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "paperclip_board_key",
    regex: /\bpcp_board_[0-9a-f]{24,}\b/gi,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "paperclip_cli_auth_secret",
    regex: /\bpcp_cli_auth_[0-9a-f]{24,}\b/gi,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "paperclip_agent_key",
    regex: /\bpcp_[0-9a-f]{24,}\b/gi,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "paperclip_tool_gateway_token",
    regex: /\bpcgw_[A-Za-z0-9._-]{16,}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "paperclip_file_consent_token",
    regex: /\bpcfc_[A-Za-z0-9_-]{16,}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "github_token",
    regex: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "provider_api_key",
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "slack_token",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "aws_access_key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "bearer_token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: `Bearer ${REDACTED_EVENT_VALUE}`,
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED_EVENT_VALUE,
  },
  {
    kind: "credentialed_connection_string",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|nats|mssql):\/\/[^\s:@/]+:[^\s@/]+@[^\s<>'")]+/gi,
    replacement: REDACTED_EVENT_VALUE,
  },
];

// A suffix that could be the beginning of a credential token. Used only to
// hold a partial token for the next chunk; complete tokens are replaced above.
const TOKEN_PREFIX_TAIL_RE =
  /(?:^|[^A-Za-z0-9])(?:pcp_|pcgw_|pcfc_|gh[pousr]_|github_pat_|sk-|xox[abprs]-|Bearer\s)[A-Za-z0-9._~+/-]*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueValues(values: Iterable<string>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length < MIN_LITERAL_LENGTH) continue;
    unique.add(trimmed);
    // JSON-encoded output escapes newlines/quotes in a PEM or JSON secret.
    const jsonEscaped = JSON.stringify(trimmed).slice(1, -1);
    if (jsonEscaped.length >= MIN_LITERAL_LENGTH) unique.add(jsonEscaped);
    if (trimmed.includes("\r\n")) unique.add(trimmed.replace(/\r\n/g, "\n"));
  }
  return [...unique].sort((left, right) => right.length - left.length);
}

function stringsFromJson(value: unknown, output: string[]) {
  if (typeof value === "string") {
    if (value.trim().length >= MIN_LITERAL_LENGTH) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsFromJson(entry, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const entry of Object.values(record)) stringsFromJson(entry, output);
}

function looksLikeNonSecretValue(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < MIN_LITERAL_LENGTH) return true;
  if (/^(?:true|false|null|none|undefined|default|placeholder|changeme)$/i.test(trimmed)) return true;
  // Env names that describe a credential rather than carry one.
  if (NON_VALUE_ENV_NAME_RE.test(name)) return true;
  return false;
}

export function collectEnvironmentSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !SECRET_ENV_NAME_RE.test(name)) continue;
    if (looksLikeNonSecretValue(name, value)) continue;
    values.push(value);
  }
  return values;
}

/** Credential files an operator pointed at through `*_FILE` env names. */
export function resolveSecretFilePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !name.endsWith("_FILE")) continue;
    if (!SECRET_ENV_NAME_RE.test(name)) continue;
    if (!value.trim() || !path.isAbsolute(value.trim())) continue;
    paths.add(value.trim());
  }
  // The instance secrets directory holds the encryption master key and the
  // cloud connector credential. They are readable by this process but must
  // never appear in agent output.
  paths.add(path.resolve(resolvePaperclipInstanceRoot(), "secrets"));
  return [...paths];
}

async function readSecretFileValues(filePath: string, output: string[]) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    const entries = await fs.readdir(filePath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) await readSecretFileValues(path.join(filePath, entry.name), output);
    }
    return;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SECRET_FILE_BYTES) return;
  const content = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!content) return;
  output.push(content);
  if (path.extname(filePath).toLowerCase() === ".json") {
    try {
      stringsFromJson(JSON.parse(content), output);
    } catch {
      // A malformed secret file still contributes its literal bytes above.
    }
  }
}

export async function collectRunLogLiteralSecrets(options: {
  env?: NodeJS.ProcessEnv;
  secretFilePaths?: Iterable<string>;
} = {}): Promise<string[]> {
  const env = options.env ?? process.env;
  const values = collectEnvironmentSecretValues(env);
  const paths = options.secretFilePaths ?? resolveSecretFilePaths(env);
  for (const filePath of paths) await readSecretFileValues(filePath, values);
  return uniqueValues(values);
}

function redactPatterns(input: string): string {
  let output = input;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.regex.lastIndex = 0;
    output = output.replace(pattern.regex, pattern.replacement);
    pattern.regex.lastIndex = 0;
  }
  return output;
}

function redactWithValues(input: string, values: string[]): string {
  let output = input;
  for (const value of values) {
    if (value.length < MIN_LITERAL_LENGTH) continue;
    output = output.split(value).join(REDACTED_EVENT_VALUE);
  }
  return redactPatterns(output);
}

export function redactRunLogText(input: string, literalValues: Iterable<string> = []): string {
  return redactWithValues(input, uniqueValues(literalValues));
}

// Holding a 1-3 character suffix would stall on any ordinary word ending in
// the same letter as a secret's first character. A real split fragment needs at
// least this much of the value to be useful for redaction anyway.
const MIN_HELD_PREFIX = 4;

function heldSuffixLength(input: string, literalValues: string[]): number {
  let held = 0;
  for (const value of literalValues) {
    const max = Math.min(value.length - 1, input.length);
    if (max < MIN_HELD_PREFIX) continue;
    // Longest prefix of `value` that is a suffix of `input`. Starting the
    // suffix as late as possible yields the match directly, so ordinary output
    // costs one character scan per value instead of slicing every possible
    // prefix length.
    const tail = input.slice(-max);
    const first = value.charCodeAt(0);
    for (let index = 0; index <= tail.length - MIN_HELD_PREFIX; index += 1) {
      if (tail.charCodeAt(index) !== first) continue;
      const size = tail.length - index;
      if (value.startsWith(tail.slice(index))) {
        held = Math.max(held, size);
        break;
      }
    }
  }
  const tokenTail = TOKEN_PREFIX_TAIL_RE.exec(input);
  if (tokenTail) {
    const token = tokenTail[0].replace(/^[^A-Za-z0-9]+/, "");
    held = Math.max(held, Math.min(token.length, MAX_HELD_TOKEN_PREFIX));
  }
  return held;
}

export interface RunLogRedactor {
  push(stream: string, chunk: string): string;
  finish(stream: string): string;
}

/**
 * Streaming redactor. Holds only a suffix that could be the beginning of a
 * known literal or a credential token, so a value split across chunks is
 * redacted as a whole instead of leaking its tail.
 */
export function createRunLogRedactor(literalValues: Iterable<string> = []): RunLogRedactor {
  const values = uniqueValues(literalValues);
  const pending = new Map<string, string>();
  return {
    push(stream, chunk) {
      const combined = (pending.get(stream) ?? "") + chunk;
      const held = heldSuffixLength(combined, values);
      if (held > 0) pending.set(stream, combined.slice(-held));
      else pending.delete(stream);
      const emitted = held > 0 ? combined.slice(0, -held) : combined;
      return redactWithValues(emitted, values);
    },
    finish(stream) {
      const tail = pending.get(stream) ?? "";
      pending.delete(stream);
      if (!tail) return "";
      // An interrupted fragment of a secret must never be flushed as plaintext.
      const couldBePartialSecret =
        tail.length >= 4 &&
        (values.some((value) => value.startsWith(tail)) || TOKEN_PREFIX_TAIL_RE.test(tail));
      return couldBePartialSecret ? REDACTED_EVENT_VALUE : redactWithValues(tail, values);
    },
  };
}

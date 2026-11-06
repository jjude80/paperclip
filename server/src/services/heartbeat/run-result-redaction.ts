import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../../redaction.js";
import { redactRunFailureSecretValues } from "../run-failure-diagnostics.js";

/**
 * Shortest value that is treated as exact secret material.
 *
 * Exact-value redaction replaces every occurrence of a value in a string, so a
 * short common word that happens to be an environment value ("true", "local",
 * a single-digit port) would shred unrelated run output. Structural redaction
 * still covers those values when they appear as `KEY=value` or as a token
 * shape; this filter only governs the literal inventory.
 */
export const MIN_EXACT_SECRET_VALUE_LENGTH = 8;

/** Bound for the recursive walk: adapter result JSON is shallow by contract. */
const MAX_REDACTION_DEPTH = 12;

/**
 * Redact everything in an adapter result before it is persisted as
 * `heartbeat_runs.result_json`.
 *
 * Two passes, because they catch different leaks:
 *   1. the run's secret inventory, matched literally (including JSON-escaped and
 *      URI-encoded forms) — this is what catches a bare `VAR=value` whose name
 *      does not look like a credential, and a value echoed without its name;
 *   2. the structural redactor used for run logs (`redactSensitiveText`) — this
 *      catches credential-shaped text the inventory does not know about
 *      (`Authorization: Bearer …`, `sk-…`, JWT-shaped strings, JSON secret
 *      fields).
 *
 * Both passes are idempotent: an existing `***REDACTED***` marker is left
 * alone rather than replaced again.
 */
export function redactPersistedRunResultJson<T>(
  value: T,
  secretValues: readonly string[] = [],
): T {
  const exact = secretValues.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length >= MIN_EXACT_SECRET_VALUE_LENGTH,
  );
  const inventoryRedacted =
    exact.length > 0 ? redactRunFailureSecretValues(value, exact) : value;
  return mapStrings(inventoryRedacted) as T;
}

function mapStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (depth >= MAX_REDACTION_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => mapStrings(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        mapStrings(entry, depth + 1),
      ]),
    );
  }
  return value;
}

/** The marker both redaction passes write; re-exported so callers need one import. */
export { REDACTED_EVENT_VALUE };

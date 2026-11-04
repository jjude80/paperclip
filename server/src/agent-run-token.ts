/**
 * A run token is minted for exactly one run and injected into that run's
 * environment. It is not a durable agent credential: once the run is over the
 * token must stop authenticating. Otherwise every leaked token — curl argv,
 * a log line, a crash dump, a published deploy-waiter shell — keeps the agent's
 * full board authority for the remainder of the JWT TTL (48h by default), and
 * there is no per-run revocation route to cut it short.
 *
 * `finishedAt` is the lifecycle fact, not the status string: it is written by
 * whichever path ends the run (success, failure, cancel, timeout), so a new
 * terminal status cannot silently escape this check.
 *
 * The grace window absorbs requests that were already in flight when the run
 * row was closed and small clock skew between the runner and the board.
 */
export const AGENT_RUN_TOKEN_GRACE_MS = 60_000;

export function agentRunTokenExpired(
  run: { finishedAt?: Date | string | null } | null | undefined,
  now: number = Date.now(),
  graceMs: number = AGENT_RUN_TOKEN_GRACE_MS,
): boolean {
  if (!run?.finishedAt) return false;
  const finishedAt =
    run.finishedAt instanceof Date ? run.finishedAt.getTime() : new Date(run.finishedAt).getTime();
  if (!Number.isFinite(finishedAt)) return false;
  return now - finishedAt > graceMs;
}

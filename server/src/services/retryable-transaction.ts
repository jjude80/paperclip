// Replay a database transaction that PostgreSQL aborted because of lock
// contention. Both codes below guarantee the transaction wrote nothing, so a
// retry cannot duplicate an effect; only the caller's in-memory staging has to
// be reset between attempts.

/** `40001` serialization_failure and `40P01` deadlock_detected. */
const RETRYABLE_TRANSACTION_CODES = new Set(["40001", "40P01"]);

export function isRetryableTransactionError(error: unknown): boolean {
  const direct = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return (typeof direct === "string" && RETRYABLE_TRANSACTION_CODES.has(direct)) ||
    (typeof cause === "string" && RETRYABLE_TRANSACTION_CODES.has(cause));
}

/**
 * Runs `attempt`, replaying it up to `retries` extra times when PostgreSQL
 * picks it as a deadlock or serialization victim. Every other error is thrown
 * unchanged on the first attempt. The caller's `attempt` must be safe to run
 * again from its first statement and must reset any in-memory staging itself.
 */
export async function retryTransaction<T>(
  attempt: () => Promise<T>,
  retries = 2,
  delayMs = 10,
): Promise<T> {
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (attemptIndex >= retries || !isRetryableTransactionError(error)) throw error;
      // A short, increasing pause keeps two racing writers out of lockstep so
      // they do not deadlock on the replay as well.
      await new Promise<void>(resolve => setTimeout(resolve, delayMs * (attemptIndex + 1)));
    }
  }
}

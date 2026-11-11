import { describe, expect, it, vi } from "vitest";
import { isRetryableTransactionError, retryTransaction } from "../services/retryable-transaction.js";

const postgresError = (code: string) => Object.assign(new Error(`database error ${code}`), { code });

describe("retryTransaction", () => {
  it("replays a deadlock or serialization victim and returns the committed result", async () => {
    for (const code of ["40P01", "40001"]) {
      const attempt = vi.fn().mockRejectedValueOnce(postgresError(code)).mockResolvedValueOnce("committed");
      await expect(retryTransaction(attempt)).resolves.toBe("committed");
      expect(attempt).toHaveBeenCalledTimes(2);
    }
  });

  it("recognizes a retryable code nested in the error cause", () => {
    const cause = new Error("deadlock detected");
    expect(isRetryableTransactionError(Object.assign(new Error("query failed"), { cause: { code: "40P01" } }))).toBe(true);
    expect(isRetryableTransactionError(Object.assign(new Error("query failed"), { cause }))).toBe(false);
  });

  it("rethrows everything else on the first attempt", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(postgresError("55P03"));
    await expect(retryTransaction(attempt)).rejects.toMatchObject({ code: "55P03" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget instead of looping", async () => {
    const attempt = vi.fn().mockRejectedValue(postgresError("40P01"));
    await expect(retryTransaction(attempt, 2, 0)).rejects.toMatchObject({ code: "40P01" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

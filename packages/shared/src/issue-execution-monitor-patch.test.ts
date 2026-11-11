import { describe, expect, it } from "vitest";
import { issueExecutionMonitorPolicyPatchSchema } from "./validators/issue.js";

describe("issue execution monitor PATCH schema", () => {
  it("leaves absent monitor keys absent instead of defaulting them to null", () => {
    const parsed = issueExecutionMonitorPolicyPatchSchema.parse({ notes: "Check the unit again." });

    expect(parsed).toEqual({ notes: "Check the unit again." });
    expect(Object.keys(parsed)).toEqual(["notes"]);
  });

  it("still accepts an explicit null to clear a field", () => {
    const parsed = issueExecutionMonitorPolicyPatchSchema.parse({
      nextCheckAt: "2026-12-01T12:00:00.000Z",
      serviceName: null,
    });

    expect(parsed).toEqual({
      nextCheckAt: "2026-12-01T12:00:00.000Z",
      serviceName: null,
    });
  });

  it("keeps validating the field rules it exposes", () => {
    const result = issueExecutionMonitorPolicyPatchSchema.safeParse({ maxAttempts: 0 });

    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildNativeRunIdentityEnvironment,
  nativeRunIdentityEnvironmentDigest,
} from "./native-run-identity.js";

const runId = "11111111-2222-4333-8444-555555555555";

function environment(overrides: Partial<Parameters<typeof buildNativeRunIdentityEnvironment>[0]> = {}) {
  return buildNativeRunIdentityEnvironment({
    apiKey: "run-scoped-jwt",
    apiUrl: "http://127.0.0.1:3100",
    agentId: "agent-1",
    companyId: "company-1",
    runId,
    taskId: "issue-1",
    ...overrides,
  });
}

describe("native run identity environment", () => {
  it("delivers the current run's identity to a service-hosted provider", () => {
    expect(environment()).toEqual({
      PAPERCLIP_API_KEY: "run-scoped-jwt",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_RUN_ID: runId,
      PAPERCLIP_TASK_ID: "issue-1",
    });
  });

  it("omits missing credentials instead of inheriting the service environment", () => {
    const built = environment({ apiKey: null, apiUrl: "  ", taskId: null });
    expect(built).not.toHaveProperty("PAPERCLIP_API_KEY");
    expect(built).not.toHaveProperty("PAPERCLIP_API_URL");
    expect(built).not.toHaveProperty("PAPERCLIP_TASK_ID");
    expect(built.PAPERCLIP_RUN_ID).toBe(runId);
  });

  it("changes the warm-provider digest when a resumed conversation changes run", () => {
    const first = nativeRunIdentityEnvironmentDigest(environment());
    const resumed = nativeRunIdentityEnvironmentDigest(
      environment({ runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", apiKey: "new-run-jwt" }),
    );
    expect(first).not.toBe("");
    expect(resumed).not.toBe(first);
  });

  it("keeps the digest stable for the same run", () => {
    expect(nativeRunIdentityEnvironmentDigest(environment())).toBe(
      nativeRunIdentityEnvironmentDigest(environment()),
    );
  });

  it("keeps the digest stable when the same run re-mints its credential", () => {
    expect(nativeRunIdentityEnvironmentDigest(environment({ apiKey: "reminted-run-jwt" }))).toBe(
      nativeRunIdentityEnvironmentDigest(environment({ apiKey: "original-run-jwt" })),
    );
  });

  it("has no digest when the provider receives no run identity", () => {
    expect(nativeRunIdentityEnvironmentDigest({ PATH: "/bin" })).toBe("");
  });
});

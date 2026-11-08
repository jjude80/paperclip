import { describe, expect, it } from "vitest";

import {
  assertCliTestUserBusIsolated,
  LiveUserBusReachableError,
} from "./helpers/user-bus-preflight.js";

/**
 * NEXA-861: the preflight must fail closed. These tests inject the probe so
 * they can describe the dangerous state without ever asking the real bus.
 */
describe("CLI test user-bus preflight", () => {
  it("refuses to run when a live paperclipai.service is reachable", () => {
    expect(() => assertCliTestUserBusIsolated({ probe: () => ({ reachable: true, active: true }) }))
      .toThrow(LiveUserBusReachableError);
    expect(() => assertCliTestUserBusIsolated({ probe: () => ({ reachable: true, active: true }) }))
      .toThrow(/Refusing to run CLI tests/);
  });

  it("allows the run when the isolated bus cannot be reached", () => {
    expect(() => assertCliTestUserBusIsolated({ probe: () => ({ reachable: false, active: false }) }))
      .not.toThrow();
  });

  it("allows the run when the unit exists but is not active", () => {
    // `systemctl show` can answer on the real bus without the unit running;
    // stopping an inactive unit costs nothing, so this is not a refusal.
    expect(() => assertCliTestUserBusIsolated({ probe: () => ({ reachable: true, active: false }) }))
      .not.toThrow();
  });
});

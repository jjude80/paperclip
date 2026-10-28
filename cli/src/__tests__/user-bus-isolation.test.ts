import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * The cli vitest project must never inherit the operator's user bus.
 *
 * NEXA-714: a CLI test run stopped the live `paperclipai.service` and took the
 * board down. The runner guard is in-process and depended on `VITEST` still
 * being in `process.env`; this suite proves the second, process-boundary layer
 * configured in `cli/vitest.config.ts` is actually in force.
 */
describe("CLI test isolation from the live user bus", () => {
  it("points XDG_RUNTIME_DIR and the session bus at a test-only directory", () => {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    expect(runtimeDir).toBeTruthy();
    expect(runtimeDir).not.toBe(`/run/user/${process.getuid?.() ?? ""}`);
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${runtimeDir}/bus`);
  });

  it("inherits the isolated runtime dir into child processes", () => {
    const child = execFileSync(process.execPath, ["-p", "process.env.XDG_RUNTIME_DIR"], { encoding: "utf8" }).trim();
    expect(child).toBe(process.env.XDG_RUNTIME_DIR);
  });

  it("cannot reach a real user manager, even without the runner guard", async () => {
    // Deliberately bypass defaultCommandRunner: this asks the OS directly, so
    // the only thing that can stop it is the unreachable bus set up for us.
    await expect(execFileAsync("systemctl", ["--user", "show-environment"], { encoding: "utf8" }))
      .rejects.toThrow();
  });
});

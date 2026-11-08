import { execFileSync } from "node:child_process";

/**
 * Defence in depth for CLI tests that would otherwise reach the operator's
 * real user bus (NEXA-861).
 *
 * `cli/vitest.config.ts` already points `XDG_RUNTIME_DIR` and
 * `DBUS_SESSION_BUS_ADDRESS` at an empty directory in `isolate-user-bus.ts`.
 * That is the isolation. This is the preflight that proves the isolation
 * actually took effect before a single test body runs: if the process can
 * still ask the real user manager about a live `paperclipai.service`, the test
 * run must fail closed instead of risking `systemctl --user stop`.
 *
 * A repo guard cannot protect a tree that predates it. For a current tree the
 * only safe outcome is to refuse, because once a test reaches the manager the
 * board is already going down.
 */

const SERVICE_NAME = "paperclipai.service";

export type LiveServiceProbe = () => { reachable: boolean; active: boolean };

/**
 * Ask the user manager about the live unit using the *current* environment.
 * Read-only (`systemctl show`), short timeout, and any failure (no bus, no
 * systemd, non-Linux) is reported as "not reachable".
 */
export const probeLivePaperclipService: LiveServiceProbe = () => {
  try {
    const stdout = execFileSync(
      "systemctl",
      ["--user", "show", "-p", "ActiveState", SERVICE_NAME],
      {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      },
    );
    return { reachable: true, active: /^ActiveState=(active|activating|reloading)$/m.test(stdout) };
  } catch {
    return { reachable: false, active: false };
  }
};

export class LiveUserBusReachableError extends Error {
  constructor(serviceName = SERVICE_NAME) {
    super(
      `Refusing to run CLI tests: this process can reach a live ${serviceName} on the real user bus, ` +
        "so CLI test isolation is not in effect. A single missed `CommandRunner` injection here " +
        "would stop the live board and interrupt every in-flight run (NEXA-582, NEXA-714, NEXA-861). " +
        "Run the suite through `cli/vitest.config.ts` so `XDG_RUNTIME_DIR` and " +
        "`DBUS_SESSION_BUS_ADDRESS` point at an empty temp directory, or set them yourself.",
    );
    this.name = "LiveUserBusReachableError";
  }
}

/**
 * Fail closed when the process can still reach a live service on the real bus.
 * Called from the CLI test setup file *after* it applies isolation, so a
 * green run is also proof that the isolation works in this environment.
 */
export function assertCliTestUserBusIsolated(options: { probe?: LiveServiceProbe } = {}): void {
  const probe = options.probe ?? probeLivePaperclipService;
  const result = probe();
  if (result.reachable && result.active) {
    throw new LiveUserBusReachableError();
  }
}

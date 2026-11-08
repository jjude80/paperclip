import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertCliTestUserBusIsolated } from "./user-bus-preflight.js";

/**
 * Point the user bus at a directory that has no bus in it, for every CLI test.
 *
 * NEXA-582 stopped the install/uninstall suites from calling the host service
 * manager, but it left the *process boundary* open: any other test that forgot
 * to inject a `CommandRunner`, or any child process a test spawns, inherited
 * the operator's `XDG_RUNTIME_DIR` and could run `systemctl --user stop
 * paperclipai.service` for real. That happened again on 2026-10-28 during
 * `vitest run cli` and took the live board down for 98 seconds (NEXA-714).
 *
 * The guard in `services/service-manager.ts` is still the first line of
 * defence, because it fails a test with a clear message. This is the second:
 * even a path that never imports the guard, or that replaces `process.env`
 * and drops `VITEST`, cannot reach the live bus, because there is no bus at
 * the address it is given.
 */
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-test-runtime-"));
fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

process.env.XDG_RUNTIME_DIR = runtimeDir;
process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtimeDir, "bus")}`;

// Defence in depth (NEXA-861): set up the fake bus above, then prove it is
// really unreachable. If this process can still see a live `paperclipai.service`
// on the operator's bus, the isolation did not take effect and the run must
// fail closed before any test can reach `systemctl --user stop`.
assertCliTestUserBusIsolated();

process.once("exit", () => {
  try {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    // An empty temp directory left behind is not worth failing a test run over.
  }
});

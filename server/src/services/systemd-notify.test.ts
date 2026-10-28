import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyStartupStatus, systemdNotify } from "./systemd-notify.js";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

function lastArgs(): string[] {
  const call = execFileMock.mock.calls.at(-1) as unknown[] | undefined;
  return (call?.[1] as string[] | undefined) ?? [];
}

describe("systemd notify helper", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execFileMock.mockImplementation((_command, _args, _options, callback) => callback(null));
  });

  afterEach(() => {
    delete process.env.NOTIFY_SOCKET;
  });

  it("does nothing when the process is not supervised by systemd", async () => {
    delete process.env.NOTIFY_SOCKET;
    expect(await systemdNotify(["--ready"])).toBe(false);
    notifyStartupStatus("Starting: loading configuration");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("sends STATUS without READY so a slow boot is visible but still activating", () => {
    process.env.NOTIFY_SOCKET = "/run/systemd/notify";
    notifyStartupStatus("Starting: recovering interrupted run state");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(lastArgs()).toEqual(["--status=Starting: recovering interrupted run state"]);
    expect(lastArgs()).not.toContain("--ready");
  });

  it("reports a failed notify call instead of throwing", async () => {
    process.env.NOTIFY_SOCKET = "/run/systemd/notify";
    execFileMock.mockImplementation((_command, _args, _options, callback) => callback(new Error("ENOENT")));
    expect(await systemdNotify(["--ready"])).toBe(false);
  });
});

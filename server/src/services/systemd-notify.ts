import { execFile } from "node:child_process";

export async function systemdNotify(args: string[]): Promise<boolean> {
  if (!process.env.NOTIFY_SOCKET?.trim()) return false;
  return await new Promise<boolean>((resolve) => {
    execFile("systemd-notify", args, { windowsHide: true }, (error) => resolve(!error));
  });
}

/**
 * Update the unit's STATUS= line without sending READY=1. While the service is
 * still activating, systemd shows this in `systemctl status`; it is the only
 * signal that distinguishes a slow boot from a hung one. Never awaited: a
 * missing or failing systemd-notify binary must not affect startup.
 */
export function notifyStartupStatus(status: string): void {
  if (!process.env.NOTIFY_SOCKET?.trim()) return;
  void systemdNotify([`--status=${status}`]);
}

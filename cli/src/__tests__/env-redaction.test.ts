import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExportBlock,
  envCommand,
  formatEnvRowLines,
  formatRedactedValue,
  isSensitiveEnvKey,
  redactDatabaseUrl,
  type EnvVarRow,
} from "../commands/env.js";

const LIVE_SECRET = "b7d1c0a4e2f35a6984c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3";

function row(overrides: Partial<EnvVarRow> & Pick<EnvVarRow, "key" | "value">): EnvVarRow {
  return {
    source: "env",
    required: false,
    note: "note",
    ...overrides,
  };
}

// picocolors disables itself when the destination is not a TTY, but the tests
// must hold whether or not the runner sets FORCE_COLOR.
function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("isSensitiveEnvKey", () => {
  it.each([
    "PAPERCLIP_AGENT_JWT_SECRET",
    "BETTER_AUTH_SECRET",
    "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
    "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
    "PAPERCLIP_GITHUB_TOKEN",
    "POSTGRES_PASSWORD",
    "PAPERCLIP_AGENT_PRIVATE_KEY",
    "DATABASE_URL",
  ])("treats %s as a credential", (key) => {
    expect(isSensitiveEnvKey(key)).toBe(true);
  });

  it.each([
    "PAPERCLIP_SECRETS_PROVIDER",
    "PAPERCLIP_SECRETS_STRICT_MODE",
    "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
    "PORT",
    "PAPERCLIP_PUBLIC_URL",
    "PAPERCLIP_AGENT_JWT_TTL_SECONDS",
    "PAPERCLIP_STORAGE_LOCAL_DIR",
  ])("leaves %s readable", (key) => {
    expect(isSensitiveEnvKey(key)).toBe(false);
  });
});

describe("formatRedactedValue", () => {
  it("prints a fingerprint and a length, never the value", () => {
    const rendered = formatRedactedValue(LIVE_SECRET);

    expect(rendered).not.toContain(LIVE_SECRET);
    expect(rendered).toMatch(/^<redacted sha256:[0-9a-f]{12} len=\d+>$/);
    expect(rendered).toContain(`len=${LIVE_SECRET.length}`);
  });

  it("is stable for the same value and differs for another", () => {
    expect(formatRedactedValue(LIVE_SECRET)).toBe(formatRedactedValue(LIVE_SECRET));
    expect(formatRedactedValue(LIVE_SECRET)).not.toBe(formatRedactedValue(`${LIVE_SECRET}x`));
  });

  it("names an empty value instead of rendering an empty field", () => {
    expect(formatRedactedValue("")).toBe("<empty>");
  });
});

describe("redactDatabaseUrl", () => {
  it("keeps the shape of the connection string and drops the password", () => {
    const redacted = redactDatabaseUrl("postgres://paperclip:hunter2@127.0.0.1:5432/paperclip");

    expect(redacted).toContain("paperclip:");
    expect(redacted).toContain("127.0.0.1:5432/paperclip");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("redacted");
  });

  it("falls back to a fingerprint when the string is not a URL", () => {
    const redacted = redactDatabaseUrl("not a url at all");

    expect(redacted).toMatch(/^<redacted sha256:/);
    expect(redacted).not.toContain("not a url");
  });
});

describe("formatted output", () => {
  const rows: EnvVarRow[] = [
    row({ key: "PAPERCLIP_AGENT_JWT_SECRET", value: LIVE_SECRET, required: true, note: "Set in /x/.env" }),
    row({ key: "DATABASE_URL", value: "postgres://paperclip:hunter2@127.0.0.1:5432/paperclip", required: true }),
    row({ key: "PORT", value: "3100", source: "default" }),
    row({ key: "PAPERCLIP_AGENT_JWT_SECRET", value: LIVE_SECRET, required: true, note: "Set in /x/.env" }),
  ];

  it("does not print a credential in the per-variable lines", () => {
    const output = stripAnsi(formatEnvRowLines(rows).join("\n"));

    expect(output).not.toContain(LIVE_SECRET);
    expect(output).not.toContain("hunter2");
    expect(output).toContain("PAPERCLIP_AGENT_JWT_SECRET");
    expect(output).toContain("sha256:");
    // Non-secret configuration is still shown in full, or the command is useless.
    expect(output).toContain("'3100'");
  });

  it("does not print a credential in the export block", () => {
    const block = stripAnsi(buildExportBlock(rows));

    expect(block).not.toContain(LIVE_SECRET);
    expect(block).not.toContain("hunter2");
    expect(block).toContain("# PAPERCLIP_AGENT_JWT_SECRET redacted");
    expect(block).toContain("export PORT='3100'");
  });

  it("emits each key once and leaves a missing key as a placeholder", () => {
    const block = stripAnsi(
      buildExportBlock([
        row({ key: "PAPERCLIP_AGENT_JWT_SECRET", value: LIVE_SECRET }),
        row({ key: "PAPERCLIP_AGENT_JWT_SECRET", value: LIVE_SECRET }),
        row({ key: "BETTER_AUTH_SECRET", value: "", source: "missing" }),
      ]),
    );

    expect(block.match(/PAPERCLIP_AGENT_JWT_SECRET/g)).toHaveLength(1);
    expect(block).toContain("export BETTER_AUTH_SECRET='<set-this-value>'");
  });
});

describe("envCommand", () => {
  const touched: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of touched.splice(0)) delete process.env[key];
  });

  it("prints no credential anywhere when the environment holds live ones", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-env-redact-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ database: { mode: "embedded-postgres" } }));
    fs.writeFileSync(
      path.join(dir, ".env"),
      `PAPERCLIP_AGENT_JWT_SECRET=${LIVE_SECRET}\nDATABASE_URL=postgres://paperclip:hunter2@127.0.0.1:5432/paperclip\n`,
      { mode: 0o600 },
    );

    for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "DATABASE_URL"]) {
      delete process.env[key];
      touched.push(key);
    }
    touched.push("PAPERCLIP_CONFIG");
    process.env.PAPERCLIP_CONFIG = configPath;

    const captured: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as never);

    await envCommand({ config: configPath });

    const output = stripAnsi(captured.join("\n"));

    expect(output).not.toContain(LIVE_SECRET);
    expect(output).not.toContain("hunter2");
    expect(output).toContain("PAPERCLIP_AGENT_JWT_SECRET");
    expect(output).toContain("sha256:");
    expect(output).toContain("Redacted in this report:");
    expect(output).toContain("DATABASE_URL");
  });
});

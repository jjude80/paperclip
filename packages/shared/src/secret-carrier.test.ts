import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SECRET_FILE_CARRIERS,
  readBoardToken,
  readGithubBrokerToken,
  readRuntimeToolsToken,
  readSecretCarrier,
} from "./secret-carrier.js";

describe("secret carrier table", () => {
  it("names one file variable per bearer and never reuses a value variable", () => {
    for (const carrier of SECRET_FILE_CARRIERS) {
      expect(carrier.fileKey.endsWith("_FILE")).toBe(true);
      expect(carrier.fileKey).not.toBe(carrier.key);
      expect(carrier.fileName.length).toBeGreaterThan(0);
    }
    expect(SECRET_FILE_CARRIERS.map((carrier) => carrier.fileKey)).toContain(
      "PAPERCLIP_API_TOKEN_FILE",
    );
  });
});

describe("readSecretCarrier", () => {
  const carrier = { key: "PAPERCLIP_RUNTIME_TOOLS_TOKEN", fileKey: "PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE" };

  it("prefers the file over the legacy value", () => {
    expect(
      readSecretCarrier(
        { PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE: "/run/token", PAPERCLIP_RUNTIME_TOOLS_TOKEN: "legacy" },
        carrier,
        () => "from-file\n",
      ),
    ).toBe("from-file");
  });

  it("falls back to the legacy value when the path is set but unreadable", () => {
    expect(
      readSecretCarrier(
        { PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE: "/missing", PAPERCLIP_RUNTIME_TOOLS_TOKEN: "legacy" },
        carrier,
        () => {
          throw new Error("ENOENT");
        },
      ),
    ).toBe("legacy");
  });

  it("falls back when the file is empty, and reports null when there is no credential", () => {
    expect(
      readSecretCarrier({ PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE: "/empty" }, carrier, () => "\n"),
    ).toBeNull();
    expect(readSecretCarrier({}, carrier, () => "")).toBeNull();
  });
});

describe("named readers", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tokenFile(name: string, value: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-carrier-test-"));
    dirs.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
    return file;
  }

  it("resolve each bearer from its own variable, so one cannot answer for another", () => {
    const env = {
      PAPERCLIP_API_TOKEN_FILE: tokenFile("board-token", "board"),
      PAPERCLIP_GITHUB_BROKER_TOKEN_FILE: tokenFile("broker-token", "broker"),
    };
    expect(readBoardToken(env)).toBe("board");
    expect(readGithubBrokerToken(env)).toBe("broker");
    expect(readRuntimeToolsToken({ ...env })).toBeNull();
  });
});

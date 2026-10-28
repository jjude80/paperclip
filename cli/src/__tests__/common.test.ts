import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContext } from "../client/context.js";
import { setStoredBoardCredential } from "../client/board-auth.js";
import { apiPath, boardKeyExpiryNotice, inferContentTypeFromPath, resolveApiBase, resolveCommandContext } from "../commands/client/common.js";

const ORIGINAL_ENV = { ...process.env };

function createTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-common-"));
  return path.join(dir, name);
}

describe("resolveCommandContext", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_TOKEN_FILE;
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_AUTH_STORE;
    delete process.env.PAPERCLIP_SERVER_PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses profile defaults when options/env are not provided", () => {
    const contextPath = createTempPath("context.json");

    writeContext(
      {
        version: 2,
        currentProfile: "ops",
        profiles: {
          ops: {
            apiBase: "http://127.0.0.1:9999",
            companyId: "company-profile",
            apiKeyEnvVarName: "AGENT_KEY",
          },
        },
      },
      contextPath,
    );
    process.env.AGENT_KEY = "key-from-env";

    const resolved = resolveCommandContext({ context: contextPath }, { requireCompany: true });
    expect(resolved.api.apiBase).toBe("http://127.0.0.1:9999");
    expect(resolved.companyId).toBe("company-profile");
    expect(resolved.api.apiKey).toBe("key-from-env");
  });

  it("prefers explicit options over profile values", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://profile:3100",
            companyId: "company-profile",
          },
        },
      },
      contextPath,
    );

    const resolved = resolveCommandContext(
      {
        context: contextPath,
        apiBase: "http://override:3200",
        apiKey: "direct-token",
        companyId: "company-override",
      },
      { requireCompany: true },
    );

    expect(resolved.api.apiBase).toBe("http://override:3200");
    expect(resolved.companyId).toBe("company-override");
    expect(resolved.api.apiKey).toBe("direct-token");
  });

  it("throws when company is required but unresolved", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );

    expect(() =>
      resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" }, { requireCompany: true }),
    ).toThrow(/Company ID is required/);
  });

  it("resolves api base by explicit, env, profile, then config/default precedence", () => {
    const configPath = createTempPath("config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      $meta: { version: 1, updatedAt: "2026-05-23T00:00:00.000Z", source: "onboard" },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port: 4111 },
    }));

    expect(resolveApiBase({ apiBase: "http://explicit:1", config: configPath }, { apiBase: "http://profile:2" }))
      .toBe("http://explicit:1");

    process.env.PAPERCLIP_API_URL = "http://env:3/";
    expect(resolveApiBase({ config: configPath }, { apiBase: "http://profile:2" })).toBe("http://env:3");

    delete process.env.PAPERCLIP_API_URL;
    expect(resolveApiBase({ config: configPath }, { apiBase: "http://profile:2/" })).toBe("http://profile:2");
    expect(resolveApiBase({ config: configPath }, {})).toBe("http://localhost:4111");
  });

  it("prefers explicit and env tokens over profile env and stored board auth", () => {
    const contextPath = createTempPath("context.json");
    const authStorePath = createTempPath("auth.json");
    process.env.PAPERCLIP_AUTH_STORE = authStorePath;
    process.env.PROFILE_KEY = "profile-token";
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "stored-board-token",
      userId: "user-1",
      storePath: authStorePath,
    });
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://localhost:3100",
            apiKeyEnvVarName: "PROFILE_KEY",
          },
        },
      },
      contextPath,
    );

    const profileResolved = resolveCommandContext({ context: contextPath });
    expect(profileResolved.api.apiKey).toBe("profile-token");
    expect(profileResolved.authSource).toBe("profile_env");

    process.env.PAPERCLIP_API_KEY = "env-token";
    const envResolved = resolveCommandContext({ context: contextPath });
    expect(envResolved.api.apiKey).toBe("env-token");
    expect(envResolved.authSource).toBe("env");

    const explicitResolved = resolveCommandContext({ context: contextPath, apiKey: "explicit-token" });
    expect(explicitResolved.api.apiKey).toBe("explicit-token");
    expect(explicitResolved.authSource).toBe("explicit");
  });
});

describe("resolveCommandContext board bearer carrier", () => {
  // NEXA-643 stops handing PAPERCLIP_API_KEY to child shells and passes a 0600
  // file named by PAPERCLIP_API_TOKEN_FILE instead. One binary has to read both.
  const contextPath = createTempPath("context.json");

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_TOKEN_FILE;
    delete process.env.PAPERCLIP_AUTH_STORE;
    process.env.PAPERCLIP_AUTH_STORE = createTempPath("auth.json");
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: { default: { apiBase: "http://localhost:3100" } },
      },
      contextPath,
    );
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function writeTokenFile(contents: string): string {
    const filePath = createTempPath("board-token");
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
    return filePath;
  }

  it("reads the bearer from PAPERCLIP_API_TOKEN_FILE when the env value is gone", () => {
    process.env.PAPERCLIP_API_TOKEN_FILE = writeTokenFile("token-from-file\n");

    const resolved = resolveCommandContext({ context: contextPath });
    expect(resolved.api.apiKey).toBe("token-from-file");
    expect(resolved.authSource).toBe("file");
  });

  it("prefers the file over a legacy PAPERCLIP_API_KEY value", () => {
    process.env.PAPERCLIP_API_TOKEN_FILE = writeTokenFile("token-from-file\n");
    process.env.PAPERCLIP_API_KEY = "token-from-env";

    const resolved = resolveCommandContext({ context: contextPath });
    expect(resolved.api.apiKey).toBe("token-from-file");
    expect(resolved.authSource).toBe("file");
  });

  it("still lets --api-key win over the file", () => {
    process.env.PAPERCLIP_API_TOKEN_FILE = writeTokenFile("token-from-file\n");

    const resolved = resolveCommandContext({ context: contextPath, apiKey: "explicit-token" });
    expect(resolved.api.apiKey).toBe("explicit-token");
    expect(resolved.authSource).toBe("explicit");
  });

  it("falls back to the legacy variable when the named file cannot be read", () => {
    process.env.PAPERCLIP_API_TOKEN_FILE = path.join(os.tmpdir(), "paperclip-cli-common-absent", "board-token");
    process.env.PAPERCLIP_API_KEY = "token-from-env";

    const resolved = resolveCommandContext({ context: contextPath });
    expect(resolved.api.apiKey).toBe("token-from-env");
    expect(resolved.authSource).toBe("env");
  });

  it("ignores an empty token file instead of authenticating with nothing", () => {
    process.env.PAPERCLIP_API_TOKEN_FILE = writeTokenFile("\n");
    process.env.PAPERCLIP_API_KEY = "token-from-env";

    const resolved = resolveCommandContext({ context: contextPath });
    expect(resolved.api.apiKey).toBe("token-from-env");
    expect(resolved.authSource).toBe("env");
  });
});

describe("inferContentTypeFromPath", () => {
  it("maps the issue-attachment file types the server allows", () => {
    // Must match server/src/attachment-types.ts DEFAULT_ALLOWED_TYPES exactly.
    expect(inferContentTypeFromPath("newsletter.html")).toBe("text/html");
    expect(inferContentTypeFromPath("page.htm")).toBe("text/html");
    expect(inferContentTypeFromPath("data.csv")).toBe("text/csv");
    expect(inferContentTypeFromPath("bundle.zip")).toBe("application/zip");
    expect(inferContentTypeFromPath("demo.mp4")).toBe("video/mp4");
    expect(inferContentTypeFromPath("clip.webm")).toBe("video/webm");
    expect(inferContentTypeFromPath("teaser.m4v")).toBe("video/x-m4v");
    expect(inferContentTypeFromPath("walkthrough.mov")).toBe("video/quicktime");
    expect(inferContentTypeFromPath("report.pdf")).toBe("application/pdf");
    expect(inferContentTypeFromPath("chart.png")).toBe("image/png");
  });

  it("emits text types with no charset parameter so they match the exact allowlist", () => {
    expect(inferContentTypeFromPath("notes.md")).toBe("text/markdown");
    expect(inferContentTypeFromPath("log.txt")).toBe("text/plain");
  });

  it("is case-insensitive and returns undefined for unknown extensions", () => {
    expect(inferContentTypeFromPath("/abs/Path/IMAGE.PNG")).toBe("image/png");
    expect(inferContentTypeFromPath("archive.unknownext")).toBeUndefined();
    expect(inferContentTypeFromPath("noextension")).toBeUndefined();
  });
});

describe("apiPath", () => {
  it("encodes dynamic path segments", () => {
    expect(apiPath`/api/issues/${"PAP-1/child"}/comments/${"needs review?"}`)
      .toBe("/api/issues/PAP-1%2Fchild/comments/needs%20review%3F");
  });

  it("rejects empty dynamic path segments", () => {
    expect(() => apiPath`/api/issues/${""}`).toThrow("Cannot build API path with an empty path segment.");
    expect(() => apiPath`/api/issues/${undefined}`).toThrow("Cannot build API path with an empty path segment.");
    expect(() => apiPath`/api/issues/${null}`).toThrow("Cannot build API path with an empty path segment.");
    expect(() => apiPath`/api/issues/${" "}`).toThrow("Cannot build API path with an empty path segment.");
  });
});

describe("boardKeyExpiryNotice", () => {
  const now = new Date("2026-10-27T15:00:00.000Z");

  it("says nothing when the key does not expire or has more than a week left", () => {
    expect(boardKeyExpiryNotice(null, now)).toBe(null);
    expect(boardKeyExpiryNotice(undefined, now)).toBe(null);
    expect(boardKeyExpiryNotice("2026-11-04T15:00:01.000Z", now)).toBe(null);
  });

  it("warns inside the last week, naming the remaining hours and the fix", () => {
    const notice = boardKeyExpiryNotice("2026-10-29T17:22:13.000Z", now);

    expect(notice).toContain("expires in 51h");
    expect(notice).toContain("2026-10-29T17:22:13.000Z");
    expect(notice).toContain('paperclipai auth login');
  });

  it("reports an already-expired key as expired instead of counting down", () => {
    const notice = boardKeyExpiryNotice("2026-10-27T14:59:59.000Z", now);

    expect(notice).toContain("expired at 2026-10-27T14:59:59.000Z");
  });

  it("stays silent on an unparseable date rather than printing NaN", () => {
    expect(boardKeyExpiryNotice("not-a-date", now)).toBe(null);
  });
});

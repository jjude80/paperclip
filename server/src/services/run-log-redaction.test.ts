import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectEnvironmentSecretValues,
  collectRunLogLiteralSecrets,
  createRunLogRedactor,
  redactRunLogText,
} from "./run-log-redaction.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-redaction-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("collectEnvironmentSecretValues", () => {
  it("collects credential values and skips names that only describe a credential", () => {
    const values = collectEnvironmentSecretValues({
      PAPERCLIP_API_KEY: "pcp_board_0123456789abcdef0123456789abcdef01234567",
      PAPERCLIP_GIT_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      CB_TRADER__EXCHANGE__COINBASE__PRIVATE_KEY_FILE: "/run/secrets/key.pem",
      PAPERCLIP_AGENT_PUBLIC_KEY: "public-material-not-a-secret",
      PAPERCLIP_API_KEY_NAME: "trading-key",
      SOME_TOKEN: "true",
      UNRELATED: "ordinary-value-that-is-long",
    });
    expect(values).toContain("pcp_board_0123456789abcdef0123456789abcdef01234567");
    expect(values).toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(values).not.toContain("/run/secrets/key.pem");
    expect(values).not.toContain("public-material-not-a-secret");
    expect(values).not.toContain("trading-key");
    expect(values).not.toContain("true");
    expect(values).not.toContain("ordinary-value-that-is-long");
  });
});

describe("collectRunLogLiteralSecrets", () => {
  it("reads a *_FILE credential and JSON string leaves from the secret set", async () => {
    const dir = await tempDir();
    const keyFile = path.join(dir, "private-key.pem");
    const jsonFile = path.join(dir, "connector.json");
    const pem = "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----";
    await fs.writeFile(keyFile, pem, "utf8");
    await fs.writeFile(jsonFile, JSON.stringify({ token: "connector-token-value-123", region: "eu" }), "utf8");

    const values = await collectRunLogLiteralSecrets({
      env: { CB_TRADER__EXCHANGE__COINBASE__PRIVATE_KEY_FILE: keyFile },
      secretFilePaths: [keyFile, jsonFile],
    });

    expect(values).toContain(pem);
    expect(values).toContain("connector-token-value-123");
  });
});

describe("redactRunLogText", () => {
  it("redacts Paperclip board, CLI-auth and agent key shapes", () => {
    const board = `pcp_board_${"a".repeat(48)}`;
    const cli = `pcp_cli_auth_${"b".repeat(48)}`;
    const agent = `pcp_${"c".repeat(48)}`;
    const output = redactRunLogText(`${board} ${cli} ${agent}`);
    expect(output).not.toContain(board);
    expect(output).not.toContain(cli);
    expect(output).not.toContain(agent);
    expect(output).toBe(`${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE} ${REDACTED_EVENT_VALUE}`);
  });

  it("redacts GitHub, bearer, PEM and credentialed connection strings", () => {
    const gh = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_part_123";
    const pem = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
    const dsn = "postgres://user:password@db.internal:5432/paperclip";
    const output = redactRunLogText(`gh=${gh} auth=Bearer abcdefghijklmnop jwttoken=${jwt}\n${pem}\n${dsn}`);
    expect(output).not.toContain(gh);
    expect(output).not.toContain("abcdefghijklmnop");
    expect(output).not.toContain("secret\n-----END");
    expect(output).not.toContain("password@db.internal");
  });

  it("leaves ordinary tool output unchanged", () => {
    const input = "PASS  server/src/services/run-log-store.test.ts\nhtop: pid 42 cpu 3%\n";
    expect(redactRunLogText(input)).toBe(input);
  });
});

describe("createRunLogRedactor", () => {
  it("redacts a literal secret split across two chunks", () => {
    const secret = "literal-secret-value-9f2c";
    const redactor = createRunLogRedactor([secret]);
    const first = redactor.push("stdout", "before literal-secret-");
    const second = redactor.push("stdout", "value-9f2c after");
    const tail = redactor.finish("stdout");
    const output = first + second + tail;
    expect(output).not.toContain(secret);
    expect(output).toContain("before ");
    expect(output).toContain(" after");
  });

  it("does not leak an interrupted secret fragment at finalize", () => {
    const secret = "literal-secret-value-9f2c";
    const redactor = createRunLogRedactor([secret]);
    const emitted = redactor.push("stderr", `output then ${secret.slice(0, 10)}`);
    const tail = redactor.finish("stderr");
    expect(emitted + tail).not.toContain(secret.slice(0, 10));
  });

  it("redacts a board key split across chunks", () => {
    const key = `pcp_board_${"d".repeat(48)}`;
    const redactor = createRunLogRedactor();
    const first = redactor.push("stdout", `token ${key.slice(0, 20)}`);
    const second = redactor.push("stdout", `${key.slice(20)} end`);
    const output = first + second + redactor.finish("stdout");
    expect(output).not.toContain(key);
  });

  it("redacts a long literal secret that spans more than one chunk boundary", () => {
    const secret = `long-${"s".repeat(5000)}-tail`;
    const redactor = createRunLogRedactor([secret]);
    const output = [
      redactor.push("stdout", `before ${secret.slice(0, 100)}`),
      redactor.push("stdout", secret.slice(100, 3000)),
      redactor.push("stdout", secret.slice(3000)),
      redactor.push("stdout", " after"),
      redactor.finish("stdout"),
    ].join("");
    expect(output).not.toContain(secret.slice(0, 100));
    expect(output).not.toContain(secret.slice(100, 3000));
    expect(output).toContain("before ");
    expect(output).toContain(" after");
  });

  it("keeps separate buffers per stream so interleaved output cannot defeat matching", () => {
    const secret = "interleaved-secret-value";
    const redactor = createRunLogRedactor([secret]);
    const out: string[] = [];
    out.push(redactor.push("stdout", "interleaved-"));
    out.push(redactor.push("stderr", "unrelated line\n"));
    out.push(redactor.push("stdout", "secret-value"));
    out.push(redactor.finish("stdout"));
    out.push(redactor.finish("stderr"));
    expect(out.join("")).not.toContain(secret);
  });
});

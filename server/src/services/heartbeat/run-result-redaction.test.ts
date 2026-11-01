import { describe, expect, it } from "vitest";

import {
  MIN_EXACT_SECRET_VALUE_LENGTH,
  REDACTED_EVENT_VALUE,
  redactPersistedRunResultJson,
} from "./run-result-redaction.js";

const LONG_SECRET = "s3cr3t-Value-That-Is-Not-Key-Shaped";

describe("redactPersistedRunResultJson", () => {
  it("redacts a credential-shaped environment assignment in captured stdout", () => {
    const stdout =
      "PAPERCLIP_AGENT_JWT_SECRET=abcdef0123456789abcdef0123456789\n" +
      "PATH=/usr/bin\n";

    const redacted = redactPersistedRunResultJson({ stdout });

    expect(redacted.stdout).toContain(`PAPERCLIP_AGENT_JWT_SECRET=${REDACTED_EVENT_VALUE}`);
    expect(redacted.stdout).not.toContain("abcdef0123456789abcdef0123456789");
    // Unrelated output survives untouched.
    expect(redacted.stdout).toContain("PATH=/usr/bin");
  });

  it("redacts a bare value from the run's secret inventory", () => {
    const stdout = `the adapter printed ${LONG_SECRET} by itself`;

    const redacted = redactPersistedRunResultJson({ stdout }, [LONG_SECRET]);

    expect(redacted.stdout).not.toContain(LONG_SECRET);
    expect(redacted.stdout).toContain(REDACTED_EVENT_VALUE);
  });

  it("ignores inventory values too short to replace safely", () => {
    const short = "abc";
    expect(short.length).toBeLessThan(MIN_EXACT_SECRET_VALUE_LENGTH);
    const stdout = "abc contains abc as ordinary prose";

    const redacted = redactPersistedRunResultJson({ stdout }, [short]);

    expect(redacted.stdout).toBe(stdout);
  });

  it("recurses through nested objects and arrays", () => {
    const value = {
      stdout: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      nested: {
        list: [
          { note: `leaked ${LONG_SECRET}` } as { note: string } | string,
          "sk-abcdefghijklmnop",
        ],
      },
      exitCode: 1,
      timedOut: false,
      missing: null,
    };

    const redacted = redactPersistedRunResultJson(value, [LONG_SECRET]);
    const first = redacted.nested.list[0];
    const note = typeof first === "string" ? first : first.note;

    expect(redacted.stdout).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(note).not.toContain(LONG_SECRET);
    expect(redacted.nested.list[1]).not.toContain("sk-abcdefghijklmnop");
    // Non-string leaves are preserved as they were.
    expect(redacted.exitCode).toBe(1);
    expect(redacted.timedOut).toBe(false);
    expect(redacted.missing).toBeNull();
  });

  it("is idempotent: an existing marker is not redacted again", () => {
    const once = redactPersistedRunResultJson(
      { stdout: `token=${LONG_SECRET}` },
      [LONG_SECRET],
    );
    const twice = redactPersistedRunResultJson(once, [LONG_SECRET]);

    expect(twice).toEqual(once);
    expect(once.stdout).toContain(REDACTED_EVENT_VALUE);
  });

  it("leaves ordinary run output unchanged", () => {
    const value = { stdout: "cargo test: 42 passed; 0 failed\n", exitCode: 0 };
    expect(redactPersistedRunResultJson(value, [LONG_SECRET])).toEqual(value);
  });
});

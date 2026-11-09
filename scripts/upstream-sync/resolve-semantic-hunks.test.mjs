import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveText, splitConflicts } from "./resolve-semantic-hunks.mjs";

const tool = new URL("./resolve-semantic-hunks.mjs", import.meta.url).pathname;

function conflict(theirs, base, ours) {
  return ["<<<<<<< theirs", ...theirs.split("\n"), "||||||| base", ...base.split("\n"), "=======", ...ours.split("\n"), ">>>>>>> ours"].join("\n");
}

test("splitConflicts keeps text and separates every hunk", () => {
  const text = ["before", conflict("a", "b", "c"), "middle", conflict("d", "e", "f"), "after"].join("\n");
  const parts = splitConflicts(text);
  assert.equal(parts.filter((p) => p.kind === "conflict").length, 2);
  assert.equal(parts[0].text, "before");
  assert.equal(parts.at(-1).text, "after");
});

test("ports.ts keeps both optional wake fields", () => {
  const text = conflict(
    "  handoffAssigneeAgentId?: string;",
    "",
    "  preferredWakeId?: string;",
  );
  const out = resolveText("server/src/modules/wake-queue/application/ports.ts", text);
  assert.match(out, /handoffAssigneeAgentId\?: string;/);
  assert.match(out, /preferredWakeId\?: string;/);
  assert.doesNotMatch(out, /^(<<<<<<<|=======|>>>>>>>)/m);
});

test("openapi keeps one response object plus upstream's description", () => {
  const text = conflict(
    '  description: "Board-credential read";\n  responses: { 200: r.ok(), 401: r.unauthorized },',
    "  responses: { 200: r.ok(), 401: r.unauthorized },",
    "  responses: {\n    200: r.ok(z.object({ expiresAt: z.string().nullable() })),\n    401: r.unauthorized,\n  },",
  );
  const out = resolveText("server/src/routes/openapi.ts", text);
  assert.equal((out.match(/responses:/g) ?? []).length, 1);
  assert.match(out, /description: "Board-credential read";/);
  assert.match(out, /expiresAt: z\.string\(\)\.nullable\(\)/);
});

test("queue.ts drops the local helper upstream moved into the timer policy", () => {
  const text = [
    conflict(
      "",
      "  async function hasActionableTimerWork(agent) { return false; }",
      [
        "  function hasWakePayloadContent(payload) { return Boolean(payload); }",
        "",
        "  async function hasActionableTimerWork(agent) { return false; }",
      ].join("\n"),
    ),
    conflict("upstream2", "base2", "ours2"),
    conflict("upstream3", "base3", "ours3"),
    conflict("upstream4", "base4", "ours4"),
  ].join("\n");
  const out = resolveText("server/src/services/heartbeat/queue.ts", text);
  assert.match(out, /function hasWakePayloadContent/);
  assert.equal((out.match(/function hasActionableTimerWork/g) ?? []).length, 0);
});

test("an unknown path is refused rather than guessed", () => {
  assert.throws(
    () => resolveText("server/src/services/unknown.ts", conflict("a", "b", "c")),
    /no decision table/,
  );
});

test("a known path with an unexpected hunk count is refused", () => {
  assert.throws(
    () =>
      resolveText(
        "server/src/modules/wake-queue/application/ports.ts",
        conflict("a", "b", "c") + "\n" + conflict("d", "e", "f"),
      ),
    /expected 1 hunks, found 2/,
  );
});

test("CLI resolves known files, refuses unknown ones, and exits 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "semantic-hunks-"));
  const known = "server/src/modules/wake-queue/application/ports.ts";
  mkdirSync(join(dir, "server/src/modules/wake-queue/application"), { recursive: true });
  writeFileSync(join(dir, `${known}.conflict`), conflict("  handoffAssigneeAgentId?: string;", "", "  preferredWakeId?: string;"));
  mkdirSync(join(dir, "server/src/services"), { recursive: true });
  writeFileSync(join(dir, "server/src/services/unknown.ts.conflict"), conflict("a", "b", "c"));

  let status = 0;
  try {
    execFileSync(process.execPath, [tool, "--conflicts", dir, "--json"], { encoding: "utf8" });
  } catch (error) {
    status = error.status;
  }
  assert.equal(status, 3);
  const out = readFileSync(join(dir, "resolved", known), "utf8");
  assert.match(out, /preferredWakeId/);
  assert.doesNotMatch(out, /^(<<<<<<<|=======|>>>>>>>)/m);
});

#!/usr/bin/env node
/**
 * Resolve the semantic server hunks that `port-semantic-overlay.mjs` leaves as
 * `.conflict` files.
 *
 * The overlay ports the fork's post-snapshot delta onto an upstream revision.
 * Nine of the 27 semantic `server/` paths apply cleanly; eighteen collide in 31
 * hunks. This tool applies the reviewed decision for every one of those hunks:
 *
 *   theirs = upstream revision
 *   base   = fork snapshot 13ac9450
 *   ours   = fork tip
 *
 * The decisions are deliberately explicit rather than heuristic. A hunk this
 * tool does not know is left untouched and the run exits 3, so a stage cannot
 * advance by accident when upstream reshapes a collision.
 *
 * This is staging help, not a resolution: it does not commit, does not typecheck
 * and does not replace the stage's verification commands. Rows marked
 * `decision` in RESOLUTIONS still need a reviewer to confirm the behaviour.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const MARKER_START = "<<<<<<< ";
const MARKER_BASE = "||||||| ";
const MARKER_MID = "=======";
const MARKER_END = ">>>>>>> ";

const lines = (s) => s.split("\n");
const joinLines = (a) => a.join("\n");

/** Split a merge-file output into text segments and conflict records. */
export function splitConflicts(text) {
  const src = lines(text);
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (src[i].startsWith(MARKER_START)) {
      let j = i + 1;
      while (j < src.length && !src[j].startsWith(MARKER_BASE)) j += 1;
      let k = j + 1;
      while (k < src.length && src[k] !== MARKER_MID) k += 1;
      let m = k + 1;
      while (m < src.length && !src[m].startsWith(MARKER_END)) m += 1;
      if (j >= src.length || k >= src.length || m >= src.length) {
        throw new Error("unterminated conflict block");
      }
      out.push({
        kind: "conflict",
        theirs: joinLines(src.slice(i + 1, j)),
        base: joinLines(src.slice(j + 1, k)),
        ours: joinLines(src.slice(k + 1, m)),
      });
      i = m + 1;
    } else {
      out.push({ kind: "text", text: src[i] });
      i += 1;
    }
  }
  return out;
}

const takeTheirs = ({ theirs }) => theirs;
const takeOurs = ({ ours }) => ours;
const dropBoth = () => "";
const union = ({ theirs, ours }) => [theirs, ours].filter((s) => s.length > 0).join("\n");

/** Return the first line in `text` that starts with `prefix`. */
function lineStartingWith(text, prefix) {
  const found = lines(text).find((l) => l.startsWith(prefix));
  if (found === undefined) throw new Error(`missing line starting with ${JSON.stringify(prefix)}`);
  return found;
}

// ---- reviewed decisions ----------------------------------------------------

function upstreamImportsPlusStartupStatus({ theirs }) {
  // Keep upstream's new cloud imports, but import the fork's startup helper too.
  return lines(theirs)
    .map((l) =>
      l === 'import { systemdNotify } from "./services/systemd-notify.js";'
        ? 'import { systemdNotify, notifyStartupStatus } from "./services/systemd-notify.js";'
        : l,
    )
    .join("\n");
}

function markReadyPlusBootTiming() {
  // Upstream marks deployment hints ready; the fork reports boot time.
  return [
    "  deploymentHints?.markReady();",
    "  const bootMs = Date.now() - bootStartedAt;",
    "  logger.info(`Server startup recovery complete on ${config.host}:${listenPort} (boot took ${(bootMs / 1000).toFixed(1)}s)`);",
    "  void systemdNotify([\"--ready\", `--status=Listening on ${config.host}:${listenPort} (boot ${(bootMs / 1000).toFixed(1)}s)`]).then((notified) => {",
  ].join("\n");
}

function bothWakeFields() {
  // Upstream's handoff assignee and the fork's durable preferred wake are
  // independent fields; a locked execution may carry either or both.
  return [
    "        const locked: LockedIssueExecution = { primaryIssue: toIssueSnapshot(issueRow), run: runSnapshot,",
    "          recoveryOnly: recoveryOnly && !handoffAssigneeAgentId, ...(handoffAssigneeAgentId ? { handoffAssigneeAgentId } : {}),",
    "          ...(durableHandoffWakeId ? { preferredWakeId: durableHandoffWakeId } : {}) };",
  ].join("\n");
}

function keepForkHelperOnly({ ours }) {
  // Upstream moved hasActionableTimerWork into createHeartbeatTimerPolicy and
  // removed the local copy; only the fork's hasWakePayloadContent belongs here.
  const src = lines(ours);
  const cut = src.findIndex((l) => l.startsWith("  async function hasActionableTimerWork"));
  if (cut < 0) throw new Error("fork helper block not found");
  return src.slice(0, cut).join("\n");
}

function upstreamRepairTestsPlusForkScopeTests({ theirs, ours }) {
  // Put the fork's payload-scope tests in the enrich describe, before its
  // close, and keep upstream's new compaction describe after it.
  const src = lines(theirs);
  const close = src.indexOf("});");
  if (close < 0) throw new Error("upstream describe close not found");
  return joinLines([...src.slice(0, close), ...lines(ours), "});", ...src.slice(close + 1)]);
}

function upstreamDescriptionPlusForkSchema({ theirs, ours }) {
  return [lineStartingWith(theirs, "  description:"), ours].filter(Boolean).join("\n");
}

function dependencyAndHandoffWake() {
  return [
    "        ), sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,",
    "        dependencyResolvedWakePayloadSql,",
    "        sql`${agentWakeupRequests.payload}->'executionWait'->>'deferredHandoff' = 'true'`),",
  ].join("\n");
}

function dependencyOrHandoffStranded({ }) {
  return [
    "      const dependencyWake = isDependencyResolvedWakePayload(wake.payload);",
    "      if (!dependencyWake && !queuedCommentIdsFromWakePayload(wake.payload).length &&",
    "          !isDeferredHandoffWake(wake.payload) &&",
  ].join("\n");
}

function durableHandoffNotifies({ }) {
  // Upstream notifies deferred execution work from inside the same branch; the
  // fork's durable hand-off wake must take that path too.
  return [
    "                readNonEmptyString(enrichedContextSnapshot.nativeStatusWakeIntentId) ||",
    "                durableHandoffWake) {",
    "              await notifyDeferredExecutionWork(tx, { companyId: agent.companyId });",
  ].join("\n");
}

function runOutputImports({ theirs, ours }) {
  // Upstream's log-store authority imports, the fork's secret registry, and one
  // copy of the shared run-log/lifecycle imports.
  return [
    'import { isRunLogStoreType, type RunLogHandle, type RunLogStore } from "../run-log-store.js";',
    'import { appendExcerpt, canonicalNativeRunLogRedactionForms, compactRunLogChunk, redactCanonicalNativeRunLogChunk } from "./run-log.js";',
    'import { createNativeRunLogExporter, nativeRunLogPrefixCursor } from "../native-runtime/native-run-log-export.js";',
    'import { createRunSecretRedactionRegistry } from "../run-secret-redaction.js";',
    "import {",
    "  isHeartbeatRunRuntimeStatusActive,",
    "  publishHeartbeatRunRuntimeProgress,",
    "  type createHeartbeatLifecycle,",
    '} from "./run-lifecycle.js";',
  ].join("\n");
}

function runOutputBegin({ theirs }) {
  // Upstream's writer-authority guard runs first, then the fork resolves the
  // run's injected secrets for write-time redaction.
  return [
    theirs,
    "    // Secrets injected into this run are also redacted from its output before",
    "    // the NDJSON line is written. Failure to resolve them must not stop the",
    "    // run: the sink still applies environment, secret-file and credential-shape",
    "    // redaction, and old logs keep their own redaction path.",
    "    let runSecretValues: string[] = [];",
    "    try {",
    "      runSecretValues = await createRunSecretRedactionRegistry(db)",
    "        .secretValuesForRun(run.companyId, runId);",
    "    } catch (error) {",
    "      console.warn(",
    "        `[heartbeat] Could not resolve run secret values for write-time log redaction (run ${runId}):`,",
    "        error instanceof Error ? error.message : error,",
    "      );",
    "    }",
  ].join("\n");
}

function runOutputBeginArgs({ theirs }) {
  return [theirs, "      secretValues: runSecretValues,"].join("\n");
}

function gitWorkspaceFailureMatcher({ theirs, ours }) {
  // Keep the fork's tolerant git wording matcher, then upstream's leak
  // assertions and its new invalid-pointer test.
  const close = theirs.indexOf("    expect(await exists(f.cwd)).toBe(true);");
  if (close < 0) throw new Error("upstream assertion not found");
  return ours + "\n" + theirs.slice(close);
}

function supersededInteractionScope({ }) {
  // Upstream's quality-review exclusion and tool-projection notification stay;
  // the fork's NEXA-773 subject scope decides which siblings are superseded.
  return [
    "          // The issue row is locked FOR UPDATE above, so this read-then-write",
    "          // cannot race another create on the same issue. NEXA-773 keeps the",
    "          // supersede scoped to the same confirmation subject; upstream's",
    "          // quality-review siblings stay actionable.",
    "          const baseSiblingCondition = and(",
    "            eq(issueThreadInteractions.companyId, issue.companyId),",
    "            eq(issueThreadInteractions.issueId, issue.id),",
    "            eq(issueThreadInteractions.kind, data.kind),",
    "            eq(issueThreadInteractions.createdByAgentId, actor.agentId),",
    "            eq(issueThreadInteractions.status, \"pending\"),",
    "            ne(issueThreadInteractions.id, row.id),",
    "            sql`${issueThreadInteractions.payload}->'qualityReview' IS NULL`,",
    "          );",
    "          const pendingSiblings = await tx",
    "            .select()",
    "            .from(issueThreadInteractions)",
    "            .where(baseSiblingCondition);",
    "          const newConfirmationSubjectKey =",
    "            data.kind === \"request_confirmation\"",
    "              ? requestConfirmationSubjectKey(data.payload)",
    "              : null;",
    "          const supersededIds = pendingSiblings",
    "            .filter(",
    "              (candidate) =>",
    "                data.kind !== \"request_confirmation\" ||",
    "                (newConfirmationSubjectKey !== null &&",
    "                  requestConfirmationSubjectKey(candidate.payload) === newConfirmationSubjectKey),",
    "            )",
    "            .map((candidate) => candidate.id);",
    "          if (data.kind === \"request_confirmation\" && supersededIds.length > 0) {",
    "            // The issue lock above excludes concurrent interaction creation.",
    "            await notifyToolProjectionForInteractions(tx, issue.companyId, supersededIds);",
    "          }",
    "          const supersededRows =",
    "            supersededIds.length > 0",
    "              ? await tx",
    "                  .update(issueThreadInteractions)",
    "                  .set({",
    "                    status: \"expired\",",
    "                    result: supersededResult,",
    "                    resolvedByAgentId: actor.agentId,",
    "                    resolvedByUserId: actor.userId ?? null,",
    "                    resolvedAt: now,",
    "                    updatedAt: now,",
    "                  })",
    "                  .where(inArray(issueThreadInteractions.id, supersededIds))",
    "                  .returning()",
    "              : [];",
  ].join("\n");
}

function gitRestoreForkPlusOlderRelease({ theirs, ours }) {
  // Both behaviours matter: a child never selects the parent's isolated
  // worktree (fork), and an older release's explicit reuse binding still
  // protects the worktree (upstream).
  return [
    ours,
    "      expect(await exists(f.cwd)).toBe(true);",
    "    }, 60_000);",
    "",
    '    it("keeps the worktree for an older-release child still bound to it with reuse_existing", async () => {',
    "      const f = await fixture();",
    ...lines(theirs).filter((l) => !l.startsWith("    it(")),
  ].join("\n");
}

// Path -> decision per conflict, in file order.
const RESOLUTIONS = {
  "server/src/index.ts": [upstreamImportsPlusStartupStatus, markReadyPlusBootTiming],
  "server/src/modules/wake-queue/application/ports.ts": [union],
  "server/src/modules/wake-queue/adapters/postgres.ts": [bothWakeFields],
  "server/src/modules/wake-queue/adapters/postgres.test.ts": [takeTheirs],
  "server/src/modules/wake-queue/domain/context.test.ts": [upstreamRepairTestsPlusForkScopeTests],
  "server/src/modules/wake-queue/domain/context.ts": [takeOurs],
  "server/src/routes/openapi.ts": [upstreamDescriptionPlusForkSchema],
  "server/src/services/heartbeat/queue.ts": [
    keepForkHelperOnly,
    dependencyAndHandoffWake,
    dependencyOrHandoffStranded,
    durableHandoffNotifies,
  ],
  "server/src/services/heartbeat/queue.test.ts": [union],
  "server/src/services/heartbeat/run-completion.test.ts": [union],
  "server/src/services/heartbeat/run-output.ts": [runOutputImports, runOutputBegin, runOutputBeginArgs],
  "server/src/services/run-log-store.ts": [union, union],
  "server/src/services/recovery/service.ts": [union, takeOurs],
  "server/src/services/issues.ts": [union, takeOurs],
  "server/src/services/issue-thread-interactions.ts": [dropBoth, supersededInteractionScope],
  "server/src/__tests__/issues-service.test.ts": [takeOurs, takeOurs, takeOurs],
  "server/src/__tests__/git-workspace-expiration.test.ts": [gitWorkspaceFailureMatcher],
  "server/src/__tests__/git-restore-point-expiration.test.ts": [takeOurs, gitRestoreForkPlusOlderRelease],
};

/** Resolve one conflict file's text. Throws when the hunk count is unknown. */
export function resolveText(relPath, text) {
  const decisions = RESOLUTIONS[relPath];
  if (!decisions) throw new Error(`no decision table for ${relPath}`);
  const parts = splitConflicts(text);
  const conflicts = parts.filter((p) => p.kind === "conflict");
  if (conflicts.length === 0) throw new Error(`${relPath}: no conflicts found`);
  if (conflicts.length !== decisions.length) {
    throw new Error(`${relPath}: expected ${decisions.length} hunks, found ${conflicts.length}`);
  }
  let n = 0;
  const out = parts.flatMap((part) => {
    if (part.kind === "text") return [part.text];
    const decision = decisions[n];
    n += 1;
    const resolvedPart = decision(part);
    return resolvedPart === "" ? [] : [resolvedPart];
  });
  const result = out.join("\n");
  if (/^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)/m.test(result)) {
    throw new Error(`${relPath}: markers remain after resolution`);
  }
  return result;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".conflict")) out.push(p);
  }
  return out;
}

function usage() {
  console.error(`usage: resolve-semantic-hunks.mjs --conflicts <dir> [--out-dir <dir>] [--check] [--json]

  <dir> holds the .conflict files written by port-semantic-overlay.mjs.
  Resolved files are written under --out-dir (default: <dir>/resolved) at the
  same relative path, without the .conflict suffix.

  exit 0 every conflict file had a reviewed decision
  exit 3 at least one file has no decision or an unexpected hunk count
  exit 2 usage error`);
}

export function main(argv = process.argv.slice(2)) {
  let conflictsDir = null;
  let outDir = null;
  let check = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--conflicts") conflictsDir = argv[++i];
    else if (a === "--out-dir") outDir = argv[++i];
    else if (a === "--check") check = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") return usage(), 0;
    else return usage(), 2;
  }
  if (!conflictsDir) return usage(), 2;
  const root = resolve(conflictsDir);
  if (!existsSync(root)) return usage(), 2;
  const outputRoot = resolve(outDir ?? join(root, "resolved"));

  const files = walk(root).sort();
  const resolved = [];
  const refused = [];
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/").replace(/\.conflict$/, "");
    try {
      const text = resolveText(rel, readFileSync(file, "utf8"));
      resolved.push(rel);
      if (!check) {
        const dst = join(outputRoot, rel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, text);
      }
    } catch (error) {
      refused.push({ path: rel, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (json) {
    console.log(JSON.stringify({ resolved, refused, outDir: check ? null : outputRoot }, null, 2));
  } else {
    for (const path of resolved) console.log(`resolved  ${path}`);
    for (const r of refused) console.error(`REFUSED   ${r.path}: ${r.reason}`);
    if (!check) console.log(`\n${resolved.length} resolved into ${outputRoot}`);
  }
  return refused.length === 0 ? 0 : 3;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}

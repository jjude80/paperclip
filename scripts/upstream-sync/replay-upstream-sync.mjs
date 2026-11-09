#!/usr/bin/env node
/**
 * Replay the upstream fork-sync merge as a sequence of verified stages.
 *
 * The fork (jjude80/paperclip) diverged from upstream (paperclipai/paperclip).
 * A single merge produces hundreds of conflicts, so the reconciliation is
 * replayed in chronological slices. Each slice is one `git merge` of an
 * upstream endpoint into the integration branch, followed by the slice's
 * verification commands. A stage is only marked complete after every
 * verification command exits 0; a conflicted or failing stage stops the
 * replay so nothing later can be built on an unverified tree.
 *
 * See scripts/upstream-sync/README.md and stages.json for the stage schema.
 *
 * Exit codes:
 *   0  every configured stage is merged and verified
 *   2  usage, config, or preflight failure (nothing advanced)
 *   3  the current stage has unresolved conflicts (replay paused)
 *   4  the current stage's verification failed (replay paused)
 *   5  no stages are configured yet (waiting on the triage plan)
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(SCRIPT_DIR, "stages.json");
const STATE_DIR_NAME = ".upstream-sync";
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_CONFLICT = 3;
const EXIT_VERIFY = 4;
const EXIT_NO_STAGES = 5;

const USAGE = `Usage: node scripts/upstream-sync/replay-upstream-sync.mjs [options]

Options:
  --config <path>        Stage plan (default: scripts/upstream-sync/stages.json)
  --repo <path>          Repository to operate on (default: this repository)
  --branch <name>        Integration branch (default: config.branch)
  --fork-remote <name>   Fork remote (default: config.forkRemote / origin)
  --upstream-remote <n>  Upstream remote (default: config.upstreamRemote / upstream)
  --plan                 Resolve stages and print them; no checkout or merge
  --dry-run              Use git merge-tree to estimate conflicts per stage
  --stage <id>           Stop after this stage id
  --no-fetch             Do not fetch either remote
  --push                 After a clean replay, push the integration branch
                         (never master, never forced)
  -h, --help             Show this help

The script never writes to, pushes, or force-pushes the fork's master branch.
`;

function fail(code, message) {
  console.error(`\n[upstream-sync] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG,
    repo: null,
    branch: null,
    forkRemote: null,
    upstreamRemote: null,
    plan: false,
    dryRun: false,
    stage: null,
    fetch: true,
    push: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(EXIT_USAGE, `${arg} requires a value`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--config":
        options.configPath = resolve(next());
        break;
      case "--repo":
        options.repo = resolve(next());
        break;
      case "--branch":
        options.branch = next();
        break;
      case "--fork-remote":
        options.forkRemote = next();
        break;
      case "--upstream-remote":
        options.upstreamRemote = next();
        break;
      case "--plan":
        options.plan = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--stage":
        options.stage = next();
        break;
      case "--no-fetch":
        options.fetch = false;
        break;
      case "--push":
        options.push = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(EXIT_OK);
        break;
      default:
        fail(EXIT_USAGE, `unknown option: ${arg}\n\n${USAGE}`);
    }
  }
  return options;
}

function runGit(cwd, args, { allowFail = false, input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    fail(EXIT_USAGE, `could not run git: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFail) {
    fail(
      EXIT_USAGE,
      `git ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trimEnd(),
    stderr: (result.stderr ?? "").trimEnd(),
  };
}

function gitText(cwd, args, options) {
  return runGit(cwd, args, options).stdout;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(EXIT_USAGE, `cannot read ${label} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(EXIT_USAGE, `${label} is not valid JSON (${path}): ${error.message}`);
  }
}

function validateConfig(config, configPath) {
  const errors = [];
  if (config?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof config?.branch !== "string" || config.branch.trim() === "") {
    errors.push("branch must be a non-empty string");
  }
  if (!Array.isArray(config?.stages)) {
    errors.push("stages must be an array");
  } else {
    const seen = new Set();
    for (const [index, stage] of config.stages.entries()) {
      const label = stage?.id ? `stage ${stage.id}` : `stage[${index}]`;
      if (typeof stage?.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(stage.id)) {
        errors.push(`${label}: id must be a non-empty slug`);
      } else if (seen.has(stage.id)) {
        errors.push(`${label}: duplicate id`);
      } else {
        seen.add(stage.id);
      }
      if (typeof stage?.upstream !== "string" || stage.upstream.trim() === "") {
        errors.push(`${label}: upstream must be a commit sha, ref, or YYYY-MM-DD date`);
      }
      if (!Array.isArray(stage?.verify) || stage.verify.length === 0) {
        errors.push(`${label}: verify must be a non-empty array of commands`);
      } else if (stage.verify.some((cmd) => typeof cmd !== "string" || cmd.trim() === "")) {
        errors.push(`${label}: every verify entry must be a non-empty command string`);
      }
    }
    if (config.stages.length > 1) {
      // Ordering is validated against resolved shas after fetch, but ids must
      // already be unique at this point.
      if (seen.size !== config.stages.length) errors.push("stage ids must be unique");
    }
  }
  if (errors.length > 0) {
    fail(EXIT_USAGE, `invalid stage config ${configPath}:\n  - ${errors.join("\n  - ")}`);
  }
  if (config.stages.length === 0) {
    fail(
      EXIT_NO_STAGES,
      `no stages are configured in ${configPath}. ` +
        "NEXA-880 owns the stage boundaries; fill in stages.json when that plan lands.",
    );
  }
  return config;
}

function resolveRepoRoot(gitRoot) {
  const root = gitText(gitRoot, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!root) {
    fail(EXIT_USAGE, `not a git repository: ${gitRoot}`);
  }
  return root;
}

function resolveStateDir(root, config) {
  const configured = config.stateDir ?? STATE_DIR_NAME;
  return isAbsolute(configured) ? configured : join(root, configured);
}

function loadState(statePath) {
  if (!existsSync(statePath)) {
    return { schemaVersion: 1, stages: {} };
  }
  return readJson(statePath, "sync state");
}

function saveState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function appendRunLog(stateDir, line) {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(
    join(stateDir, "runs.log"),
    `${new Date().toISOString()} ${line}\n`,
  );
}

function resolveStageEndpoint(root, upstreamRef, stage) {
  const spec = stage.upstream.trim();
  let sha;
  if (/^[0-9a-f]{7,40}$/i.test(spec)) {
    sha = gitText(root, ["rev-parse", "--verify", `${spec}^{commit}`], {
      allowFail: true,
    });
    if (!sha) fail(EXIT_USAGE, `stage ${stage.id}: unknown commit ${spec}`);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) {
    sha = gitText(
      root,
      ["rev-list", "-1", `--before=${spec}T23:59:59Z`, upstreamRef],
      { allowFail: true },
    );
    if (!sha) fail(EXIT_USAGE, `stage ${stage.id}: no ${upstreamRef} commit on or before ${spec}`);
  } else {
    sha = gitText(root, ["rev-parse", "--verify", `${spec}^{commit}`], {
      allowFail: true,
    });
    if (!sha) fail(EXIT_USAGE, `stage ${stage.id}: unknown upstream ref ${spec}`);
  }
  const ancestor = runGit(root, ["merge-base", "--is-ancestor", sha, upstreamRef], {
    allowFail: true,
  });
  if (ancestor.status !== 0) {
    fail(EXIT_USAGE, `stage ${stage.id}: ${sha} is not an ancestor of ${upstreamRef}`);
  }
  return sha;
}

function resolveStages(root, config, upstreamRef, state) {
  const resolved = [];
  let previousSha = null;
  for (const stage of config.stages) {
    const recorded = state.stages?.[stage.id];
    let sha = resolveStageEndpoint(root, upstreamRef, stage);
    if (recorded?.upstreamSha && recorded.upstreamSha !== sha) {
      fail(
        EXIT_USAGE,
        `stage ${stage.id}: the plan now resolves to ${sha} but this branch already ` +
          `recorded ${recorded.upstreamSha}. Changing a stage endpoint mid-replay would ` +
          "silently change what was verified; add a new stage instead.",
      );
    }
    if (recorded?.upstreamSha) sha = recorded.upstreamSha;
    if (previousSha !== null) {
      const ordered = runGit(root, ["merge-base", "--is-ancestor", previousSha, sha], {
        allowFail: true,
      });
      if (ordered.status !== 0) {
        fail(EXIT_USAGE, `stage ${stage.id}: upstream endpoints are not chronological`);
      }
    }
    previousSha = sha;
    resolved.push({ ...stage, upstreamSha: sha });
  }
  return resolved;
}

function ensureBranch(root, branch, forkRemote, forkBranch, forkRef) {
  if (branch === forkBranch) {
    fail(
      EXIT_USAGE,
      `refusing to replay onto ${branch}: that is the fork's protected branch. ` +
        "Use a dedicated integration branch.",
    );
  }
  const current = gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    allowFail: true,
  });
  if (current === branch) return;
  const localExists = runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}`], {
    allowFail: true,
  }).status === 0;
  if (localExists) {
    runGit(root, ["checkout", branch]);
  } else {
    const base = forkRef ?? `${forkRemote}/${forkBranch}`;
    runGit(root, ["checkout", "-b", branch, "--no-track", base]);
    console.log(`[upstream-sync] created ${branch} from ${base}`);
  }
}

function assertCleanForStage(root, stateDir) {
  const status = gitText(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const dirty = status
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      const path = line.slice(3).trim().replace(/^"|"$/g, "");
      return !path.startsWith(`${STATE_DIR_NAME}/`) && path !== STATE_DIR_NAME;
    });
  if (dirty.length > 0) {
    fail(
      EXIT_USAGE,
      "working tree is not clean before the next stage:\n  " + dirty.join("\n  "),
    );
  }
}

function unmergedPaths(root) {
  return gitText(root, ["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function mergeInProgress(root) {
  return (
    runGit(root, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"], {
      allowFail: true,
    }).status === 0
  );
}

function recordLedger(stateDir, stage, sections) {
  const ledgerDir = join(stateDir, "ledgers");
  mkdirSync(ledgerDir, { recursive: true });
  const body = [
    `# Stage ${stage.id}`,
    `upstream: ${stage.upstreamSha}`,
    `generated: ${new Date().toISOString()}`,
    "",
    ...sections,
    "",
  ].join("\n");
  writeFileSync(join(ledgerDir, `${stage.id}.txt`), body);
}

function runVerification(root, stage, stateDir) {
  const results = [];
  for (const command of stage.verify) {
    const startedAt = Date.now();
    console.log(`[upstream-sync] verify ${stage.id}: ${command}`);
    const result = spawnSync("bash", ["-c", command], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SYNC_STAGE_ID: stage.id,
        SYNC_UPSTREAM_SHA: stage.upstreamSha,
      },
      maxBuffer: 128 * 1024 * 1024,
    });
    const entry = {
      command,
      status: result.status,
      durationMs: Date.now() - startedAt,
      outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`
        .split("\n")
        .slice(-40)
        .join("\n"),
    };
    results.push(entry);
    if (result.status !== 0) {
      recordLedger(stateDir, stage, [
        "## Verification failed",
        `command: ${command}`,
        `exit: ${result.status}`,
        "",
        "```",
        entry.outputTail,
        "```",
      ]);
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

function advanceStage(root, stage, state, stateDir) {
  const previousHead = gitText(root, ["rev-parse", "HEAD"]);
  let stageState = state.stages[stage.id];
  const unresolved = unmergedPaths(root);

  if (stageState?.status === "conflicted") {
    if (unresolved.length > 0) {
      recordLedger(stateDir, stage, [
        "## Conflicts still unresolved",
        ...unresolved.map((path) => `- ${path}`),
      ]);
      fail(
        EXIT_CONFLICT,
        `stage ${stage.id} still has ${unresolved.length} unresolved path(s). ` +
          `Resolve, git add, and re-run:\n  ${unresolved.join("\n  ")}`,
      );
    }
    if (mergeInProgress(root)) {
      runGit(root, ["commit", "--no-edit"]);
      console.log(`[upstream-sync] committed conflict resolution for ${stage.id}`);
    }
    stageState = {
      ...stageState,
      status: "merged",
      mergeCommit: gitText(root, ["rev-parse", "HEAD"]),
    };
    state.stages[stage.id] = stageState;
    saveState(join(stateDir, "state.json"), state);
    appendRunLog(stateDir, `resolved ${stage.id} at ${stageState.mergeCommit}`);
  }

  if (!stageState) {
    if (mergeInProgress(root)) {
      fail(
        EXIT_USAGE,
        "a merge is already in progress that this replay does not own. " +
          "Finish it (git commit) or abort it (git merge --abort) first.",
      );
    }
    assertCleanForStage(root, stateDir);
    console.log(
      `[upstream-sync] merging upstream ${stage.upstreamSha.slice(0, 12)} into ${stage.id}`,
    );
    const merge = runGit(root, ["merge", "--no-ff", "--no-edit", stage.upstreamSha], {
      allowFail: true,
    });
    if (merge.status !== 0) {
      const conflicts = unmergedPaths(root);
      stageState = {
        id: stage.id,
        upstreamSha: stage.upstreamSha,
        status: "conflicted",
        startedFrom: previousHead,
        conflicts,
        recordedAt: new Date().toISOString(),
      };
      state.stages[stage.id] = stageState;
      saveState(join(stateDir, "state.json"), state);
      recordLedger(stateDir, stage, [
        "## Merge output",
        "```",
        `${merge.stdout}\n${merge.stderr}`.trim(),
        "```",
        "",
        `## Conflicted paths (${conflicts.length})`,
        ...conflicts.map((path) => `- ${path}`),
      ]);
      appendRunLog(stateDir, `conflict ${stage.id}: ${conflicts.length} paths`);
      console.error(
        `\n[upstream-sync] stage ${stage.id} has ${conflicts.length} conflicted path(s). ` +
          `Ledger: ${join(stateDir, "ledgers", `${stage.id}.txt`)}\n` +
          conflicts.map((path) => `  ${path}`).join("\n") +
          "\n\nResolve the conflicts, `git add` them, then re-run this command. " +
          "The replay will commit the resolution and run verification.",
      );
      process.exit(EXIT_CONFLICT);
    }
    stageState = {
      id: stage.id,
      upstreamSha: stage.upstreamSha,
      status: "merged",
      startedFrom: previousHead,
      mergeCommit: gitText(root, ["rev-parse", "HEAD"]),
      verifiedAt: null,
    };
    state.stages[stage.id] = stageState;
    saveState(join(stateDir, "state.json"), state);
    appendRunLog(stateDir, `merged ${stage.id} at ${stageState.mergeCommit}`);
  }

  if (stageState.mergeCommit) {
    const merged = runGit(
      root,
      ["merge-base", "--is-ancestor", stageState.mergeCommit, "HEAD"],
      { allowFail: true },
    );
    if (merged.status !== 0) {
      fail(
        EXIT_USAGE,
        `stage ${stage.id}: recorded merge commit ${stageState.mergeCommit} is not an ` +
          "ancestor of HEAD. The integration branch was rewritten; refusing to continue.",
      );
    }
  }

  console.log(`[upstream-sync] verifying ${stage.id}`);
  const verification = runVerification(root, stage, stateDir);
  stageState = {
    ...stageState,
    status: verification.ok ? "verified" : "verify-failed",
    verifiedAt: verification.ok ? new Date().toISOString() : null,
    verifyResults: verification.results,
  };
  state.stages[stage.id] = stageState;
  saveState(join(stateDir, "state.json"), state);
  if (!verification.ok) {
    appendRunLog(stateDir, `verify-failed ${stage.id}`);
    fail(
      EXIT_VERIFY,
      `stage ${stage.id} failed verification; the replay refuses to advance.\n` +
        `See ${join(stateDir, "ledgers", `${stage.id}.txt`)}`,
    );
  }
  appendRunLog(stateDir, `verified ${stage.id} at ${stageState.mergeCommit}`);
  console.log(`[upstream-sync] stage ${stage.id} verified`);
}

function printPlan(resolved, state) {
  console.log(`[upstream-sync] ${resolved.length} stage(s):`);
  for (const stage of resolved) {
    const recorded = state.stages?.[stage.id];
    const status = recorded?.status ?? "pending";
    console.log(
      `  ${stage.id.padEnd(28)} ${stage.upstreamSha.slice(0, 12)}  ${status.padEnd(13)} ${stage.verify.length} check(s)`,
    );
  }
}

function dryRunStage(root, stage, baseRef) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", baseRef, stage.upstreamSha], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const conflicts = output
    .split("\n")
    .filter((line) => line.startsWith("CONFLICT"))
    .map((line) => line.trim());
  const paths = output
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "" && !line.startsWith("CONFLICT") && !line.startsWith("Auto-merging"))
    .map((line) => line.trim());
  return { conflicts, paths };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const startDir = options.repo ?? process.cwd();
  const root = resolveRepoRoot(startDir);
  const config = validateConfig(readJson(options.configPath, "stage config"), options.configPath);

  const branch = options.branch ?? config.branch;
  const forkRemote = options.forkRemote ?? config.forkRemote ?? "origin";
  const upstreamRemote = options.upstreamRemote ?? config.upstreamRemote ?? "upstream";
  const forkBranch = config.forkBranch ?? "master";
  const upstreamBranch = config.upstreamBranch ?? "master";
  const stateDir = resolveStateDir(root, config);
  const statePath = join(stateDir, "state.json");
  const state = loadState(statePath);

  for (const remote of [forkRemote, upstreamRemote]) {
    const url = gitText(root, ["remote", "get-url", remote], { allowFail: true });
    if (!url) fail(EXIT_USAGE, `remote '${remote}' is not configured in ${root}`);
  }
  const forkUrl = gitText(root, ["remote", "get-url", forkRemote]);
  const upstreamUrl = gitText(root, ["remote", "get-url", upstreamRemote]);
  if (forkUrl === upstreamUrl) {
    fail(EXIT_USAGE, `'${forkRemote}' and '${upstreamRemote}' point at the same URL`);
  }

  if (options.fetch) {
    console.log(`[upstream-sync] fetching ${upstreamRemote}/${upstreamBranch}`);
    runGit(root, ["fetch", "--no-tags", upstreamRemote, upstreamBranch]);
    console.log(`[upstream-sync] fetching ${forkRemote}/${forkBranch}`);
    runGit(root, ["fetch", "--no-tags", forkRemote, forkBranch]);
  }
  const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;
  const forkRef = `${forkRemote}/${forkBranch}`;

  const resolved = resolveStages(root, config, upstreamRef, state);

  if (options.plan || options.dryRun) {
    printPlan(resolved, state);
    if (options.dryRun) {
      // merge-tree measures each endpoint against the branch tip as it is now.
      // Later stages will be estimated against a tree that does not exist yet,
      // so this is a per-stage estimate, not the cumulative replay result.
      const branchExists =
        runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true })
          .status === 0;
      const base = branchExists ? branch : forkRef;
      console.log(
        `[upstream-sync] dry-run conflict estimate against ${base} (no worktree changes):`,
      );
      for (const stage of resolved) {
        const estimate = dryRunStage(root, stage, base);
        console.log(
          `  ${stage.id.padEnd(28)} ${String(estimate.paths.length).padStart(4)} conflicted path(s)`,
        );
        for (const path of estimate.paths) console.log(`    ${path}`);
      }
    }
    process.exit(EXIT_OK);
  }

  ensureBranch(root, branch, forkRemote, forkBranch, forkRef);

  let stoppedAt = null;
  for (const stage of resolved) {
    const recorded = state.stages?.[stage.id];
    if (recorded?.status === "verified") {
      const stillAncestor = runGit(
        root,
        ["merge-base", "--is-ancestor", recorded.mergeCommit, "HEAD"],
        { allowFail: true },
      );
      if (stillAncestor.status === 0) {
        console.log(`[upstream-sync] stage ${stage.id} already verified (${recorded.mergeCommit.slice(0, 12)})`);
        continue;
      }
      fail(
        EXIT_USAGE,
        `stage ${stage.id} is recorded as verified at ${recorded.mergeCommit}, but that ` +
          "commit is not an ancestor of HEAD. Refusing to re-verify a rewritten branch.",
      );
    }
    advanceStage(root, stage, state, stateDir);
    if (options.stage && stage.id === options.stage) {
      stoppedAt = stage.id;
      break;
    }
  }

  const pending = resolved.filter((stage) => state.stages?.[stage.id]?.status !== "verified");
  if (pending.length > 0) {
    fail(
      EXIT_VERIFY,
      `replay stopped with ${pending.length} stage(s) not verified: ` +
        pending.map((stage) => stage.id).join(", "),
    );
  }
  if (!stoppedAt && options.push) {
    console.log(`[upstream-sync] pushing ${branch} to ${forkRemote} (no force)`);
    runGit(root, ["push", "--set-upstream", forkRemote, `refs/heads/${branch}`]);
  }
  appendRunLog(stateDir, `replay complete on ${branch}`);
  console.log(`\n[upstream-sync] all ${resolved.length} stage(s) verified on ${branch}`);
}

main();

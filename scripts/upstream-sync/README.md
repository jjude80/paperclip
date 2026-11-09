# Upstream fork-sync replay

The served board is installed from the `jjude80/paperclip` fork. That fork
drifts from `paperclipai/paperclip`; a single merge of upstream master into
fork master is not reviewable (495+ conflicted paths measured 2026-11-09), and
a half-merged tree must never be installed.

This directory contains the replay machinery:

| file | purpose |
| --- | --- |
| `bootstrap-scratch-clone.sh` | creates a scratch clone outside the shared checkout with asymmetric remotes |
| `replay-upstream-sync.mjs` | resolves the stage plan, merges one stage at a time, records conflicts, runs that stage's verification, and refuses to advance on failure |
| `verify-merged-tree.mjs` | dependency-free structural gate: conflict markers, duplicate migration numbers, journal/file agreement, manifest parsing, lockfile shape |
| `stages.json` | the real stage plan owned by NEXA-880; intentionally empty until that plan lands |
| `stages.provisional.json` | daily-slice example used to exercise the tooling; not approval to land a stage |
| `replay-upstream-sync.test.mjs` | end-to-end tests against throwaway git repositories |

## 1. Scratch clone

Never replay in the shared checkout. It carries uncommitted
recovery/heartbeat edits that belong to another run.

```bash
scripts/upstream-sync/bootstrap-scratch-clone.sh /var/tmp/paperclip-sync-nexa881
cd /var/tmp/paperclip-sync-nexa881
```

The script clones the fork, adds `upstream` as fetch-only (its push URL is set
to `DISABLED-upstream-is-fetch-only`), fetches both masters, and creates
`sync/upstream-2026-11-09` from `origin/master` with no upstream tracking. It
never creates, rewrites or force-pushes fork master.

Remotes after bootstrap:

```
origin    https://github.com/jjude80/paperclip.git       (fetch + push)
upstream  https://github.com/paperclipai/paperclip.git   (fetch; push disabled)
```

## 2. Stage plan

`stages.json` is the contract between the triage plan (NEXA-880) and the
replay:

```json
{
  "schemaVersion": 1,
  "branch": "sync/upstream-2026-11-09",
  "forkRemote": "origin",
  "upstreamRemote": "upstream",
  "forkBranch": "master",
  "upstreamBranch": "master",
  "stateDir": ".upstream-sync",
  "stages": [
    {
      "id": "s01-2026-10-23",
      "upstream": "2026-10-23",
      "verify": [
        "node scripts/upstream-sync/verify-merged-tree.mjs",
        "pnpm install --frozen-lockfile",
        "pnpm typecheck"
      ]
    }
  ]
}
```

`upstream` may be a full/short commit SHA, a ref, or a `YYYY-MM-DD` date
(resolved to the last upstream commit on or before 23:59:59Z that day).
Endpoints must be chronological and each must be an ancestor of the upstream
branch. Resolved SHAs are pinned in `.upstream-sync/state.json`; changing a
stage endpoint after a replay has started is refused rather than silently
redefining what was verified.

`verify` must be non-empty. Commands run with `bash -c` from the repository
root with `SYNC_STAGE_ID` and `SYNC_UPSTREAM_SHA` in the environment. The
baseline `verify-merged-tree.mjs` is cheap and always useful; NEXA-880's
per-stage build/typecheck/targeted tests go in addition to it, not instead of
it.

## 3. Replay

```bash
# What would run? Fetches both remotes, resolves endpoints, no checkout/merge.
node scripts/upstream-sync/replay-upstream-sync.mjs --plan

# Per-stage conflict estimate against the current branch tip (git merge-tree,
# no worktree changes).
node scripts/upstream-sync/replay-upstream-sync.mjs --dry-run

# Replay every stage in order. Stops at the first conflicted or unverified stage.
node scripts/upstream-sync/replay-upstream-sync.mjs --config scripts/upstream-sync/stages.json

# One stage at a time.
node scripts/upstream-sync/replay-upstream-sync.mjs --stage s01-2026-10-23

# After a clean replay, publish the integration branch (never master, no force).
node scripts/upstream-sync/replay-upstream-sync.mjs --push
```

Exit codes:

| code | meaning |
| --- | --- |
| 0 | every stage is merged and verified (or the requested plan/dry run completed) |
| 2 | usage, config, or preflight failure; nothing advanced |
| 3 | the stage has unresolved conflicts; merge left in progress, ledger written |
| 4 | the stage's verification failed, or stages remain unverified; replay paused |
| 5 | no stages configured yet (waiting on NEXA-880) |

### Conflict handling

On conflict the script leaves the merge in progress, writes
`.upstream-sync/ledgers/<stage>.txt` with `git merge` output and every
unmerged path, records the stage as `conflicted`, and exits 3. Resolve the
paths, `git add` them, and re-run the same command: the script commits the
merge resolution, then runs verification. It does not silently choose a side
and it does not advance while unmerged paths remain.

### Verification and resume

A stage merge that verifies is recorded with its merge commit and per-command
results. Re-running skips verified stages only if their merge commit is still
an ancestor of HEAD; if the branch was rewritten the replay refuses. A stage
that fails verification stays `verify-failed` and is re-verified on the next
run without being merged again.

State lives in `.upstream-sync/` (git-ignored): `state.json`, per-stage
ledgers, and an append-only `runs.log`.

## 4. Tests

```bash
node --test scripts/upstream-sync/replay-upstream-sync.test.mjs
```

The suite builds throwaway fork/upstream repositories and covers: chronological
replay, conflict recording and resolution, verification refusal without a
re-merge, protected-branch refusal, plan mode leaving the branch untouched,
and the empty-plan exit.

## Safety rules encoded in the tool

- integration branch is never `master`/`main`; the script refuses that name
- `--push` pushes only `refs/heads/<integration branch>` to the fork remote,
  never force, never upstream
- a clean working tree is required before each new stage
- a merge this script did not start is refused rather than adopted
- redefining a resolved stage endpoint mid-replay is refused
- rewritten integration history is refused instead of re-verified

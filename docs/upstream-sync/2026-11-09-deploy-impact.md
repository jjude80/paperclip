# Deploy impact: serving the merged fork (2026-11-09)

Status: **assessment only. Nothing was deployed, installed, migrated, or
restarted.** This document answers what changes if the reconciled tree is
served, whether it can be served on the current payload/schema, and in what
order.

## Measured baseline

All refs measured in the scratch clone `/var/tmp/paperclip-sync-nexa881`
created by `scripts/upstream-sync/bootstrap-scratch-clone.sh`.

| item | value |
| --- | --- |
| fork master | `ca57b574563df4784cd9c00491dfc190f90e8d0c` |
| upstream master (start of run) | `052c638b519ebb15f81e4fcd1a96adf6cd3b2f10` |
| upstream master (end of run) | `87e755ce8e6fafcc5594b4c004455690f551057f` |
| merge base | `b6e690044a821faab52d5466db36c4330c754a2d` |
| divergence | fork **90 ahead**, upstream **1,612 behind** at end of run |
| conflicted paths, single merge | **503** against `87e755ce` (`495` against the triage's `3ef45fdd9`) |
| served payload | `c1d0ce1c4633aa6cae21bcc2fa45841381cdd99e`, installed 2026-11-08T06:15:44Z |
| served payload vs fork master | 3 commits on the served line not in master, 10 on master not served |
| live database | embedded PostgreSQL on `127.0.0.1:54329`, **380 migrations applied, 0 pending** |
| host runtime | Node `v24.21.0`, pnpm `9.15.4` (both satisfy upstream) |
| service | user unit `paperclipai.service`, `TimeoutStartSec=420`, non-TTY |

Upstream moved 5 commits during this run (`052c638b5` -> `87e755ce8`), which
is itself evidence for the cadence section. The triage pinned `3ef45fdd9`;
the replay plan should pin that SHA (or the tip agreed at execution) rather
than float on a date, so that two operators resolve the same target.

## Can the merged tree be served without a migration or payload switch?

**No, on both counts.**

- The board runs from an installed payload at `~/.paperclip/cli/current`
  (a symlink into `~/.paperclip/cli/installs/git/c1d0ce1c4633`), not from a git
  checkout. Nothing in a merged git tree changes the running server until a
  new payload is built and installed.
- Upstream adds **72 migrations** (`0381`..`0452`). The live database has none
  of them. The server refuses to serve a schema it considers stale, and the
  service is non-TTY so it would auto-apply them during boot, inside a 420s
  systemd start timeout.

A source-only merge is therefore not deployable at all, and a payload-only
install without the migrations cannot start.

## 1. Database: the blocking change

### 1.1 One real number collision

The fork carries upstream's `0376`..`0380` byte-for-byte, plus one migration of
its own:

```
fork:     0376 0377 0378 0379 0380 0381_next_prima
upstream: 0376 0377 0378 0379 0380 0381_mean_scream ... 0452_secret_proposal_secret_cascade
```

`0381_next_prima.sql` (NEXA-707, `issues_open_routine_execution_uq`) is the
only fork-only migration, and its hash `65e89aac7434e70e076526e3f58401c68e5f83b1c5bdc2dae70674055f83c8c5`
**is present in the live `drizzle.__drizzle_migrations` table**. It has already
been applied in production.

The merge cannot keep two `0381_*.sql` files: `packages/db/src/check-migration-numbering.ts`
rejects duplicate numbers, the journal would have two tags, and
`git merge-tree` reports the migration directory and `_journal.json` as
conflicting.

### 1.2 Recommended resolution (for NEXA-882..886, not implemented here)

**Renumber the fork's single migration to `0453_next_prima.sql`, keep the file
bytes identical, and take upstream's numbering unchanged.**

Why this direction and not the other:

- `packages/db/src/client.ts` hardcodes **37** migration filenames `>= 0381` in
  `MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS` (the `CONCURRENTLY` index builds that
  must run as top-level statements). Renaming 72 upstream files would require
  editing 37 hardcoded entries plus 72 journal tags plus the snapshot window.
  Renaming the one fork file requires none of that.
- The migration runner treats a migration as applied when **either** its
  filename **or** its SHA-256 content hash matches a history row
  (`migrationHistoryEntryExists`, `packages/db/src/client.ts`). Renaming the
  file without changing its bytes preserves the hash, so the live database
  recognises the renumbered migration as already applied and does not re-run
  the index swap.
- Fresh installs still get the index change last, after `0452`.

The renumber touches four things: the `.sql` filename, the appended
`_journal.json` entry (new last index), the snapshot window, and any hardcoded
reference to `0381_next_prima` (none found outside the journal/snapshot). The
snapshot window is five files on both sides (`0448`..`0452` upstream,
`0376`..`0381` fork); after the merge the window must end at a regenerated
`0453` snapshot that contains the merged schema, because upstream's `0452`
snapshot predates the fork's unique index.

Verification for this stage must include, at minimum:

```bash
node scripts/upstream-sync/verify-merged-tree.mjs
pnpm --filter @paperclipai/db exec tsx src/check-migration-numbering.ts   # or the repo's pinned runner
pnpm --filter @paperclipai/db test                                          # includes migration-snapshot-drift
```

### 1.3 Migration safety and duration

The 72 new migrations are DDL, not data loss:

- no `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, or primary-key rewrite
- four `ADD COLUMN ... NOT NULL` statements, all with a default
  (`0430`, `0433`, `0440` x3)
- `0416_salty_domino.sql` drops and recreates one partial index
- `0452_secret_proposal_secret_cascade.sql` drops an FK with `IF EXISTS` and
  recreates it with cascade behaviour
- **37 of the 72 use `CREATE INDEX CONCURRENTLY`**, so they take the special
  top-level statement path and cannot run inside a transaction batch

Consequence: the first boot on the merged payload would try to apply 72
migrations, 37 of them concurrent index builds, inside a 420s start timeout.
That is the wrong place to find out how long it takes. Measure it on a restored
copy of the production database first (see activation order).

## 2. Runtime and configuration behaviour

### 2.1 Config/storage refactor, but no new required environment

`server/src/config.ts` moves storage config into `server/src/storage/config.ts`
and adds `isCloudManagedInstance()` gating plus `managed-cloud-prerequisites`.
The environment names are unchanged (`PAPERCLIP_STORAGE_PROVIDER`,
`PAPERCLIP_STORAGE_LOCAL_DIR`, `PAPERCLIP_STORAGE_S3_*`), and this instance is
`provider = "local_disk"` with `secrets.provider = "local_encrypted"`.

The cloud prerequisites only fire when `PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN`
or `PAPERCLIP_MANAGED_CONFIG` is set. Neither is present in the live process
environment, so this board stays on the self-hosted path. The existing
`config.json` v1 still parses; there is no config-file migration step.

### 2.2 New background retention defaults

New settings and defaults that change behaviour without any operator action:

| setting | default |
| --- | --- |
| `PAPERCLIP_NATIVE_WORKSPACE_SYNC_RETENTION_ENABLED` | **on** (`!== "false"`), 7 days |
| `PAPERCLIP_NATIVE_HARNESS_BACKUP_EXPIRATION_ENABLED` | **on** (`!== "false"`), 7 days |
| `PAPERCLIP_TASK_DIRECTORY_RETENTION_ENABLED` | off, dry-run on |
| `PAPERCLIP_ISOLATED_SOURCE_REHOME_ENABLED` | off |
| `PAPERCLIP_NESTED_CLONE_MIGRATION_ENABLED` | off |

The two retention cleaners delete workspace-sync and harness-backup artifacts
older than 7 days. Treat them as a data-affecting change: confirm the backup
chain and restore drill cover those artifacts, or set the two
`*_RETENTION_ENABLED=false` variables for the first activation window.

### 2.3 Startup refusal semantics

`server/src/startup-refusals.ts` adds typed refusals for pending/unmigrated
schema. For this host the observable behaviour is unchanged from the served
payload: non-TTY boot auto-answers the migration prompt (applies migrations)
and refuses to start if that is turned off. The change matters for how boot
failures are reported, not for whether migrations run.

### 2.4 Observability

`server/src/instrumentation.ts` now configures NodeSDK with empty
`metricReaders`/`logRecordProcessors`: the OTLP integration exports **traces
only**. The live process has no `OTEL_*` variables, so nothing changes today.
If metrics/logs are enabled later, they will not arrive through this
integration.

## 3. Runner and adapters

`@paperclipai/paperclip-runner` is **not** a dependency of the installed
server or CLI payload, and no `paperclip-runnerd` binary is installed on this
host. Upstream's heavy runner/protocol changes (45 conflicted runner files,
new provider packs, protocol contract generators) therefore do not block
serving the board.

They do change the code path the board uses to execute agents: the adapter
packages (`adapter-opencode-local`, `adapter-codex-local`, `adapter-utils`,
etc.) **are** in the payload and were substantially rewritten upstream. The
activation check must include a real agent run, not just HTTP health: start a
throwaway task on the upgraded board and confirm the runner starts, the session
opens, a message streams, and the run settles. If a native runner is deployed
elsewhere, upgrade it in lockstep with the server; the protocol contract is
generated from the same tree.

## 4. Build and install

- `pnpm-lock.yaml` conflicts. Do not hand-merge it: resolve the
  `package.json` conflicts, then regenerate the lockfile and commit it, then
  `pnpm install --frozen-lockfile` on a clean tree.
- New root dev dependencies (`oxc-parser`, `yaml`, `turbo`) and a new sandbox
  provider workspace (`packages/plugins/sandbox-providers/boxd`) mean a full
  workspace install is required, not just a server build.
- Node engine is unchanged (`>=24.11.0`); host is `v24.21.0`.
- Dockerfile changes are irrelevant to this host: the board is a native
  per-user install, not a container.
- The payload must be built from the merged tree and installed into the CLI
  store; `~/.paperclip/cli/current` is a symlink, so the previous payload
  (`c1d0ce1c4633`) remains available for rollback.

## 5. Safe activation order

Every step is reversible; step 4 is the point of no return for the database.

1. **Finish the replay** on `sync/upstream-2026-11-09`, resolve all stage
   conflicts, and pass every stage's verification. Merge to fork master through
   review. Do not force-push master.
2. **Build** the payload from the merged tree and record its source commit and
   digest. Do not install it yet.
3. **Backup and prove restore.** `paperclipai db:backup`, then restore that
   backup into a throwaway instance and start it. An unproven backup is not a
   rollback plan.
4. **Rehearse the migration** on the restored copy using the new tree's
   migrator. Measure wall-clock duration for all 72 migrations, including the
   37 concurrent index builds. It must fit comfortably inside the 420s start
   timeout, otherwise the live migration must be run as an explicit pre-step
   outside systemd (recommended regardless).
5. **Freeze and take the final backup.** Stop starting new runs (drain the
   board) or accept that in-flight runs are interrupted and recovered by the
   new controller logic. Take a fresh backup after the drain.
6. **Apply migrations while the old service is stopped**, with the new tree's
   migration entry point and a generous external timeout. Do not let the first
   attempt be a systemd boot.
7. **Install the payload, point `current` at it, start the service**, and watch
   the boot reach `READY=1` inside the timeout.
8. **Verify:** `/api/health` returns the new commit; migration count is 380 +
   72 = 452 and pending is zero; UI loads; an issue read works; one throwaway
   agent run starts, streams, and settles; backup timer and deploy-sync timer
   are active; the served-payload drift check is clean.
9. **Rollback:** restore the step-5 backup and point `current` back at
   `c1d0ce1c4633`, then start the old service. There are no down migrations, so
   rolling the code back without the database backup is not a rollback.

## 6. Cadence recommendation

The fork fell 1,607 commits / 17 days behind and the single-merge result is 503
conflicted paths. The goal is to keep every sync under roughly one week of
upstream history (currently ~700-1,200 commits) and to make the merge a
routine, verified event.

| item | recommendation |
| --- | --- |
| cadence | **twice weekly** replay (Monday and Thursday, 03:00 local) into `sync/upstream-YYYY-MM-DD`; daily only if upstream volume exceeds ~200 commits/day for a sustained week |
| owner | Ingrid Solberg (platform/infrastructure); Elena Vasquez escalates if a sync is blocked more than one cycle |
| merge gate | stage verification from NEXA-880 plus `verify-merged-tree.mjs`; a sync branch that has not passed every stage is never merged or installed |
| alert threshold | open a high-priority board issue when `git rev-list --count fork/master..upstream/master` exceeds **250 commits** or when the last successful sync is more than **5 days** old; page at **500 commits / 10 days** |
| drift signal | a scheduled timer (for example `paperclip-upstream-drift.timer`) fetches `upstream` without touching the worktree, records behind-count and upstream tip, and files/updates one board issue at the threshold instead of alerting every tick |
| review | the integration branch is pushed to the fork and merged by PR; fork master is never rewritten or force-pushed |
| busy periods | pause the timer during a board release window, but not more than one cycle; a paused sync still counts toward the age threshold |

The threshold is deliberately based on commits *and* age: a quiet upstream week
should not manufacture a sync, and a fast upstream week should not silently
grow the conflict surface.

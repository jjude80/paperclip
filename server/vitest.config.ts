import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/paperclip-runner\/live$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/live/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@paperclipai\/paperclip-runner$/,
        replacement: fileURLToPath(
          new URL("../packages/paperclip-runner/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Each server suite boots + tears down its own embedded Postgres in
    // beforeAll/afterAll. Under the loaded serial shard (maxWorkers=1) the
    // graceful shutdown can occasionally cross vitest's default 10s hookTimeout,
    // producing flaky "Hook timed out in 10000ms" afterAll failures on CI. Give
    // the boot/teardown hooks generous headroom; 30s is far above the observed
    // worst-case teardown yet still catches a genuinely hung hook. teardownTimeout
    // mirrors it for the same reason.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    // Two separate costs have to fit inside one per-test budget.
    //
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file pays the one-time transform cost inside its own timeout budget, and
    // on the loaded serial shard (maxWorkers=1) that cost crossed vitest's
    // default 5s, which is why this budget exists at all.
    //
    // The git/filesystem suites then spend the budget on real work rather than
    // module load. A single case in nested-clone-migration.test.ts builds two
    // bare repositories, wires an isolated workspace, runs the migration, the
    // expiration, the restore-point round trip and a reopen -- dozens of `git`
    // subprocesses and fsyncs. Measured here on an idle-ish 12-core host, that
    // case takes 17.0s and 24.1s on two consecutive runs; git-workspace-
    // expiration.test.ts tops out near 10s but climbs under load. With a 15s
    // budget those runs were a coin flip, which is why a *different* shard and
    // a different test went red on each CI run (NEXA-804): the failure tracked
    // test wall-clock, not a regression.
    //
    // 60s is ~2.5x the worst case measured locally, so it absorbs a rival
    // fork's contention on the shard's other worker, and it still catches a
    // genuinely hung test far inside the 20 minute job limit. Do not shrink
    // this back toward the module-load number: it is the I/O suites that set
    // the floor.
    testTimeout: 60000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    pool: "forks",
    // Server suites share process state and one embedded Postgres instance,
    // so tests inside a file must run one at a time. Do not set
    // sequence.concurrent to true.
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});

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
    // beforeAll/afterAll. The first start on a cold host (fresh embedded-PG
    // install, cold page cache) was measured at 36s here; 20s and 30s budgets
    // made a healthy suite report "Hook timed out in 20000ms" with every test
    // skipped (NEXA-788). Give the boot/teardown hooks the same 90s budget that
    // packages/db already uses for its embedded-Postgres cost class
    // (EMBEDDED_POSTGRES_TEST_TIMEOUT_MS) -- ample even for a cold, contended
    // runner, while a genuinely hung hook still fails well inside the job limit.
    // Suites that pass an explicit timeout to beforeAll/afterAll override this,
    // so those literals were raised to 90_000 too.
    hookTimeout: 90_000,
    teardownTimeout: 90_000,
    // The route/authz suites import very large modules (for example
    // src/routes/issues.ts and its dependency graph). The first test in each
    // file pays the one-time transform cost inside its own timeout budget. On
    // the loaded serial shard (maxWorkers=1) that cost can cross vitest's
    // default 5s testTimeout and fail the first test, which also lets its
    // fire-and-forget wake leak into the next test. Give each test generous
    // headroom; 15s is far above the observed module-load cost yet still
    // catches a genuinely hung test well inside the 20 minute job limit.
    testTimeout: 15000,
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

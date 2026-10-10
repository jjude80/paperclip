import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  agents,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  agentRuntimeState,
  activityLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { routeApp, seedCompanyWithBoardAccess, resetCompanyIssueFixtures } from "./helpers/route-test-harness.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function deleteHeartbeatRunsAfterEvents(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(costEvents);
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt < 4 &&
        message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

describeEmbeddedPostgres("POST /agents/:id/heartbeat/invoke idempotency and auth source", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seeded: Awaited<ReturnType<typeof seedCompanyWithBoardAccess>>;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-invoke-test-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    seeded = await seedCompanyWithBoardAccess(db, "Test Company");
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(activityLog);
    await deleteHeartbeatRunsAfterEvents(db);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
  });

  afterAll(async () => {
    await db.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    await db.delete(agents).where(eq(agents.id, agentId));
    await resetCompanyIssueFixtures(db);
    await tempDb?.cleanup();
  }, 60_000);

  let agentRoutes: ReturnType<typeof import("../routes/agents.js").agentRoutes>;

  beforeAll(async () => {
    const mod = await import("../routes/agents.js");
    agentRoutes = mod.agentRoutes(db);
  });

  function makeApp(actorSource: "session" | "board_key" = "session") {
    const actor = { ...seeded.actor, source: actorSource };
    return routeApp(db, actor, () => agentRoutes);
  }

  it("accepts idempotencyKey and coalesces concurrent requests into one run", async () => {
    const app = makeApp("session");
    const idempotencyKey = `test-idempotency-${randomUUID()}`;
    const N = 5;

    const promises = Array.from({ length: N }, () =>
      request(app)
        .post(`/api/agents/${agentId}/heartbeat/invoke`)
        .send({ idempotencyKey })
    );

    const responses = await Promise.all(promises);
    const runIds = responses.map((r) => r.body.id).filter(Boolean);
    const uniqueRunIds = new Set(runIds);

    expect(uniqueRunIds.size).toBe(1);
    expect(runIds.length).toBe(N);

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(wakeup).toBeDefined();
    expect(wakeup.idempotencyKey).toBe(idempotencyKey);
  });

  it("records actor auth source as 'session' for session-authenticated requests", async () => {
    const app = makeApp("session");
    const idempotencyKey = `test-auth-source-session-${randomUUID()}`;

    const response = await request(app)
      .post(`/api/agents/${agentId}/heartbeat/invoke`)
      .send({ idempotencyKey });

    expect(response.status).toBe(202);
    const run = response.body;
    expect(run.id).toBeDefined();

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(wakeup).toBeDefined();
    expect(wakeup.requestedByActorType).toBe("user");
    expect(wakeup.requestedByActorId).toBe(seeded.actor.userId);
    expect(wakeup.actorAuthSource).toBe("session");
    expect(wakeup.peerAddress).toBeDefined();
  });

  it("records actor auth source as 'board_key' for board-key-authenticated requests", async () => {
    const app = makeApp("board_key");
    const idempotencyKey = `test-auth-source-boardkey-${randomUUID()}`;

    const response = await request(app)
      .post(`/api/agents/${agentId}/heartbeat/invoke`)
      .send({ idempotencyKey });

    expect(response.status).toBe(202);
    const run = response.body;
    expect(run.id).toBeDefined();

    const [wakeup] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(wakeup).toBeDefined();
    expect(wakeup.requestedByActorType).toBe("user");
    expect(wakeup.requestedByActorId).toBe(seeded.actor.userId);
    expect(wakeup.actorAuthSource).toBe("board_key");
    expect(wakeup.peerAddress).toBeDefined();
  });
});
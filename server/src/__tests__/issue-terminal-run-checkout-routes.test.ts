import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-run checkout route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * NEXAA-154 Finding B. The NEXAA-152 reproduction is a conversation that
 * presents the *terminal* run id of the wake that started it:
 *
 *   terminal run POST /issues/:id/checkout
 *     -> 200, status flips to `in_progress` under the dead run id
 *   terminal run PATCH /issues/:id
 *     -> the write guard clears the terminal lock, cannot adopt it (the actor
 *        is dead) and answers 409
 *
 * These are route-level tests: they mount the real issue router against a real
 * database so the assertion observes the sequence a runner actually performs,
 * not just the service helper in isolation.
 */
describeEmbeddedPostgres("terminal run issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-run-checkout-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: "board-user",
      name: "Board",
      email: "board@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      status: input.status,
      invocationSource: "assignment",
      contextSnapshot: { issueId: input.issueId },
      ...(input.status === "running" ? { startedAt: new Date() } : { finishedAt: new Date() }),
    });
    return runId;
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  it("refuses a terminal run's checkout instead of parking the issue in_progress under a dead lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resumed wake",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const terminalRunId = await insertRun({ companyId, agentId, issueId, status: "interrupted" });

    const res = await request(createApp(agentActor(companyId, agentId, terminalRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["blocked"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue checkout requires a live run");

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // The wake row stays parked: no in_progress row is created that the dead
    // run could never release, and a live run can still claim it later.
    expect(row).toEqual({
      status: "blocked",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("keeps the pre-fix residue (in_progress, no checkout owner) closed to a terminal run", async () => {
    // This is the exact row state the old checkout produced. Even though a
    // terminal run's checkout is now refused, rows already parked this way by
    // a running service stay fail-closed until a live run adopts them.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Already parked by a dead run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
    });
    const terminalRunId = await insertRun({ companyId, agentId, issueId, status: "interrupted" });

    const res = await request(createApp(agentActor(companyId, agentId, terminalRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should stay parked" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");

    const row = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ status: "in_progress", checkoutRunId: null });
  });

  it("lets the live run dispatched for the resumed conversation check out and land its disposition", async () => {
    // Normal dispatch creates a new run for the resume (heartbeat.ts performs
    // the checkout under that run id), so this is the sequence a healthy
    // resumed conversation follows.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resumed wake",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const liveRunId = await insertRun({ companyId, agentId, issueId, status: "running" });

    const checkout = await request(createApp(agentActor(companyId, agentId, liveRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["blocked"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body).toMatchObject({
      status: "in_progress",
      checkoutRunId: liveRunId,
      executionRunId: liveRunId,
    });

    const patched = await request(createApp(agentActor(companyId, agentId, liveRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ status: "todo" });
  });

  it("already lets the assignee write a parked issue before the checkout-owner guard", async () => {
    // The removed blocked-only reconciliation branch tried to grant this at the
    // checkout-owner guard, which only runs for in_progress rows. A parked row
    // never reaches it, so the write is already allowed and needs no grant.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale wake left this parked",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const terminalRunId = await insertRun({ companyId, agentId, issueId, status: "interrupted" });

    const res = await request(createApp(agentActor(companyId, agentId, terminalRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Disposition from the stale wake" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "blocked", title: "Disposition from the stale wake" });
  });
});

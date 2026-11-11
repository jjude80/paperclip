import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { agentActionAuditService } from "../services/agent-action-audit.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-delete attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue deletion guard and attribution (NEXA-984)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-delete-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use("/api", activityRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string) {
    return {
      type: "board",
      source: "session",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string) {
    return {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: randomUUID(),
    };
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Delete Attribution Co",
      issuePrefix: "DEL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Delete Target Runner",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "DEL-1",
      title: "Throwaway deletion target",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  it("refuses delete for the assignee agent: a mutation grant is not a delete grant", async () => {
    const { companyId, agentId, issueId } = await seed();

    const response = await request(app(agentActor(companyId, agentId)))
      .delete(`/api/issues/${issueId}`);

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toBe("Board access required");
    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toHaveLength(0);
  });

  it("records a board deletion with a self-contained, readable snapshot", async () => {
    const { companyId, issueId } = await seed();

    const deleted = await request(app(boardActor(companyId))).delete(`/api/issues/${issueId}`);

    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toHaveLength(0);

    const [record] = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(record).toMatchObject({
      companyId,
      action: "issue.deleted",
      entityType: "issue",
      actorType: "user",
      actorId: "board-user",
      agentId: null,
    });
    expect(record.details).toMatchObject({
      identifier: "DEL-1",
      title: "Throwaway deletion target",
      status: "todo",
    });
  });

  it("keeps the deletion record readable in the company activity feed for the board", async () => {
    const { companyId, issueId } = await seed();
    await request(app(boardActor(companyId))).delete(`/api/issues/${issueId}`).expect(200);

    const feed = await request(app(boardActor(companyId)))
      .get(`/api/companies/${companyId}/activity`)
      .query({ entityType: "issue", entityId: issueId });

    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    const record = feed.body.find((row: { action: string }) => row.action === "issue.deleted");
    expect(record).toBeTruthy();
    expect(record.details).toMatchObject({
      identifier: "DEL-1",
      title: "Throwaway deletion target",
    });
  });

  it("does not widen the deletion record to agents through the activity feed", async () => {
    const { companyId, agentId, issueId } = await seed();
    await request(app(boardActor(companyId))).delete(`/api/issues/${issueId}`).expect(200);

    const feed = await request(app(agentActor(companyId, agentId)))
      .get(`/api/companies/${companyId}/activity`)
      .query({ entityType: "issue", entityId: issueId });

    expect(feed.status, JSON.stringify(feed.body)).toBe(200);
    expect(feed.body.filter((row: { action: string }) => row.action === "issue.deleted")).toHaveLength(0);
  });

  it("returns the identifier and title from the audit record after the issue row is gone", async () => {
    const { companyId, issueId } = await seed();
    await request(app(boardActor(companyId))).delete(`/api/issues/${issueId}`).expect(200);

    const audit = await agentActionAuditService(db).list({
      companyId,
      actorScope: "all",
      action: "issue.deleted",
      limit: 10,
    });

    const item = audit.items.find((row) => row.entityId === issueId);
    expect(item).toBeTruthy();
    expect(item?.entity.issue).toMatchObject({
      id: issueId,
      identifier: "DEL-1",
      title: "Throwaway deletion target",
    });
    expect(item?.details).toMatchObject({ identifier: "DEL-1" });
  });
});

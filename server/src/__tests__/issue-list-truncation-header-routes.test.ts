import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list truncation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list truncation signal", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-truncation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `T${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  async function seedIssues(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    const base = new Date("2026-07-01T00:00:00.000Z").getTime();
    await db.insert(issues).values(
      Array.from({ length: count }, (_, index) => ({
        id: randomUUID(),
        companyId,
        title: `Issue ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
        updatedAt: new Date(base + index * 1_000),
      })),
    );
    return companyId;
  }

  it("reports that another page exists when the page is cut short", async () => {
    const companyId = await seedIssues(3);
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "2" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers["x-has-more"]).toBe("true");
  });

  it("does not claim another page when the page is exactly full", async () => {
    const companyId = await seedIssues(2);
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "2" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers["x-has-more"]).toBe("false");
  });

  it("reports no further page for the last page reached through offset", async () => {
    const companyId = await seedIssues(3);
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "2", offset: "2" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.headers["x-has-more"]).toBe("false");
  });

  it("carries the signal on the compact projection as well", async () => {
    const companyId = await seedIssues(3);
    const app = createApp(companyId);

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ limit: "2", view: "compact" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers["x-has-more"]).toBe("true");
  });
});

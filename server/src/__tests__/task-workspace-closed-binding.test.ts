import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issues,
  projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertTaskWorkspaceExecutionAccess } from "../services/task-workspace-access.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("task workspace access for a closed binding", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else { database = await startEmbeddedPostgresTestDatabase("task-workspace-closed-binding-"); db = createDb(database.connectionString); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), ownerAgentId = randomUUID(), triageAgentId = randomUUID();
    const issueId = randomUUID(), triageIssueId = randomUUID(), ownerRunId = randomUUID(), triageRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Closed binding", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: ownerAgentId, companyId, name: "Owner", adapterType: "process", status: "idle" },
      { id: triageAgentId, companyId, name: "Triage", adapterType: "process", status: "idle" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "agent", principalId: ownerAgentId, membershipRole: "member", status: "active" },
      { companyId, principalType: "agent", principalId: triageAgentId, membershipRole: "member", status: "active" },
    ]);
    const [project] = await db.insert(projects).values({ companyId, name: "Project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id,
      name: "Closed task files", cwd: `/tmp/${issueId}`, mode: "isolated_workspace", strategyType: "task_directory",
      status: "archived", closedAt: new Date("2026-10-24T14:05:07Z") }).returning();
    await db.insert(issues).values([
      { id: issueId, companyId, projectId: project!.id, title: "Stale binding", status: "backlog",
        executionWorkspaceId: workspace!.id },
      { id: triageIssueId, companyId, projectId: project!.id, title: "Triage run task", status: "in_progress",
        assigneeAgentId: triageAgentId },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: ownerRunId, companyId, agentId: ownerAgentId, issueId, status: "failed", contextSnapshot: { issueId } },
      { id: triageRunId, companyId, agentId: triageAgentId, issueId: triageIssueId, status: "running",
        contextSnapshot: { issueId: triageIssueId } },
    ]);
    return { companyId, issueId, workspaceId: workspace!.id, triageAgentId, triageRunId };
  }

  function triageActor(f: Awaited<ReturnType<typeof seed>>) {
    return { type: "agent" as const, source: "agent_jwt" as const, companyId: f.companyId,
      agentId: f.triageAgentId, runId: f.triageRunId };
  }

  it("admits a run from another task when the task binding is closed", async () => {
    const f = await seed();
    await expect(assertTaskWorkspaceExecutionAccess(db, triageActor(f), f.companyId, {
      issueId: f.issueId, workspaceId: f.workspaceId,
    })).resolves.toMatchObject({ task: { id: f.issueId }, workspace: { id: f.workspaceId } });
  });

  it("keeps rejecting a run from another task when the task binding is open", async () => {
    const f = await seed();
    await db.update(executionWorkspaces).set({ status: "active", closedAt: null })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    await expect(assertTaskWorkspaceExecutionAccess(db, triageActor(f), f.companyId, {
      issueId: f.issueId, workspaceId: f.workspaceId,
    })).rejects.toThrow("Task workspace run identity is unavailable");
  });
});

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

/**
 * NEXA-735: the assignment wake for a different-agent hand-off is admitted
 * while the interrupted run may still own the issue's environment lease. The
 * skip receipt used to be terminal, so the hand-off waited for an unrelated
 * wake. These tests pin the durable-wake behaviour and its exactly-once run.
 */
(support.supported ? describe : describe.skip)("hand-off wake after the interrupted run releases its lease", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("handoff-wake-retry-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  async function seedHandoff(input: { oldRunStatus: "cancelled" | "succeeded"; holdLease: boolean; acknowledgeCancellation?: boolean }) {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const oldRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Hand-off wake", defaultResponsibleUserId: "board",
      issuePrefix: "H" + companyId.replaceAll("-", "").slice(0, 6).toUpperCase(),
    });
    await db.insert(agents).values([
      { id: oldAgentId, companyId, name: "Implementer", role: "engineer", adapterType: "paperclip_runner",
        status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: newAgentId, companyId, name: "Reviewer", role: "engineer", adapterType: "paperclip_runner",
        status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Review the delivered change", status: "in_review", assigneeAgentId: newAgentId },
      { id: otherIssueId, companyId, title: "Unrelated busy work", status: "in_progress", assigneeAgentId: newAgentId },
    ]);
    await db.insert(heartbeatRuns).values({
      id: oldRunId, companyId, agentId: oldAgentId, runtimeMode: "legacy",
      status: input.oldRunStatus,
      ...(input.oldRunStatus === "cancelled" ? { errorCode: "issue_reassigned" } : {}),
      startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId, taskId: issueId },
      resultJson: {
        conversationContinuation: "continue_conversation_v1",
        ...(input.acknowledgeCancellation ? { executionCancellation: { state: "acknowledged" } } : {}),
      },
    });
    if (input.oldRunStatus === "cancelled") {
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    }
    let leaseId: string | null = null;
    if (input.holdLease) {
      const [lease] = await db.insert(environmentLeases).values({
        companyId, issueId, heartbeatRunId: oldRunId, status: "active",
      }).returning();
      leaseId = lease!.id;
    }
    // Occupy the reviewer so promotion proves the run rather than invoking a provider.
    await db.insert(heartbeatRuns).values({
      companyId, agentId: newAgentId, status: "running",
      contextSnapshot: { issueId: otherIssueId, taskId: otherIssueId },
    });
    return { companyId, oldAgentId, newAgentId, issueId, oldRunId, leaseId };
  }

  function handoffWake(f: Awaited<ReturnType<typeof seedHandoff>>) {
    return heartbeatService(db).wakeup(f.newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: f.issueId, interruptedRunId: f.oldRunId, mutation: "update" },
      contextSnapshot: { issueId: f.issueId, source: "issue.update", interruptedRunId: f.oldRunId },
    });
  }

  async function newAssigneeRuns(f: Awaited<ReturnType<typeof seedHandoff>>) {
    return db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.newAgentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
    )).orderBy(desc(heartbeatRuns.createdAt));
  }

  async function handoffWakes(f: Awaited<ReturnType<typeof seedHandoff>>) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.newAgentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`,
    )).orderBy(desc(agentWakeupRequests.requestedAt));
  }

  it("keeps the hand-off as a durable deferred wake and runs it once the lease is released", async () => {
    const f = await seedHandoff({ oldRunStatus: "cancelled", holdLease: true });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({
      runId: f.oldRunId, cause: "execution_owner_active",
    });

    expect(await handoffWake(f)).toBeNull();
    const [deferred] = await handoffWakes(f);
    expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null, source: "assignment" });
    expect(deferred!.payload?.executionWait).toMatchObject({
      reason: "execution_reconciliation_required", deferredHandoff: true,
    });
    expect(await newAssigneeRuns(f)).toHaveLength(0);

    // A repeated hand-off admission must not queue a second deferred receipt.
    expect(await handoffWake(f)).toBeNull();
    const repeated = await handoffWakes(f);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ status: "deferred_issue_execution", coalescedCount: 1 });

    // The lease is still held: the retry must not invent a run.
    await heartbeatService(db).resumeQueuedRuns();
    expect((await handoffWakes(f))[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await newAssigneeRuns(f)).toHaveLength(0);

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, f.leaseId!));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();

    await heartbeatService(db).resumeQueuedRuns();
    const runs = await newAssigneeRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: f.newAgentId, status: "queued" });
    expect(runs[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, wakeReason: "issue_assigned" });
    expect((await handoffWakes(f))[0]).toMatchObject({ status: "queued", runId: runs[0]!.id });

    // A second recovery pass must not promote the same hand-off again.
    await heartbeatService(db).resumeQueuedRuns();
    expect(await newAssigneeRuns(f)).toHaveLength(1);
    expect(await handoffWakes(f)).toHaveLength(1);
  }, 60_000);

  it("promotes the hand-off after an acknowledged reassignment cancellation", async () => {
    const f = await seedHandoff({ oldRunStatus: "cancelled", holdLease: true, acknowledgeCancellation: true });
    // A receipt left over from the previous assignee's own queue. Nothing
    // swept it, and it must not be replayed ahead of the new assignee.
    const [stale] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.oldAgentId, source: "automation",
      reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_blockers_resolved" } },
    }).returning();

    expect(await handoffWake(f)).toBeNull();
    const [deferred] = await handoffWakes(f);
    expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(deferred!.payload?.executionWait).toMatchObject({ deferredHandoff: true });

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, f.leaseId!));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();

    await heartbeatService(db).resumeQueuedRuns();
    const runs = await newAssigneeRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: f.newAgentId, status: "queued" });
    expect((await handoffWakes(f))[0]).toMatchObject({ status: "queued", runId: runs[0]!.id });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, stale!.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null });

    await heartbeatService(db).resumeQueuedRuns();
    expect(await newAssigneeRuns(f)).toHaveLength(1);
    expect(await handoffWakes(f)).toHaveLength(1);
  }, 60_000);

  it("creates exactly one run when the previous execution had already finished cleanly", async () => {
    const f = await seedHandoff({ oldRunStatus: "succeeded", holdLease: false });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();

    const run = await handoffWake(f);
    expect(run).not.toBeNull();
    expect(await newAssigneeRuns(f)).toHaveLength(1);
    const wakes = await handoffWakes(f);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.status).not.toBe("deferred_issue_execution");

    await heartbeatService(db).resumeQueuedRuns();
    await heartbeatService(db).resumeQueuedRuns();
    expect(await newAssigneeRuns(f)).toHaveLength(1);
    expect(await handoffWakes(f)).toHaveLength(1);
  }, 60_000);
});

import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyExecutionRunWork } from "./execution-control-notifications.js";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { claimedAdapterType, conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { persistActivity } from "./activity-log.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { logger } from "../middleware/logger.js";
import { and, asc, eq, exists, inArray, isNull, not, notExists, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type ExecutionReconciliation,
} from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { LEGACY_RECOVERY_CAUSE } from "./legacy-execution-recovery.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { readRunCancellation } from "./run-cancellation.js";
import { alias } from "drizzle-orm/pg-core";

/** An operator records observed outcomes; this is not permission to blindly retry. */
export async function validateExecutionReconciliation(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string | null;
  sourceRunId: unknown;
  decision: ExecutionReconciliation | undefined;
  /** Board-only source repair: never authorize a continuation of this run. */
  workspaceRepairOnly?: boolean;
}) {
  const { db, companyId, issueId, agentId, decision } = input;
  if (!decision || decision.runId !== input.sourceRunId || (!agentId && !input.workspaceRepairOnly)) {
    throw conflict(
      "Reconcile the recorded execution and its action outcomes before continuing this task.",
    );
  }
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.id, decision.runId),
      ),
    );
  const [task] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const review =
    task?.status === "in_review"
      ? parseIssueExecutionState(task.executionState)
      : null;
  const isCurrentReviewer =
    review?.status === "pending" &&
    review.currentParticipant?.type === "agent" &&
    review.currentParticipant.agentId === run?.agentId;
  const retainedWorkspace = hasRequiredWorkspaceRecovery(run?.resultJson);
  const repairOnly = input.workspaceRepairOnly === true && retainedWorkspace;
  const terminalRepairSource = ["failed", "interrupted", "timed_out", "cancelled"].includes(run?.status ?? "") ||
    (repairOnly && run?.runtimeMode === "legacy" && run.status === "succeeded");
  if (
    (input.workspaceRepairOnly && !retainedWorkspace) ||
    !run ||
    !task ||
    (!repairOnly && (task.assigneeAgentId !== agentId || (run.agentId !== agentId && !isCurrentReviewer))) ||
    (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== issueId ||
    !terminalRepairSource
  ) {
    throw conflict(
      "The recovery source or task owner changed. Inspect the current execution before continuing.",
    );
  }
  if (hasWorkspaceRestoreFailure(run.resultJson) &&
      (!decision.workspaceRepairEvidence || decision.workspaceRepairEvidence.trim().length < 20)) {
    throw conflict("Verify safe workspace staging or repair and record workspaceRepairEvidence before continuing this run.");
  }
  let checkLocalProcesses = true;
  if (retainedWorkspace) {
    const leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
    ));
    const recovery = run.resultJson!.workspaceRestoreRecovery as { leaseIds?: unknown };
    const retainedIds = recovery.leaseIds;
    // The terminal transaction records the exact source allocations. A release
    // timestamp is written before stop dispatch, so only matching provider
    // acknowledgements can establish that repair will not race active writes.
    if (!Array.isArray(retainedIds) || !retainedIds.length ||
        !retainedIds.every(id => typeof id === "string" && leases.some(lease =>
          lease.id === id && hasRemoteTerminationReceipt(lease))) ||
        leases.some(lease => lease.provider === "local"
          ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
          : !hasRemoteTerminationReceipt(lease))) {
      throw conflict("The retained workspace environment has not confirmed that it stopped. Wait for cleanup before recording workspace repair.");
    }
    checkLocalProcesses = leases.some(lease => lease.provider === "local");
  }
  // A retained remote source's PIDs belong to its sandbox, not this server.
  // Its exact lease receipts above replace host-local process probes.
  for (const pid of checkLocalProcesses ? [
    run.processPid,
    run.processGroupId ? -run.processGroupId : null,
  ] : []) {
    if (!pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw conflict(
        "The previous provider's process ownership cannot be verified.",
      );
    }
    throw conflict(
      "The previous provider is still running. Stop it before continuing.",
    );
  }
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, run.id),
      ),
    );
  if (coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId)
    throw conflict(
      "This execution still has a coordinator or a linked continuation. Inspect that run first.",
    );
  const leases = await db
    .select({ id: environmentLeases.id })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        isNull(environmentLeases.releasedAt),
      ),
    )
    .limit(1);
  if (leases.length)
    throw conflict(
      "The previous execution environment has not finished releasing its authority.",
    );
  if (!repairOnly) await buildExecutionContinuation({
    db,
    companyId,
    issueId,
    agentId: agentId!,
    context: { previousRunId: run.id },
    summary: null,
    exposeLowTrustRaw: false,
  });
  return run;
}

/** Durable delivery marker lives on the existing source-scoped recovery action. */
export async function markExecutionReconciliation(
  db: Db,
  action: Pick<
    typeof issueRecoveryActions.$inferSelect,
    "companyId" | "id" | "evidence" | "sourceIssueId"
  >,
  decision: ExecutionReconciliation,
  actorId: string,
  deliveryOwner?: { kind: "chat_failed_run_retry"; actionId: string },
  options?: { workspaceRepairOnly?: boolean },
) {
  if (options?.workspaceRepairOnly && (deliveryOwner || !hasRequiredWorkspaceRecovery(action.evidence))) {
    throw conflict("Workspace repair must target the retained source without a continuation owner.");
  }
  if (deliveryOwner) {
    const [retry] = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, action.companyId),
          eq(chatActions.id, deliveryOwner.actionId),
        ),
      );
    if (
      deliveryOwner.kind !== "chat_failed_run_retry" ||
      !retry ||
      retry.kind !== "failed_run_retry" ||
      !["issued", "processing", "processed"].includes(retry.status) ||
      retry.payload.version !== 1 ||
      retry.payload.failedRunId !== decision.runId ||
      retry.payload.issueId !== action.sourceIssueId
    ) {
      throw conflict("The authorized chat retry owner is no longer valid.");
    }
  }
  await db.transaction(async tx => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionReplacement);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionDisposition);
    await tx
      .update(nativeRunFinalizations)
      .set({
        failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb) || ${JSON.stringify({ replacementDenied: "operator_reconciled" })}::jsonb`,
      })
      .where(
        and(
          eq(nativeRunFinalizations.companyId, action.companyId),
          eq(nativeRunFinalizations.runId, decision.runId),
        ),
      );
    await tx
      .update(issueRecoveryActions)
      .set({
        evidence: {
          ...action.evidence,
          automaticRecovery: undefined,
          executionReconciliation: {
            ...decision,
            actorId,
            recordedAt: new Date().toISOString(),
          },
          continuationDelivery: options?.workspaceRepairOnly ? "not_requested" : deliveryOwner ? "delegated" : "pending",
          ...(deliveryOwner ? { continuationDeliveryOwner: deliveryOwner } : {}),
        },
      })
      .where(
        and(
          eq(issueRecoveryActions.companyId, action.companyId),
          eq(issueRecoveryActions.id, action.id),
        ),
      );
  });
}

export async function deliverReconciledExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
) {
  // Backfill stranded legacy controller-lease holds before delivering any
  // operator-reconciled continuation. Both are continuation work, and a
  // released hold no longer defers its task's queued wake. A release failure
  // must not stop operator-reconciled delivery from making progress.
  try {
    await releaseLegacyLeaseLostExecutions(db, wake);
  } catch (err) {
    logger.warn({ err }, "Legacy controller lease release sweep remains pending");
  }
  const pending = await db
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      ),
    )
    .limit(25);
  for (const action of pending) {
    try {
      const decision = action.evidence.executionReconciliation as
        ExecutionReconciliation | undefined;
      if (!decision || !action.returnOwnerAgentId) continue;
      const pendingDecision = and(
        eq(issueRecoveryActions.companyId, action.companyId),
        eq(issueRecoveryActions.id, action.id),
        eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
        sql`${issueRecoveryActions.evidence}->'executionReconciliation' = ${JSON.stringify(decision)}::jsonb`,
      );
      const [task] = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, action.companyId),
            eq(issues.id, action.sourceIssueId),
          ),
        );
      if (
        !task ||
        task.assigneeAgentId !== action.returnOwnerAgentId ||
        ["done", "cancelled"].includes(task.status)
      ) {
        await db
          .update(issueRecoveryActions)
          .set({
            evidence: sql`${issueRecoveryActions.evidence} || '{"continuationDelivery":"invalidated"}'::jsonb`,
          })
          .where(pendingDecision);
        continue;
      }
      const run = await wake(action.returnOwnerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        idempotencyKey: `execution-reconciliation:${action.id}`,
        payload: { issueId: task.id, recoveryActionId: action.id },
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: {
          issueId: task.id,
          taskId: task.id,
          recoveryActionId: action.id,
          previousRunId: decision.runId,
          retryOfRunId: decision.runId,
          forceFreshSession: true,
          wakeReason: "issue_recovery_action_restored",
          source: "execution.reconciled",
        },
      });
      if (run)
        await db.transaction(async (tx) => {
          await tx
            .update(heartbeatRuns)
            .set({ retryOfRunId: decision.runId })
            .where(
              and(
                eq(heartbeatRuns.companyId, action.companyId),
                eq(heartbeatRuns.id, run.id),
                eq(heartbeatRuns.agentId, action.returnOwnerAgentId!),
                sql`${heartbeatRuns.contextSnapshot}->>'recoveryActionId' = ${action.id}`,
                sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${decision.runId}`,
              ),
            );
          await tx
            .update(issueRecoveryActions)
            .set({
              evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
                {
                  continuationDelivery: "delivered",
                  continuationRunId: run.id,
                },
              )}::jsonb`,
            })
            .where(pendingDecision);
        });
    } catch {
      logger.warn(
        { recoveryActionId: action.id },
        "Reconciled execution continuation remains pending for retry",
      );
    }
  }
}

const legacyReleaseBlocker = alias(issues, "legacy_release_blocker");
const legacyReleaseLiveRun = alias(heartbeatRuns, "legacy_release_live_run");

/**
 * A resolved `legacy_execution_requires_reconciliation` hold can outlive the
 * board-side incident that created it. When the source run was cancelled by a
 * controller lease loss (`cancellation.source === "controller_lease"`) and the
 * adapter has no recovery path, the no-replay flag is bookkeeping rather than
 * evidence that an external action is uncertain. Once every blocker is closed,
 * the hold must be released as a NEW source execution: the cancelled run is
 * never retried and its recorded tool calls are never replayed.
 */
export function legacyLeaseLostExecutionHolds(db: Db, limit: number) {
  return db
    .select({ action: issueRecoveryActions, task: issues, run: heartbeatRuns })
    .from(issueRecoveryActions)
    .innerJoin(issues, and(
      eq(issues.companyId, issueRecoveryActions.companyId),
      eq(issues.id, issueRecoveryActions.sourceIssueId),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
      eq(heartbeatRuns.id, canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'runId'`)),
    ))
    .where(and(
      eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
      eq(issueRecoveryActions.kind, "active_run_watchdog"),
      eq(issueRecoveryActions.status, "resolved"),
      or(
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        sql`${issueRecoveryActions.evidence}->'legacyLeaseRelease'->>'delivery' = 'pending'`,
      ),
      sql`coalesce(${issueRecoveryActions.evidence}->'legacyLeaseRelease'->>'delivery', '') <> 'delivered'`,
      sql`${issueRecoveryActions.evidence}->>'adapterRecovery' = 'unsupported_or_unknown'`,
      eq(heartbeatRuns.status, "cancelled"),
      sql`${heartbeatRuns.resultJson}->'cancellation'->>'source' = 'controller_lease'`,
      inArray(issues.status, ["todo", "in_progress", "blocked"]),
      sql`${issues.assigneeAgentId} is not null`,
      eq(issues.assigneeAgentId, issueRecoveryActions.returnOwnerAgentId),
      isNull(issues.executionRunId),
      isNull(issues.checkoutRunId),
      notExists(
        db.select({ id: issueRelations.id })
          .from(issueRelations)
          .innerJoin(legacyReleaseBlocker, eq(issueRelations.issueId, legacyReleaseBlocker.id))
          .where(and(
            eq(issueRelations.companyId, issueRecoveryActions.companyId),
            eq(issueRelations.relatedIssueId, issueRecoveryActions.sourceIssueId),
            eq(issueRelations.type, "blocks"),
            sql`${legacyReleaseBlocker.status} not in ('done', 'cancelled')`,
          )),
      ),
      notExists(
        db.select({ id: legacyReleaseLiveRun.id })
          .from(legacyReleaseLiveRun)
          .where(and(
            eq(legacyReleaseLiveRun.companyId, issueRecoveryActions.companyId),
            or(
              eq(legacyReleaseLiveRun.nativeIssueId, issueRecoveryActions.sourceIssueId),
              sql`${legacyReleaseLiveRun.contextSnapshot}->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text`,
            ),
            inArray(legacyReleaseLiveRun.status, ["queued", "running", "scheduled_retry"]),
          )),
      ),
    ))
    .orderBy(asc(issueRecoveryActions.updatedAt))
    .limit(limit);
}

async function legacyReleaseBlockersClosed(db: Db, companyId: string, issueId: string) {
  const blockers = await db
    .select({ status: legacyReleaseBlocker.status })
    .from(issueRelations)
    .innerJoin(legacyReleaseBlocker, eq(issueRelations.issueId, legacyReleaseBlocker.id))
    .where(and(
      eq(issueRelations.companyId, companyId),
      eq(issueRelations.relatedIssueId, issueId),
      eq(issueRelations.type, "blocks"),
    ));
  return blockers.every((blocker) => blocker.status === "done" || blocker.status === "cancelled");
}

/**
 * Backfill/recovery sweep for issues stranded by NEXA-862's class of hold.
 * Idempotent by construction: a release is recorded on the recovery action and
 * a dispatched run (or an already-admitted successor) is stamped, so repeated
 * sweeps neither release the hold again nor queue a second run.
 */
export async function releaseLegacyLeaseLostExecutions(
  db: Db,
  wake: ReturnType<typeof import("./heartbeat.js").heartbeatService>["wakeup"],
  now = new Date(),
) {
  const candidates = await legacyLeaseLostExecutionHolds(db, 25);
  const dispatched = new Set<string>();
  let released = 0;
  let dispatchedCount = 0;
  for (const { action: candidate, task } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    const releaseKey = `${candidate.sourceIssueId}:${runId}`;
    try {
      const prepared = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> run -> action ordering as disposition settlement.
        const [lockedTask] = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.sourceIssueId)))
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, runId)))
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !lockedTask ||
          !run ||
          !action ||
          action.status !== "resolved" ||
          action.cause !== LEGACY_RECOVERY_CAUSE ||
          action.kind !== "active_run_watchdog"
        )
          return null;
        const evidence = action.evidence;
        const automaticRecovery = (evidence.automaticRecovery ?? {}) as Record<string, unknown>;
        const priorRelease = (evidence.legacyLeaseRelease ?? {}) as Record<string, unknown>;
        if (priorRelease.delivery === "delivered") return null;
        if (automaticRecovery.replay !== "blocked" && priorRelease.delivery !== "pending") return null;
        if (evidence.adapterRecovery !== "unsupported_or_unknown") return null;
        // Only a board-side lease loss is recoverable here. A genuine external
        // action hold (`uncertain_external_action`, provider_*) stays gated.
        if (run.status !== "cancelled" || readRunCancellation(run.resultJson)?.source !== "controller_lease")
          return null;
        if ((run.nativeIssueId ?? run.contextSnapshot?.issueId) !== lockedTask.id) return null;
        if (!["todo", "in_progress", "blocked"].includes(lockedTask.status)) return null;
        if (!lockedTask.assigneeAgentId || lockedTask.assigneeAgentId !== action.returnOwnerAgentId) return null;
        if (lockedTask.executionRunId || lockedTask.checkoutRunId) return null;
        if (!(await legacyReleaseBlockersClosed(tx as unknown as Db, lockedTask.companyId, lockedTask.id)))
          return null;
        // A successor may already be queued by a concurrent sweep or a prior
        // pass whose delivery marker did not commit. Adopt it instead of
        // releasing the same incident twice.
        const [liveRun] = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, lockedTask.companyId),
            or(
              eq(heartbeatRuns.nativeIssueId, lockedTask.id),
              sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${lockedTask.id}::text`,
            ),
            inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          ))
          .limit(1);
        const priorWake = liveRun ? null : (await tx
          .select({ runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, lockedTask.companyId),
            eq(agentWakeupRequests.idempotencyKey, `legacy-lease-release:${run.id}`),
            sql`${agentWakeupRequests.runId} is not null`,
          ))
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1))[0] ?? null;
        const release = {
          delivery: "pending",
          previousReplay: "blocked",
          sourceRunId: run.id,
          releasedAt: typeof priorRelease.releasedAt === "string" ? priorRelease.releasedAt : now.toISOString(),
        };
        const note =
          "A board-side controller lease loss is not evidence of an uncertain external action. " +
          "Every blocker is closed, so this hold is released as a new source execution. " +
          "The cancelled run and its recorded tool calls are not replayed.";
        // Release every bookkeeping row for this exact source run together.
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: "restored",
            resolutionNote: "new_source_execution_path",
            nextAction: note,
            wakePolicy: null,
            monitorPolicy: null,
            resolvedAt: action.resolvedAt ?? now,
            updatedAt: now,
            evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"allowed"'::jsonb, false)
              || jsonb_build_object('legacyLeaseRelease',
                coalesce(${issueRecoveryActions.evidence}->'legacyLeaseRelease', '{}'::jsonb) || ${JSON.stringify(release)}::jsonb)`,
          })
          .where(and(
            eq(issueRecoveryActions.companyId, candidate.companyId),
            eq(issueRecoveryActions.sourceIssueId, lockedTask.id),
            eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
            eq(issueRecoveryActions.status, "resolved"),
            sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
            sql`coalesce(${issueRecoveryActions.evidence}->'legacyLeaseRelease'->>'delivery', '') <> 'delivered'`,
          ));
        // Another, unrelated hold may still guard the issue. Release this
        // incident's bookkeeping but never dispatch past a live hold, and do
        // not rescan it on every sweep while that other hold owns admission.
        const remaining = await getExecutionBlocker(tx as unknown as Db, lockedTask.companyId, lockedTask.id);
        if (remaining !== null) {
          await tx
            .update(issueRecoveryActions)
            .set({
              updatedAt: now,
              evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{legacyLeaseRelease,delivery}', '"blocked_by_other_hold"'::jsonb, false)`,
            })
            .where(and(
              eq(issueRecoveryActions.companyId, candidate.companyId),
              eq(issueRecoveryActions.sourceIssueId, lockedTask.id),
              eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
              sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
              sql`${issueRecoveryActions.evidence}->'legacyLeaseRelease'->>'delivery' = 'pending'`,
            ));
        }
        return { task: lockedTask, run, clear: remaining === null,
          existingRunId: liveRun?.id ?? priorWake?.runId ?? null };
      });
      if (!prepared) continue;
      released += 1;
      if (!prepared.clear) continue;
      const markDelivered = async (continuationRunId: string) => {
        await db
          .update(issueRecoveryActions)
          .set({
            updatedAt: now,
            evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{legacyLeaseRelease,delivery}', '"delivered"'::jsonb, false)
              || jsonb_build_object('legacyLeaseReleaseRunId', ${continuationRunId}::text)`,
          })
          .where(and(
            eq(issueRecoveryActions.companyId, prepared.task.companyId),
            eq(issueRecoveryActions.sourceIssueId, prepared.task.id),
            eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
            sql`${issueRecoveryActions.evidence}->>'runId' = ${prepared.run.id}`,
            sql`${issueRecoveryActions.evidence}->'legacyLeaseRelease'->>'delivery' = 'pending'`,
          ));
      };
      if (prepared.existingRunId) {
        await markDelivered(prepared.existingRunId);
        continue;
      }
      if (dispatched.has(releaseKey)) continue;
      dispatched.add(releaseKey);
      const run = await wake(prepared.task.assigneeAgentId!, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_legacy_execution_released",
        idempotencyKey: `legacy-lease-release:${prepared.run.id}`,
        payload: { issueId: prepared.task.id, recoveryActionId: candidate.id },
        requestedByActorType: "system",
        requestedByActorId: "execution-recovery",
        contextSnapshot: {
          issueId: prepared.task.id,
          taskId: prepared.task.id,
          wakeReason: "issue_legacy_execution_released",
          source: "execution.legacy_release",
          forceFreshSession: true,
          releasedRecoveryActionId: candidate.id,
          releasedFromRunId: prepared.run.id,
        },
      });
      if (!run) continue;
      dispatchedCount += 1;
      await markDelivered(run.id);
      await persistActivity(db, {
        companyId: prepared.task.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_released",
        entityType: "issue",
        entityId: prepared.task.id,
        agentId: prepared.task.assigneeAgentId,
        runId: prepared.run.id,
        details: {
          recoveryActionId: candidate.id,
          sourceRunId: prepared.run.id,
          successorRunId: run.id,
          reason: "legacy_controller_lease_loss",
          replay: "new_source_execution",
        },
      });
    } catch (err) {
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Legacy controller lease release remains pending",
      );
    }
  }
  return { released, dispatched: dispatchedCount };
}

const supersedingWorkspaceHold = alias(issueRecoveryActions, "superseding_workspace_hold");

function supersedingNativeWorkspaceHold(db: Db, input: {
  companyId: string | typeof heartbeatRuns.companyId;
  issueId: string | typeof issueRecoveryActions.sourceIssueId;
  runId: string | typeof heartbeatRuns.id;
}) {
  return db.select({ id: supersedingWorkspaceHold.id }).from(supersedingWorkspaceHold).where(and(
    eq(supersedingWorkspaceHold.companyId, input.companyId),
    eq(supersedingWorkspaceHold.sourceIssueId, input.issueId),
    eq(supersedingWorkspaceHold.status, "resolved"),
    eq(supersedingWorkspaceHold.cause, "native_continuation_requires_reconciliation"),
    sql`${supersedingWorkspaceHold.evidence}->>'runId' = ${input.runId}::text`,
    sql`${supersedingWorkspaceHold.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    sql`${supersedingWorkspaceHold.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'`,
  ));
}

export function unresolvedExecutionDispositions(db: Db, limit: number) {
  return db
    .select({ action: issueRecoveryActions })
    .from(issueRecoveryActions)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        eq(heartbeatRuns.id, canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'runId'`)),
        or(
          eq(heartbeatRuns.nativeIssueId, issueRecoveryActions.sourceIssueId),
          and(isNull(heartbeatRuns.nativeIssueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text`),
        ),
      ),
    )
    .leftJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      ),
    )
    .where(
      and(
        not(conversationRecoveryActionPredicate()!),
        sql`not (${issueRecoveryActions.evidence} ? 'systemRecovery')`,
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        eq(issueRecoveryActions.kind, "active_run_watchdog"),
        or(inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]), and(
          eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.nativePhase, "terminal_failure"),
          eq(nativeRunFinalizations.phase, "terminal_failure"), isNull(nativeRunFinalizations.nextAttemptAt),
          sql`${issueRecoveryActions.wakePolicy}->>'kind' = 'resume_native_run'`,
          sql`${issueRecoveryActions.wakePolicy}->>'runId' = ${heartbeatRuns.id}::text`,
          exists(supersedingNativeWorkspaceHold(db, { companyId: heartbeatRuns.companyId,
            issueId: issueRecoveryActions.sourceIssueId, runId: heartbeatRuns.id })),
        )),
        inArray(heartbeatRuns.status, [
          "failed",
          "timed_out",
          "interrupted",
          "cancelled",
        ]),
        isNull(nativeRunFinalizations.leaseOwner),
        isNull(nativeRunFinalizations.resultId),
        or(
          isNull(nativeRunFinalizations.runId),
          eq(nativeRunFinalizations.phase, "terminal_failure"),
        ),
        sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
        sql`(${heartbeatRuns.runtimeMode} <> 'native' or coalesce(${nativeRunFinalizations.failureCode}, '') <> 'native_provider_terminal_failed'
        or coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') <> '')`,
      ),
    )
    .limit(limit);
}

export function obsoleteExecutionConversationHold() {
  return and(
    conversationRecoveryActionPredicate(),
    sql`not (${issueRecoveryActions.evidence} ? 'systemRecovery')`,
    or(
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
    ),
  );
}

/**
 * Failed execution is a system responsibility, not a user questionnaire. After
 * automatic recovery is ruled out, preserve evidence and stop without replay.
 * This is NOT evidence that an external action succeeded or never happened.
 * The resolved record retains a dispatch hold until actual evidence clears it.
 */
export async function settleUnrecoverableExecutions(
  db: Db,
  now = new Date(),
  options: { failpoint?: (phase: "persisted") => void } = {},
) {
  // Fold obsolete conversation holds without waking historical work on upgrade.
  // Keep their evidence and record the policy change in the task's activity log.
  const obsoleteConversationHold = obsoleteExecutionConversationHold();
  await db.transaction(async tx => {
    const foldable = await tx.select().from(issueRecoveryActions).where(obsoleteConversationHold)
      .limit(25).for("update", { skipLocked: true });
    for (const candidate of foldable) {
      if (await getConversationOwnershipBlocker(tx as unknown as Db, candidate.companyId, candidate.sourceIssueId)) continue;
      const [action] = await tx.update(issueRecoveryActions).set({
        status: "resolved",
        outcome: "cancelled",
        resolvedAt: now,
        updatedAt: now,
        nextAction: "Automatic attempts stopped. Send a new message to continue the conversation.",
        resolutionNote: "Conversation continuation does not replay prior tool calls.",
        wakePolicy: null,
        monitorPolicy: null,
        evidence: sql`case when ${issueRecoveryActions.evidence} ? 'automaticRecovery'
          then jsonb_set(${issueRecoveryActions.evidence}, '{automaticRecovery,replay}', '"conversation_continuation"'::jsonb)
          else ${issueRecoveryActions.evidence} end`,
      }).where(and(obsoleteConversationHold, eq(issueRecoveryActions.id, candidate.id))).returning();
      if (!action) continue;
      await persistActivity(tx as unknown as Db, {
        companyId: action.companyId,
        actorType: "system",
        actorId: "execution-recovery",
        action: "issue.execution_recovery_settled",
        entityType: "issue",
        entityId: action.sourceIssueId,
        details: { recoveryActionId: action.id, outcome: "cancelled", continuation: "conversation" },
      });
    }
  });
  // Filter eligibility before applying the batch limit. A queue of sessions
  // awaiting replacement must not starve settled incidents behind it.
  const candidates = await unresolvedExecutionDispositions(db, 25);
  for (const { action: candidate } of candidates) {
    const runId = candidate.evidence.runId;
    if (typeof runId !== "string") continue;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        // Same issue -> coordinator -> run ordering as replacement/finalization.
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, candidate.companyId),
              eq(issues.id, candidate.sourceIssueId),
            ),
          )
          .for("update");
        const [coordinator] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.companyId, candidate.companyId),
              eq(nativeRunFinalizations.runId, runId),
            ),
          )
          .for("update");
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, candidate.companyId),
              eq(heartbeatRuns.id, runId),
            ),
          )
          .for("update");
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, candidate.id))
          .for("update");
        if (
          !task ||
          !run ||
          !action ||
          action.evidence.runId !== runId ||
          !["active", "escalated"].includes(action.status) ||
          (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== task.id ||
          !["failed", "timed_out", "interrupted", "cancelled"].includes(
            run.status,
          )
        )
          return;
        if (!EXECUTION_RECONCILIATION_CAUSES.includes(action.cause as (typeof EXECUTION_RECONCILIATION_CAUSES)[number])) {
          if (run.runtimeMode !== "native" || run.nativePhase !== "terminal_failure"
            || coordinator?.phase !== "terminal_failure" || coordinator.leaseOwner || coordinator.resultId
            || coordinator.nextAttemptAt || coordinator.failureDetail?.successorRunId
            || action.wakePolicy?.kind !== "resume_native_run" || action.wakePolicy.runId !== run.id) return;
          const [hold] = await supersedingNativeWorkspaceHold(tx as unknown as Db, {
            companyId: run.companyId, issueId: task.id, runId: run.id,
          }).limit(1).for("update");
          if (!hold) return;
          await notifyExecutionRunWork(tx);
          const note = "Exact session recovery stopped. The recorded workspace recovery holds this execution without replaying its actions.";
          await tx.update(issueRecoveryActions).set({ status: "cancelled", outcome: "cancelled",
            resolvedAt: now, updatedAt: now, wakePolicy: null, monitorPolicy: null,
            nextAction: note, resolutionNote: note,
            evidence: { ...action.evidence, supersedingRecoveryActionId: hold.id },
          }).where(eq(issueRecoveryActions.id, action.id));
          await persistActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system",
            actorId: "execution-recovery", action: "issue.execution_recovery_settled", entityType: "issue",
            entityId: task.id, runId: run.id,
            details: { recoveryActionId: action.id, outcome: "cancelled", supersedingRecoveryActionId: hold.id },
          });
          return;
        }
        // Adoption transfers maintenance to the retained-workspace owner.
        // This compatibility resolver must not close its hold or relabel it
        // as a user repair merely because old return-owner metadata is absent.
        if (readSystemRecovery(action.evidence)) return;
        // Give durable native recovery its chance; never preempt a resume,
        // replacement, result finalizer, or still-owned execution.
        if (
          coordinator?.leaseOwner ||
          coordinator?.resultId ||
          coordinator?.failureDetail?.successorRunId ||
          (coordinator && coordinator.phase !== "terminal_failure") ||
          (run.runtimeMode === "native" &&
            coordinator?.failureCode === "native_provider_terminal_failed" &&
            !coordinator.failureDetail?.replacementDenied)
        )
          return;
        const current =
          !isSupersededConversationRun(task, run) &&
          action.returnOwnerAgentId !== null &&
          task.assigneeAgentId === action.returnOwnerAgentId &&
          !["done", "cancelled"].includes(task.status) &&
          (!task.executionRunId || task.executionRunId === run.id) &&
          (!task.checkoutRunId || task.checkoutRunId === run.id);
        const note = current
          ? hasWorkspaceRestoreFailure(run.resultJson)
            ? "Workspace repair required. Verify safe staging or repair before continuing. Saved work and approval decisions remain in force."
            : "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
          : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.";
        let nativeFailureBlock = action.evidence.nativeFailureBlock;
        let nativeBootstrapFailureBlock = action.evidence.nativeBootstrapFailureBlock;
        if (current) {
          const [projected] = await tx
            .update(issues)
            .set({
              status: "blocked",
              executionRunId: null,
              checkoutRunId: null,
              updatedAt: now,
            })
            .where(eq(issues.id, task.id)).returning();
          // Only a transition owned by this failure grants a recovery receipt.
          // An already-blocked task may have a separate human/dependency hold.
          if (task.status !== "blocked" && run.runtimeMode === "native") {
            nativeFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion };
          }
          if (task.status !== "blocked" && run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
              run.errorCode === "server_shutdown_interrupted" && claimedAdapterType(run) === "paperclip_runner") {
            nativeBootstrapFailureBlock = { runId: run.id, statusVersion: projected!.statusVersion, previousStatus: task.status };
          }
        }
        await tx
          .update(issueRecoveryActions)
          .set({
            status: "resolved",
            outcome: current ? "blocked" : "cancelled",
            resolvedAt: now,
            updatedAt: now,
            nextAction: note,
            resolutionNote: note,
            wakePolicy: null,
            monitorPolicy: null,
            evidence: {
              ...action.evidence,
              ...(nativeFailureBlock ? { nativeFailureBlock } : {}),
              ...(nativeBootstrapFailureBlock ? { nativeBootstrapFailureBlock } : {}),
              automaticRecovery: {
                policy: "preserve_without_replay_v1",
                runId: run.id,
                replay: "blocked",
                actionOutcome: "unknown",
                recordedAt: now.toISOString(),
              },
            },
          })
          .where(eq(issueRecoveryActions.id, action.id));
        await persistActivity(tx as unknown as Db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "execution-recovery",
          action: "issue.execution_recovery_settled",
          entityType: "issue",
          entityId: task.id,
          runId: run.id,
          details: {
            recoveryActionId: action.id,
            outcome: current ? "blocked" : "cancelled",
            replay: "not_authorized",
          },
        });
        await notifyExecutionRunWork(tx);
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: note,
          payload: {
            recoveryActionId: action.id,
            cause: action.cause,
            automaticRecovery: "preserve_without_replay_v1",
            replay: "blocked",
          },
        });
        options.failpoint?.("persisted");
      });
    } catch (err) {
      if (options.failpoint) throw err;
      logger.warn(
        { err, recoveryActionId: candidate.id },
        "Automatic recovery disposition remains pending",
      );
    }
  }
}

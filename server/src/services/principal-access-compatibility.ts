import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import { grantsForHumanRole, normalizeHumanRole } from "./company-member-roles.js";

type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export type PrincipalAccessCompatibilityBackfillStats = {
  agentMembershipsInserted: number;
  humanGrantsInserted: number;
};

export async function insertMissingPrincipalGrants(
  db: Db,
  input: {
    companyId: string;
    principalType: PrincipalType;
    principalId: string;
    grants: GrantInput[];
    grantedByUserId: string | null;
  },
): Promise<number> {
  if (input.grants.length === 0) return 0;

  const now = new Date();
  const inserted = await db
    .insert(principalPermissionGrants)
    .values(
      input.grants.map((grant) => ({
        companyId: input.companyId,
        principalType: input.principalType,
        principalId: input.principalId,
        permissionKey: grant.permissionKey,
        scope: grant.scope ?? null,
        grantedByUserId: input.grantedByUserId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing({
      target: [
        principalPermissionGrants.companyId,
        principalPermissionGrants.principalType,
        principalPermissionGrants.principalId,
        principalPermissionGrants.permissionKey,
      ],
    })
    .returning({ id: principalPermissionGrants.id });

  return inserted.length;
}

/**
 * Seed the defaults a membership role implies.
 *
 * Role defaults are always recorded with no granting human. That is what makes
 * `granted_by_user_id IS NULL` a usable provenance signal: it separates a row the
 * role produced from a permission somebody granted on purpose, and
 * `pruneSupersededRoleDefaultGrants` depends on the two being distinguishable.
 *
 * This parameter is deliberately absent rather than merely ignored. Accepting a
 * granting human here is what let board-claim, company-create and company-clone
 * owners seed owner defaults stamped with their own id, which made those rows
 * indistinguishable from explicit grants and let a later demotion keep
 * `users:manage_permissions`. Removing it makes that mistake a compile error
 * instead of a silent escalation path.
 */
export async function ensureHumanRoleDefaultGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    membershipRole: string | null | undefined;
  },
): Promise<number> {
  const role = normalizeHumanRole(input.membershipRole, "operator");
  return insertMissingPrincipalGrants(db, {
    companyId: input.companyId,
    principalType: "user",
    principalId: input.principalId,
    grants: grantsForHumanRole(role),
    grantedByUserId: null,
  });
}

/**
 * A role change must revoke what the previous role implied, not only confer what
 * the new one does. Role defaults are materialized as ordinary grant rows, so
 * seeding the new role without withdrawing the old one leaves the demoted member
 * holding them -- `users:manage_permissions` among them, which is a
 * self-escalation primitive: the demoted member can re-grant themselves exactly
 * what the demotion removed.
 *
 * Only rows with no granting human are removed. Role defaults are seeded without
 * one, so `granted_by_user_id IS NULL` is the provenance signal available in the
 * current schema; a permission a human granted deliberately carries that human's
 * id and survives the demotion.
 *
 * The residual: rows seeded as role defaults by a caller that recorded a granting
 * human, and rows whose provenance predates that convention, are not recognized as
 * role-derived and survive. Closing that needs a provenance column on the table.
 */
export async function pruneSupersededRoleDefaultGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    previousMembershipRole: string | null | undefined;
    nextMembershipRole: string | null | undefined;
  },
): Promise<number> {
  const nextKeys = new Set(
    grantsForHumanRole(normalizeHumanRole(input.nextMembershipRole, "operator")).map(
      (grant) => grant.permissionKey,
    ),
  );
  const supersededKeys = grantsForHumanRole(
    normalizeHumanRole(input.previousMembershipRole, "operator"),
  )
    .map((grant) => grant.permissionKey)
    .filter((permissionKey) => !nextKeys.has(permissionKey));

  if (supersededKeys.length === 0) return 0;

  const removed = await db
    .delete(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, input.companyId),
        eq(principalPermissionGrants.principalType, "user"),
        eq(principalPermissionGrants.principalId, input.principalId),
        isNull(principalPermissionGrants.grantedByUserId),
        inArray(principalPermissionGrants.permissionKey, supersededKeys),
      ),
    )
    .returning({ id: principalPermissionGrants.id });

  return removed.length;
}

export async function backfillPrincipalAccessCompatibility(
  db: Db,
): Promise<PrincipalAccessCompatibilityBackfillStats> {
  const now = new Date();
  const nonTerminalAgents = await db
    .select({
      companyId: agents.companyId,
      principalId: agents.id,
    })
    .from(agents)
    .where(notInArray(agents.status, ["pending_approval", "terminated"]));

  const agentMembershipsInserted = nonTerminalAgents.length > 0
    ? await db
      .insert(companyMemberships)
      .values(
        nonTerminalAgents.map((agent) => ({
          companyId: agent.companyId,
          principalType: "agent",
          principalId: agent.principalId,
          status: "active",
          membershipRole: "member",
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          companyMemberships.companyId,
          companyMemberships.principalType,
          companyMemberships.principalId,
        ],
      })
      .returning({ id: companyMemberships.id })
      .then((rows) => rows.length)
    : 0;

  const activeHumanMemberships = await db
    .select({
      companyId: companyMemberships.companyId,
      principalId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );

  let humanGrantsInserted = 0;
  for (const membership of activeHumanMemberships) {
    humanGrantsInserted += await ensureHumanRoleDefaultGrants(db, {
      companyId: membership.companyId,
      principalId: membership.principalId,
      membershipRole: membership.membershipRole,
    });
  }

  return {
    agentMembershipsInserted,
    humanGrantsInserted,
  };
}

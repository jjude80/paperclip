import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships, principalPermissionGrants } from "@paperclipai/db";
import type { PermissionKey, PrincipalType } from "@paperclipai/shared";
import { grantsForHumanRole, normalizeHumanRole } from "./company-member-roles.js";

/**
 * Roles enumerated for provenance analysis. A null membership role normalizes to
 * "operator" elsewhere; enumerating it explicitly keeps the backfill report from
 * depending on that fallback.
 */
const HUMAN_MEMBERSHIP_ROLES_FOR_PROVENANCE = ["owner", "admin", "operator", "viewer"] as const;

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
    /**
     * The membership role that implied these grants, or null when they were
     * granted deliberately. Required rather than optional so no caller can leave
     * provenance unset by omission.
     */
    grantedViaRole: string | null;
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
        grantedViaRole: input.grantedViaRole,
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
 * Seed the defaults a membership role implies, tagged with that role.
 *
 * `grantedViaRole` is what makes a role default distinguishable from a
 * deliberate grant. `grantedByUserId` cannot: three paths seeded owner defaults
 * while stamping the owner's own id (board-claim, company-create,
 * company-clone), so those rows were indistinguishable from explicit grants and
 * a demotion kept `users:manage_permissions` for exactly the principals most
 * likely to hold it.
 *
 * No granting human is accepted here, and the role is passed separately rather
 * than inferred. Reintroducing either mistake is now a type error.
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
    grantedViaRole: role,
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
 * Only rows whose `grantedViaRole` names the previous role are removed. That
 * marker is written at insert time by every path that materializes a role
 * default, so the predicate is a fact rather than an inference:
 *
 * - a deliberate grant carries a null marker and survives the demotion;
 * - a row seeded by the previous role names that role and is withdrawn.
 *
 * The earlier `granted_by_user_id IS NULL` predicate was an inference and was
 * wrong in both directions. It missed role defaults seeded with a grantor, and
 * it would have withdrawn deliberate grants recorded with a null grantor.
 *
 * Rows written before the column existed carry a null marker and are therefore
 * treated as deliberate, which preserves them. That is the same posture the old
 * code took for the common case, and it is why the backfill policy for those
 * rows is a decision rather than a mechanical detail -- see
 * `countUndecidableRoleDefaultGrants`.
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
  const previousRole = normalizeHumanRole(input.previousMembershipRole, "operator");
  const nextKeys = new Set(
    grantsForHumanRole(normalizeHumanRole(input.nextMembershipRole, "operator")).map(
      (grant) => grant.permissionKey,
    ),
  );
  const supersededKeys = grantsForHumanRole(previousRole)
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
        eq(principalPermissionGrants.grantedViaRole, previousRole),
        inArray(principalPermissionGrants.permissionKey, supersededKeys),
      ),
    )
    .returning({ id: principalPermissionGrants.id });

  return removed.length;
}

export type UndecidableRoleDefaultGrant = {
  companyId: string;
  principalId: string;
  membershipRole: string | null;
  permissionKey: string;
  grantedByUserId: string | null;
};

/**
 * Rows whose provenance the schema cannot recover.
 *
 * A row written before `granted_via_role` existed, whose `permission_key` is a
 * default of the principal's current role, satisfies both readings at once: the
 * role may have seeded it, or somebody may have granted it deliberately. No
 * query resolves it, so the only honest options are to pick a policy for the
 * whole class or to leave the rows alone and preserve them.
 *
 * This returns the class so the policy can be chosen against a real count and a
 * real list rather than an assumption about how many rows are affected.
 *
 * Rows whose permission key is *not* a role default are not ambiguous: nothing
 * seeded them, so they are deliberate and are excluded.
 */
export async function countUndecidableRoleDefaultGrants(
  db: Db,
): Promise<{ total: number; rows: UndecidableRoleDefaultGrant[] }> {
  const rows = await db
    .select({
      companyId: principalPermissionGrants.companyId,
      principalId: principalPermissionGrants.principalId,
      permissionKey: principalPermissionGrants.permissionKey,
      grantedByUserId: principalPermissionGrants.grantedByUserId,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(principalPermissionGrants)
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, principalPermissionGrants.companyId),
        eq(companyMemberships.principalType, principalPermissionGrants.principalType),
        eq(companyMemberships.principalId, principalPermissionGrants.principalId),
      ),
    )
    .where(
      and(
        eq(principalPermissionGrants.principalType, "user"),
        isNull(principalPermissionGrants.grantedViaRole),
      ),
    );

  const roleDefaultKeysByRole = new Map<string, Set<string>>(
    HUMAN_MEMBERSHIP_ROLES_FOR_PROVENANCE.map((role) => [
      role,
      new Set(grantsForHumanRole(role).map((grant) => grant.permissionKey)),
    ]),
  );

  const undecidable = rows.filter((row) => {
    const keys = roleDefaultKeysByRole.get(
      normalizeHumanRole(row.membershipRole, "operator"),
    );
    return keys?.has(row.permissionKey) ?? false;
  });

  return { total: undecidable.length, rows: undecidable };
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

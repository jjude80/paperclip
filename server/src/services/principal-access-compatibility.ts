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

/**
 * These helpers only read and write rows; they never open or commit a transaction of
 * their own. Widening the parameter to just the statement builders lets a
 * `db.transaction()` handle be passed without a cast, so a call site inside a
 * transaction cannot silently be handed a non-transactional client.
 */
type GrantStore = Pick<Db, "insert" | "select" | "delete">;

export async function insertMissingPrincipalGrants(
  db: GrantStore,
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

export async function ensureHumanRoleDefaultGrants(
  db: Db,
  input: {
    companyId: string;
    principalId: string;
    membershipRole: string | null | undefined;
    grantedByUserId: string | null;
  },
): Promise<number> {
  const role = normalizeHumanRole(input.membershipRole, "operator");
  return insertMissingPrincipalGrants(db, {
    companyId: input.companyId,
    principalType: "user",
    principalId: input.principalId,
    grants: grantsForHumanRole(role),
    grantedByUserId: input.grantedByUserId,
  });
}

/**
 * Role-derived grants are materialized as ordinary grant rows, so a demotion has to
 * withdraw the ones the previous role contributed. Only rows with no granting human
 * are considered role-derived: a grant a human made explicitly carries that human's
 * id and survives a demotion.
 */
export async function pruneSupersededRoleDefaultGrants(
  db: GrantStore,
  input: {
    companyId: string;
    principalId: string;
    previousRole: string | null | undefined;
    nextRole: string | null | undefined;
  },
): Promise<number> {
  const previousKeys = new Set(
    grantsForHumanRole(normalizeHumanRole(input.previousRole, "operator")).map(
      (grant) => grant.permissionKey,
    ),
  );
  if (previousKeys.size === 0) return 0;

  const nextKeys = new Set(
    grantsForHumanRole(normalizeHumanRole(input.nextRole, "operator")).map(
      (grant) => grant.permissionKey,
    ),
  );
  const revokedKeys = [...previousKeys].filter((key) => !nextKeys.has(key));
  if (revokedKeys.length === 0) return 0;

  return db
    .delete(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, input.companyId),
        eq(principalPermissionGrants.principalType, "user"),
        eq(principalPermissionGrants.principalId, input.principalId),
        isNull(principalPermissionGrants.grantedByUserId),
        inArray(principalPermissionGrants.permissionKey, revokedKeys),
      ),
    )
    .returning({ id: principalPermissionGrants.id })
    .then((rows) => rows.length);
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
      grantedByUserId: null,
    });
  }

  return {
    agentMembershipsInserted,
    humanGrantsInserted,
  };
}

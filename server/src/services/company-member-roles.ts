import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";

const HUMAN_COMPANY_MEMBERSHIP_ROLES: HumanCompanyMembershipRole[] = [
  "owner",
  "admin",
  "operator",
  "viewer",
];

export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "operator"
): HumanCompanyMembershipRole {
  if (value === "member") return "operator";
  return HUMAN_COMPANY_MEMBERSHIP_ROLES.includes(value as HumanCompanyMembershipRole)
    ? (value as HumanCompanyMembershipRole)
    : fallback;
}

export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "owner":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
      ];
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
      ];
    case "operator":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "agents:configure", scope: null },
        { permissionKey: "skills:create", scope: null },
        { permissionKey: "environments:manage", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "pipelines:write", scope: null },
        { permissionKey: "tools:manage_connections", scope: null },
        { permissionKey: "tools:manage_profiles", scope: null },
        { permissionKey: "tools:manage_runtime", scope: null },
        { permissionKey: "tools:use", scope: null },
        { permissionKey: "tools:admin", scope: null },
        { permissionKey: "tools:view_audit", scope: null },
        { permissionKey: "audit:view_agent_actions", scope: null },
      ];
    case "viewer":
      return [];
  }
}

type RoleGrant = {
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope?: Record<string, unknown> | null;
};

export type RoleDefaultMerge<T extends RoleGrant> = {
  /** Every grant to persist, role defaults included. */
  grants: T[];
  /**
   * Permission keys this function appended because the role implies them, as
   * opposed to keys the caller supplied.
   *
   * The caller needs the distinction to record provenance. A permission the
   * caller supplied was granted deliberately and must survive a later demotion;
   * one appended here exists only because of the role and must be withdrawn when
   * the role no longer implies it.
   */
  roleDefaultKeys: Set<string>;
};

/**
 * Role-derived permissions are materialized as ordinary grant rows, so any writer
 * that replaces a principal's grants must re-apply the role defaults or it will
 * silently strip the permissions the membership role implies. Callers may only
 * add to the role defaults, never remove them.
 *
 * Agent principals have no role defaults: their grants are set explicitly.
 *
 * A key present in both `grants` and the role defaults counts as supplied, not
 * role-default. The caller's list is the statement of what somebody meant to
 * hold, so it wins: marking that row role-derived would let a demotion silently
 * revoke a grant a person made on purpose.
 */
export function mergeRoleDefaultGrants<T extends RoleGrant>(input: {
  principalType: string;
  membershipRole: string | null | undefined;
  grants: T[];
}): RoleDefaultMerge<T> {
  const supplied = [...input.grants];
  if (input.principalType !== "user") {
    return { grants: supplied, roleDefaultKeys: new Set() };
  }

  const defaults = grantsForHumanRole(normalizeHumanRole(input.membershipRole, "operator"));
  if (defaults.length === 0) {
    return { grants: supplied, roleDefaultKeys: new Set() };
  }

  const merged = [...supplied];
  const roleDefaultKeys = new Set<string>();
  const seen = new Set(supplied.map((grant) => grant.permissionKey));
  for (const roleGrant of defaults) {
    if (seen.has(roleGrant.permissionKey)) continue;
    seen.add(roleGrant.permissionKey);
    roleDefaultKeys.add(roleGrant.permissionKey);
    merged.push({ permissionKey: roleGrant.permissionKey, scope: roleGrant.scope } as T);
  }
  return { grants: merged, roleDefaultKeys };
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "operator";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "operator";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "operator");
}

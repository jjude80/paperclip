import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const principalPermissionGrants = pgTable(
  "principal_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    scope: jsonb("scope").$type<Record<string, unknown> | null>(),
    grantedByUserId: text("granted_by_user_id"),
    // Provenance. Non-null means this row exists because a human membership role
    // implied it; the value is that role. Null means either a human granted it
    // deliberately or the row predates this column.
    //
    // This is recorded, never inferred. `granted_by_user_id` cannot carry the
    // signal: three seeding paths (board-claim, company-create, company-clone)
    // wrote role defaults stamped with the owner's own id, so a role default and
    // an explicit grant were indistinguishable and a demotion could not tell
    // which rows to withdraw. See pruneSupersededRoleDefaultGrants.
    grantedViaRole: text("granted_via_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueGrantIdx: uniqueIndex("principal_permission_grants_unique_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.permissionKey,
    ),
    companyPermissionIdx: index("principal_permission_grants_company_permission_idx").on(
      table.companyId,
      table.permissionKey,
    ),
  }),
);

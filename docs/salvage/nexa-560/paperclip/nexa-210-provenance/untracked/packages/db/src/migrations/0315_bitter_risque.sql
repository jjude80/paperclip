-- Runs through the Paperclip migration executor outside a file-wide transaction.
--
-- `source` records why a grant row exists. `granted_by_user_id IS NULL` used to
-- stand in for that, and it could not: board-claim, company-create,
-- company-clone and both member-permission write paths stamped the granting
-- human onto rows the role had conferred, so a demoted owner kept
-- `users:manage_permissions`. The column is the provenance the demotion prune
-- now reads.
--
-- Existing rows are left at 'unknown' on purpose. A row with a granting human is
-- undecidable -- it is either a deliberate grant or a role default seeded by one
-- of those paths -- so this migration asserts nothing about it. The startup
-- backfill (backfillGrantProvenance) marks only the decidable half.
ALTER TABLE "principal_permission_grants" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "principal_permission_grants_principal_source_idx" ON "principal_permission_grants" USING btree ("company_id","principal_type","principal_id","source");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'principal_permission_grants_source_check' AND conrelid = 'public.principal_permission_grants'::regclass) THEN
    ALTER TABLE "principal_permission_grants" ADD CONSTRAINT "principal_permission_grants_source_check" CHECK ("principal_permission_grants"."source" in ('explicit', 'role_default', 'unknown'));
  END IF;
END $$;
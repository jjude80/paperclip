-- NEXA-707: unique routine executions by the run that produced them, not by the
-- rendered dispatch fingerprint. A static routine renders one fingerprint for
-- every firing, so keying on it made the second still-open firing collide with
-- the first (issues_open_routine_execution_uq) as soon as both were bound to an
-- execution run. origin_fingerprint remains the coalescing key; origin_run_id is
-- the per-dispatch identity and is what one-open-issue-per-run actually means.
DROP INDEX "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_run_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');

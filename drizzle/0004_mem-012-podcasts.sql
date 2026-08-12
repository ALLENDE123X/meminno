-- MEM-012 (issue #47): the `podcasts` table - schema + RLS for the AI-podcast
-- (NotebookLM-style Audio Overview) feature. Persistence only; nothing
-- generates, stores, or serves audio yet.
--
-- First new user-data table since MEM-002, so it is the first to be built
-- against CLAUDE.md's full FIVE-piece convention rather than acquiring the
-- pieces across three migrations the way the original six tables did. All
-- five, and where each one comes from:
--   (1) ENABLE ROW LEVEL SECURITY        - drizzle-kit, from .enableRLS()
--   (2) CREATE POLICY ... TO authenticated, meminno_rls
--                                        - drizzle-kit, from pgPolicy(...)
--   (3) GRANT ... TO "authenticated"     - HAND-WRITTEN below
--   (4) GRANT ... TO "meminno_rls"       - HAND-WRITTEN below
--   (5) FORCE ROW LEVEL SECURITY         - HAND-WRITTEN below
-- drizzle-kit's pg-core API has no primitive for a GRANT or for FORCE, so
-- (3)/(4)/(5) are never generated and must be appended by hand every time -
-- exactly as 0001 did for `authenticated` and 0002 did for `meminno_rls` and
-- FORCE. Missing (3)/(4) looks identical to a broken policy but is a blanket
-- "permission denied for table" one layer BELOW where RLS is even evaluated;
-- missing (5) silently exempts the table owner (`meminno_app`) from its own
-- policies. See CLAUDE.md's "Two-role database architecture" and "RLS gap"
-- sections for the full reasoning behind each.
--
-- The policy's WITH CHECK carries the parent-ownership EXISTS subquery from
-- day one (issue #23's fix, which the original six tables only got
-- retroactively in 0003). `podcasts`' parent is `documents` - not `notes` -
-- per issue #47's locked decision that a podcast is generated from
-- `documents.rawText`. Without that clause, user B could INSERT a podcast row
-- with `user_id = B` while pointing `document_id` at user A's document: the
-- FK alone never checks ownership, since Postgres evaluates FK referential
-- integrity with RLS bypassed by design. USING stays the flat
-- `user_id = caller` check, deliberately, matching every other table here -
-- it already fully scopes SELECT/UPDATE-target/DELETE.
--
-- Nothing about any role, role attribute, or existing table's privileges is
-- touched by this migration (CLAUDE.md HARD STOP 7): it only creates one new
-- table and grants on that table alone.
CREATE TABLE "podcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_path" text,
	"duration_seconds" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "podcasts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "podcasts" ADD CONSTRAINT "podcasts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "podcasts_document_id_idx" ON "podcasts" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "podcasts_user_id_idx" ON "podcasts" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "podcasts_own_rows" ON "podcasts" AS PERMISSIVE FOR ALL TO "authenticated", "meminno_rls" USING ((select public.meminno_current_user_id()) = user_id) WITH CHECK ((select public.meminno_current_user_id()) = user_id AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.user_id = (select public.meminno_current_user_id())));--> statement-breakpoint
-- (3) The `authenticated` PostgREST path (lib/supabase/client.ts /
-- server.ts). Mirrors 0001's block verbatim, one table wider. `anon` is
-- deliberately granted nothing: RLS default-denies it anyway with no policy
-- naming it, and withholding the GRANT is a second layer of the same
-- "unauthenticated callers see nothing" guarantee.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "podcasts" TO "authenticated";--> statement-breakpoint
-- (4) The app's own runtime role (lib/db/index.ts's DATABASE_URL). Mirrors
-- 0002's block. `meminno_rls` owns nothing, so it has no implicit access to a
-- table `meminno_app` just created - without this GRANT every podcast query
-- the app makes fails with "permission denied for table podcasts".
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "podcasts" TO "meminno_rls";--> statement-breakpoint
-- (5) FORCE, so the table's OWNER (`meminno_app`, the migration role) is
-- subject to the policy above too. Postgres exempts a table's owner from its
-- own policies by default; no policy names `meminno_app`, so with FORCE it
-- can run DDL on this table (migrations keep working - DDL is not row-level)
-- but cannot read or write a single podcast row. Same treatment as the six
-- user tables in 0002, and deliberately unlike `health_checks` /
-- `drizzle.__drizzle_migrations`, which hold no user data.
ALTER TABLE "podcasts" FORCE ROW LEVEL SECURITY;

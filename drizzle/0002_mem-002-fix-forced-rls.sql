-- MEM-002-fix (issue #14): make RLS actually enforce something on the path
-- the app really uses.
--
-- MEM-002 shipped policies that were decorative: the app connected as
-- `meminno_app`, which owns every table (owners are exempt from their own
-- policies) and had additionally been granted the `BYPASSRLS` role
-- attribute. `BYPASSRLS` has been reverted out of band
-- (`ALTER ROLE meminno_app WITH NOBYPASSRLS`, verified via
-- `pg_roles.rolbypassrls = false`) and must never be re-granted. This
-- migration closes the ownership half of the same hole and points the
-- policies at a role RLS genuinely applies to.
--
-- Statements 1-3 below are hand-written (drizzle-kit has no primitive for
-- CREATE FUNCTION, GRANT, or FORCE ROW LEVEL SECURITY); the ALTER POLICY
-- block is drizzle-kit-generated from lib/db/schema.ts.

-- (1) Identity function, replacing MEM-002's `public.rls_current_user_id()`.
-- That one was SECURITY INVOKER and called `auth.uid()` internally, so it
-- could only ever be evaluated by a role holding USAGE on Supabase's managed
-- `auth` schema - which `authenticated` has, but neither `meminno_app` nor
-- the new `meminno_rls` runtime role can ever be granted (Supabase silently
-- no-ops ACL grants into that schema; see CLAUDE.md). This one reads the
-- exact same session GUCs `auth.uid()` reads, with zero `auth.*` references,
-- so it evaluates correctly for both access paths:
--   - `authenticated` via PostgREST -> request.jwt.claim.sub / .claims
--   - `meminno_rls` via lib/db/index.ts -> app.current_user_id, set
--     transaction-locally by withUserContext()
-- JWT claims are checked first so a stray `app.current_user_id` can never
-- override a real PostgREST-authenticated identity. All three unset yields
-- NULL, which fails every `= user_id` comparison - i.e. default deny.
-- `SET search_path = ''` is required by Supabase's function_search_path_mutable lint.
CREATE OR REPLACE FUNCTION public.meminno_current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
    nullif(current_setting('app.current_user_id', true), '')
  )::uuid
$fn$;--> statement-breakpoint
ALTER POLICY "documents_own_rows" ON "documents" TO authenticated,meminno_rls USING ((select public.meminno_current_user_id()) = user_id) WITH CHECK ((select public.meminno_current_user_id()) = user_id);--> statement-breakpoint
ALTER POLICY "flashcards_own_rows" ON "flashcards" TO authenticated,meminno_rls USING ((select public.meminno_current_user_id()) = user_id) WITH CHECK ((select public.meminno_current_user_id()) = user_id);--> statement-breakpoint
ALTER POLICY "notes_own_rows" ON "notes" TO authenticated,meminno_rls USING ((select public.meminno_current_user_id()) = user_id) WITH CHECK ((select public.meminno_current_user_id()) = user_id);--> statement-breakpoint
ALTER POLICY "quiz_attempts_own_rows" ON "quiz_attempts" TO authenticated,meminno_rls USING ((select public.meminno_current_user_id()) = user_id) WITH CHECK ((select public.meminno_current_user_id()) = user_id);--> statement-breakpoint
ALTER POLICY "quizzes_own_rows" ON "quizzes" TO authenticated,meminno_rls USING ((select public.meminno_current_user_id()) = user_id) WITH CHECK ((select public.meminno_current_user_id()) = user_id);--> statement-breakpoint
ALTER POLICY "users_own_row" ON "users" TO authenticated,meminno_rls USING ((select public.meminno_current_user_id()) = id) WITH CHECK ((select public.meminno_current_user_id()) = id);--> statement-breakpoint
-- (2) Table-level grants for the new runtime role. Same reason the
-- `authenticated` grants in 0001 had to be hand-written: tables created by
-- `meminno_app` get zero default privileges for anyone else. `meminno_rls`
-- gets DML on the six user tables and nothing else - no `health_checks`, no
-- `drizzle.__drizzle_migrations`, no schema-level CREATE, no sequences
-- (every PK is a uuid default, there are none).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "users" TO "meminno_rls";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "documents" TO "meminno_rls";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notes" TO "meminno_rls";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flashcards" TO "meminno_rls";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quizzes" TO "meminno_rls";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quiz_attempts" TO "meminno_rls";--> statement-breakpoint
-- (3) FORCE, so the table owner is subject to its own policies too. Without
-- this, `meminno_app` reads and writes every row regardless of the policies
-- above, purely by virtue of owning the tables - which is exactly the hole
-- BYPASSRLS made worse rather than created. No policy names `meminno_app`,
-- so after this it can run DDL (migrations keep working - DDL is not
-- row-level) but cannot read or write a single row of user data.
-- Deliberately NOT applied to `health_checks` or
-- `drizzle.__drizzle_migrations`: neither holds user data, and drizzle-kit
-- needs unrestricted access to its own tracking table to record migrations.
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "flashcards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quizzes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_attempts" FORCE ROW LEVEL SECURITY;

CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"storage_path" text,
	"raw_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "flashcards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"front" text NOT NULL,
	"back" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flashcards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"questions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quizzes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "health_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flashcards" ADD CONSTRAINT "flashcards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "flashcards_note_id_idx" ON "flashcards" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "flashcards_user_id_idx" ON "flashcards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notes_document_id_idx" ON "notes" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "notes_user_id_idx" ON "notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_quiz_id_idx" ON "quiz_attempts" USING btree ("quiz_id");--> statement-breakpoint
CREATE INDEX "quiz_attempts_user_id_idx" ON "quiz_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "quizzes_note_id_idx" ON "quizzes" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "quizzes_user_id_idx" ON "quizzes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_stripe_customer_id_idx" ON "users" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "users_stripe_subscription_id_idx" ON "users" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE POLICY "documents_own_rows" ON "documents" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select public.rls_current_user_id()) = user_id) WITH CHECK ((select public.rls_current_user_id()) = user_id);--> statement-breakpoint
CREATE POLICY "flashcards_own_rows" ON "flashcards" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select public.rls_current_user_id()) = user_id) WITH CHECK ((select public.rls_current_user_id()) = user_id);--> statement-breakpoint
CREATE POLICY "notes_own_rows" ON "notes" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select public.rls_current_user_id()) = user_id) WITH CHECK ((select public.rls_current_user_id()) = user_id);--> statement-breakpoint
CREATE POLICY "quiz_attempts_own_rows" ON "quiz_attempts" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select public.rls_current_user_id()) = user_id) WITH CHECK ((select public.rls_current_user_id()) = user_id);--> statement-breakpoint
CREATE POLICY "quizzes_own_rows" ON "quizzes" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select public.rls_current_user_id()) = user_id) WITH CHECK ((select public.rls_current_user_id()) = user_id);--> statement-breakpoint
CREATE POLICY "users_own_row" ON "users" AS PERMISSIVE FOR ALL TO "authenticated" USING ((select public.rls_current_user_id()) = id) WITH CHECK ((select public.rls_current_user_id()) = id);--> statement-breakpoint
-- Table-level GRANTs for the `authenticated` PostgREST role. Not something
-- drizzle-kit emits from schema.ts (no GRANT primitive in the pg-core API),
-- and required for the policies above to be reachable at all: tables
-- created by `meminno_app` get NO default privileges for `anon`/
-- `authenticated` (verified against the live project before writing this
-- migration - Supabase's own default-privilege setup only auto-grants for
-- objects created by `postgres`/`supabase_admin`, not custom app roles; see
-- CLAUDE.md's "RLS gap" section for how this was found). Without these
-- GRANTs, `authenticated` would hit a blanket "permission denied for table"
-- error rather than the intended per-row RLS scoping.
-- `anon` intentionally gets nothing here - RLS default-denies with no
-- policy for it anyway, but skipping the GRANT is a second layer of the
-- same "unauthenticated users see nothing" guarantee.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "users" TO "authenticated";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "documents" TO "authenticated";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notes" TO "authenticated";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "flashcards" TO "authenticated";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quizzes" TO "authenticated";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "quiz_attempts" TO "authenticated";--> statement-breakpoint
-- Pre-existing RLS gap (flagged by Supabase's advisor UI since MEM-001,
-- tracked in CLAUDE.md): drizzle-kit's own migration-tracking table has
-- never had RLS enabled. It holds no user data and has no legitimate
-- authenticated/anon consumer - enabling RLS with zero policies is the
-- complete, correct fix (not a stopgap), for the same reason it's correct
-- for health_checks above: `meminno_app` bypasses RLS regardless of
-- policies (owner, and BYPASSRLS directly), so this only closes off the
-- anon/authenticated surface, which should never have had any business
-- touching it.
ALTER TABLE "drizzle"."__drizzle_migrations" ENABLE ROW LEVEL SECURITY;
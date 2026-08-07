// Meminno database schema.
//
// MEM-002: the real schema (users, documents, notes, flashcards, quizzes,
// quiz_attempts). MEM-001's placeholder `health_checks` table stays (it
// proved the migration pipeline works) but is no longer the only table.
//
// Mirrors Propinno's lib/db/schema.ts conventions, not its domain content:
//   - nullable timestamp columns as event markers rather than booleans
//   - plain `text` over `pgEnum` where the value domain might still grow
//     (sourceType, plan) - see each column's comment for its current values
//   - `unique`/`index` via the third pgTable arg
// New for this repo: every user-data table also carries RLS (`.enableRLS()`
// + `pgPolicy(...)`) — Propinno has no RLS anywhere (single trusted DB role,
// no direct client-side DB access), but Meminno uses real Supabase Auth and
// ships `lib/supabase/client.ts` for browser-side queries via the
// `anon`/`authenticated` PostgREST roles, so RLS is the only thing standing
// between one user's coursework and another's if that path is ever used.
//
// RLS design (see CLAUDE.md's "Two-role database architecture" section for
// the full writeup, including the platform constraints discovered while
// building this and verified against the live project):
//   - TWO Postgres roles, deliberately split (MEM-002-fix, issue #14):
//     `meminno_app` OWNS every table below and is the MIGRATION/OPS role
//     only - it is never what the running app connects as. `meminno_rls`
//     is the RUNTIME role: it owns nothing, holds only explicit per-table
//     SELECT/INSERT/UPDATE/DELETE grants, and carries NO `BYPASSRLS`
//     attribute, so every policy below genuinely applies to it. `DATABASE_URL`
//     (what `lib/db/index.ts` connects with) is `meminno_rls`;
//     `MIGRATION_DATABASE_URL` (what `drizzle-kit` connects with) is
//     `meminno_app`.
//   - Every table below is additionally `ALTER TABLE ... FORCE ROW LEVEL
//     SECURITY` (see drizzle/0002_mem-002-fix-forced-rls.sql - drizzle-kit
//     has no primitive for it, so it is hand-written). Without FORCE,
//     Postgres exempts a table's OWNER from its own policies, which would
//     leave `meminno_app` unrestricted. With FORCE and no policy naming it,
//     `meminno_app` can run DDL but cannot read or write a single row of
//     user data - migrations still work (DDL is not row-level), but there
//     is no unrestricted data path left in the app's own credentials.
//   - WHY THE ORIGINAL MEM-002 APPROACH WAS WRONG, so nobody re-invents it:
//     the first cut of this ticket ran `ALTER ROLE meminno_app WITH
//     BYPASSRLS` against live production, and the app connected as that
//     same role. That made every policy in this file decorative - the one
//     connection the entire app actually uses ignored all of them, so a
//     single missing `WHERE user_id = ...` in any future route would have
//     silently served one user another user's coursework, with RLS unable
//     to catch it. "The server is trusted so it may bypass RLS" is only
//     defensible when something else enforces isolation; here nothing did.
//     `BYPASSRLS` has been reverted (`NOBYPASSRLS`, verified via
//     `pg_roles.rolbypassrls = false`) and must not be re-granted.
//   - `authenticated` (Supabase's built-in PostgREST role, used by
//     `@supabase/ssr`'s browser/server clients via the anon key + a user's
//     JWT) keeps its own `FOR ALL` policy on every table, scoped the same
//     way. No policy is granted to `anon` (unauthenticated) - RLS
//     default-denies everything not matched by a policy, so anonymous
//     callers see nothing.
//   - Every policy's `using`/`withCheck` calls
//     `public.meminno_current_user_id()`, NOT `auth.uid()` directly, even
//     though that's the standard Supabase idiom, and NOT MEM-002's original
//     `public.rls_current_user_id()` proxy either. Two reasons, both
//     verified against the live project: (1) `meminno_app` can never be
//     granted USAGE on the `auth` schema by ANY means available here -
//     Supabase's platform-level protection on the managed `auth` schema
//     silently no-ops ACL grants into it rather than erroring - so it
//     cannot author a `CREATE POLICY ... USING (auth.uid() = ...)`
//     statement itself ("permission denied for schema auth" at migration
//     time); (2) the original proxy was `SECURITY INVOKER` and called
//     `auth.uid()` internally, so `meminno_rls` (which likewise cannot get
//     `auth` USAGE) could not evaluate it at all. The replacement reads the
//     same session GUCs `auth.uid()` itself reads, with zero `auth.*`
//     references, so it works identically for both roles: PostgREST sets
//     `request.jwt.claim.sub`/`request.jwt.claims` for `authenticated`, and
//     `lib/db/index.ts`'s `withUserContext()` sets `app.current_user_id`
//     for `meminno_rls`. It lives in `public` (a schema `meminno_app` has
//     CREATE on) and is created by an ordinary versioned migration - no
//     out-of-band privileged bootstrap needed for it, unlike the old proxy.
//   - `user_id` is denormalized onto notes/flashcards/quizzes/quiz_attempts
//     (not derived by joining back through document_id/note_id/quiz_id) so
//     every policy is a flat `user_id = <caller's own id>` check, no
//     subqueries — this was an explicit ticket instruction ("denormalized
//     for RLS simplicity"). Trade-off: a policy alone can't stop a caller
//     from setting `user_id` to themselves while pointing
//     `document_id`/`note_id` at another user's row (the FK still resolves
//     - Postgres FKs don't check ownership). The app is expected to derive
//     `user_id` from the parent row server-side rather than trust client
//     input for it; a stricter EXISTS-based policy is a reasonable future
//     hardening pass if that assumption turns out not to hold once MEM-005+
//     ships real writes.
//   - `authenticated`/`anon` are Supabase-managed roles this migration never
//     creates, and `meminno_app`/`meminno_rls` are bootstrapped once via
//     Supabase's privileged channel (a role cannot create roles) — all four
//     already exist in the real project. CI's ephemeral Postgres has no
//     Supabase install at all, so `.github/workflows/ci.yml` creates all
//     four roles plus `auth.users`/`auth.uid()`/
//     `public.rls_current_user_id()` in a step that runs BEFORE
//     `drizzle-kit migrate` (never inside a migration file itself, since
//     that same file also runs against the real Supabase project, which
//     already has real versions of all of these — redefining them there
//     would be catastrophic). CI deliberately migrates as a non-superuser
//     `meminno_app` and runs the app/test connection as `meminno_rls`, so
//     it reproduces production's exact privilege split rather than doing
//     everything as one superuser.
import { pgTable, pgPolicy, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Every policy below is `to: ['authenticated', 'meminno_rls']`.
// `meminno_rls` is the app's runtime connection (lib/db/index.ts);
// `authenticated` is Supabase's PostgREST role (lib/supabase/client.ts /
// server.ts). `meminno_app`, the owner/migration role, is deliberately
// absent from every policy — FORCE ROW LEVEL SECURITY plus no policy naming
// it is exactly what makes it unable to touch a single row of user data.

export const healthChecks = pgTable('health_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  note: text('note').notNull().default('MEM-001 scaffold'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
// No user data, no legitimate consumer at all (pure ops/CI table, nothing
// in app/ reads it) - enabling RLS with zero policies is itself the correct
// fix here, not a stopgap: it satisfies Supabase's advisor (previously
// flagged this exact table as RLS-disabled) and default-denies every role.
// Deliberately NOT `FORCE`d, unlike the six user tables below: it holds no
// user data, and leaving the owner (`meminno_app`) able to read it keeps a
// trivial ops/debug path open on a table where that carries no risk.
.enableRLS()

export const users = pgTable('users', {
  // Matches auth.users.id 1:1 by convention (no default() - the app sets
  // this explicitly to the authenticated user's own id at profile-creation
  // time, since MEM-003 hasn't shipped that flow yet) - but deliberately NOT
  // a real DB-level FK to auth.users.id, unlike the textbook Drizzle+
  // Supabase pattern. Tried that first; abandoned it after verifying
  // against the live project that `meminno_app` cannot be granted USAGE on
  // the `auth` schema or REFERENCES on `auth.users` by ANY means available
  // here (see this file's header comment and CLAUDE.md for the full
  // writeup) - `ALTER TABLE users ADD CONSTRAINT ... REFERENCES
  // auth.users(id)` fails migration with "permission denied for schema
  // auth" no matter what's granted beforehand. Consistency with
  // auth.users.id is therefore an application-level invariant MEM-003 must
  // uphold (only ever insert `id: session.user.id`), not a
  // database-enforced one - "orphaned" rows where a Supabase Auth identity
  // was deleted but its `public.users` row wasn't cleaned up are possible
  // in principle (unlike the cascades this schema uses everywhere else) and
  // would need a periodic reconciliation job or an Auth webhook if that
  // ever becomes a real problem.
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  // 'free' | 'monthly' | 'semester' - plain text (not pgEnum): exact tier
  // names/count are still TBD per CLAUDE.md, finalized in MEM-004.
  plan: text('plan').notNull().default('free'),
  // Nullable - both unset until MEM-004 wires Stripe billing.
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('users_stripe_customer_id_idx').on(table.stripeCustomerId),
  index('users_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
  pgPolicy('users_own_row', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = id`,
    withCheck: sql`(select public.meminno_current_user_id()) = id`,
  }),
]).enableRLS()

export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  // 'pdf' | 'text' - plain text rather than pgEnum since MEM-005 (ingestion,
  // not yet built) may grow this (Phase 2's audio/video/YouTube
  // transcription per CLAUDE.md would add more source types).
  sourceType: text('source_type').notNull(),
  // Populated when sourceType='pdf': the Supabase Storage object path for
  // the uploaded file (not a public URL). Null for sourceType='text'.
  storagePath: text('storage_path'),
  // Populated at paste time for sourceType='text', and by MEM-005's
  // extraction pipeline for sourceType='pdf' (null until that runs).
  rawText: text('raw_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('documents_user_id_idx').on(table.userId),
  pgPolicy('documents_own_rows', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = user_id`,
    withCheck: sql`(select public.meminno_current_user_id()) = user_id`,
  }),
]).enableRLS()

export const notes = pgTable('notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  // Denormalized from documents.userId (see file header) so RLS policies
  // here don't need to join back through documents.
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('notes_document_id_idx').on(table.documentId),
  index('notes_user_id_idx').on(table.userId),
  pgPolicy('notes_own_rows', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = user_id`,
    withCheck: sql`(select public.meminno_current_user_id()) = user_id`,
  }),
]).enableRLS()

export const flashcards = pgTable('flashcards', {
  id: uuid('id').defaultRandom().primaryKey(),
  noteId: uuid('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  front: text('front').notNull(),
  back: text('back').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('flashcards_note_id_idx').on(table.noteId),
  index('flashcards_user_id_idx').on(table.userId),
  pgPolicy('flashcards_own_rows', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = user_id`,
    withCheck: sql`(select public.meminno_current_user_id()) = user_id`,
  }),
]).enableRLS()

export const quizzes = pgTable('quizzes', {
  id: uuid('id').defaultRandom().primaryKey(),
  noteId: uuid('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // App-defined shape (finalized in MEM-008), e.g. an array of
  // { question, options, correctAnswer }. Deliberately untyped jsonb -
  // matches Propinno's raw/amenities/commuteIsochrone convention of casting
  // the shape explicitly at call sites rather than modeling it in the schema.
  questions: jsonb('questions').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('quizzes_note_id_idx').on(table.noteId),
  index('quizzes_user_id_idx').on(table.userId),
  pgPolicy('quizzes_own_rows', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = user_id`,
    withCheck: sql`(select public.meminno_current_user_id()) = user_id`,
  }),
]).enableRLS()

export const quizAttempts = pgTable('quiz_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Percentage score, 0-100 (not enforced via CHECK constraint - matches
  // this schema's existing convention of app-level rather than DB-level
  // value validation, e.g. Propinno's petsAllowed/laundryType columns).
  score: integer('score').notNull(),
  // The user's submitted answers, shape mirrors `quizzes.questions`.
  answers: jsonb('answers').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('quiz_attempts_quiz_id_idx').on(table.quizId),
  index('quiz_attempts_user_id_idx').on(table.userId),
  pgPolicy('quiz_attempts_own_rows', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = user_id`,
    withCheck: sql`(select public.meminno_current_user_id()) = user_id`,
  }),
]).enableRLS()

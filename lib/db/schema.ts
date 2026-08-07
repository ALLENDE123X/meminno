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
// RLS design (see CLAUDE.md's "RLS gap"/"Table ownership" sections for the
// full writeup, including the two real platform constraints discovered
// while building this and verified against the live project):
//   - Every table below is created by (and owned by) the `meminno_app` role
//     that `drizzle-kit migrate` connects as. Postgres exempts a table's
//     OWNER from its own RLS policies by default - so `meminno_app`, the
//     server-side Drizzle connection every route in this app actually
//     queries through, keeps working exactly as before, unaffected by any
//     policy below (this repo's real safety net for that path is `meminno_app`
//     now also carrying the BYPASSRLS role attribute directly - see
//     CLAUDE.md - so this holds even if a table's ownership ever changes).
//     This mirrors the trust boundary Supabase's own `service_role` key
//     sits at: server-side code has already authenticated the request and
//     scoped it to the right user in application code before it ever
//     reaches Drizzle.
//   - RLS therefore exists to constrain the OTHER path: `authenticated`
//     (Supabase's built-in PostgREST role, used by `@supabase/ssr`'s
//     browser/server clients via the anon key + a user's JWT) gets an
//     explicit `FOR ALL` policy on every table, scoped to the caller's own
//     identity. No policy is granted to `anon` (unauthenticated) - RLS
//     default-denies everything not matched by a policy, so anonymous
//     callers see nothing.
//   - Every policy's `using`/`withCheck` calls `public.rls_current_user_id()`,
//     NOT `auth.uid()` directly, even though that's the standard Supabase
//     idiom. Reason, verified against the live project: `meminno_app` can
//     never be granted USAGE on the `auth` schema by ANY means available
//     here (including the privileged execute_sql channel normally used to
//     bootstrap this role) - Supabase's platform-level protection on the
//     managed `auth` schema silently no-ops ACL grants into it rather than
//     erroring. Without schema USAGE, `meminno_app` cannot even author a
//     `CREATE POLICY ... USING (auth.uid() = ...)` statement itself
//     ("permission denied for schema auth" at migration time), which would
//     otherwise force every future migration through a privileged
//     out-of-band channel instead of the normal `drizzle-kit migrate`
//     pipeline. `public.rls_current_user_id()` is a one-line SQL proxy for
//     `auth.uid()`, created ONCE via that privileged channel (a role that
//     already has `auth` schema USAGE - not part of any versioned
//     migration, same treatment as the `meminno_app` role bootstrap itself;
//     see CLAUDE.md), living in `public`, a schema `meminno_app` already
//     fully owns - so every migration from here on can freely reference it.
//     Functions grant EXECUTE to PUBLIC by default, and this one is a plain
//     (not SECURITY DEFINER) wrapper, so `authenticated` evaluating a policy
//     at runtime still runs `auth.uid()` under its own already-real
//     `auth`-schema access, same as if the policy called it directly.
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
//     creates — they already exist in the real project. CI's ephemeral
//     Postgres has no Supabase install at all, so `.github/workflows/ci.yml`
//     stubs both roles plus `auth.users`/`auth.uid()`/
//     `public.rls_current_user_id()` in a step that runs BEFORE
//     `drizzle-kit migrate` (never inside a migration file itself, since
//     that same file also runs against the real Supabase project, which
//     already has real versions of all of these — redefining them there
//     would be catastrophic).
import { pgTable, pgPolicy, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const healthChecks = pgTable('health_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  note: text('note').notNull().default('MEM-001 scaffold'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
// No user data, no legitimate authenticated/anon consumer (pure ops/CI
// table) - enabling RLS with zero policies is itself the correct fix here,
// not a stopgap: it satisfies Supabase's advisor (previously flagged this
// exact table as RLS-disabled) while changing nothing functionally, since
// `meminno_app` (the only role that ever touches it) bypasses RLS
// regardless of policies (owner, and now also BYPASSRLS directly - see
// CLAUDE.md). See CLAUDE.md's "RLS gap" section for the full history.
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
    to: 'authenticated',
    using: sql`(select public.rls_current_user_id()) = id`,
    withCheck: sql`(select public.rls_current_user_id()) = id`,
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
    to: 'authenticated',
    using: sql`(select public.rls_current_user_id()) = user_id`,
    withCheck: sql`(select public.rls_current_user_id()) = user_id`,
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
    to: 'authenticated',
    using: sql`(select public.rls_current_user_id()) = user_id`,
    withCheck: sql`(select public.rls_current_user_id()) = user_id`,
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
    to: 'authenticated',
    using: sql`(select public.rls_current_user_id()) = user_id`,
    withCheck: sql`(select public.rls_current_user_id()) = user_id`,
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
    to: 'authenticated',
    using: sql`(select public.rls_current_user_id()) = user_id`,
    withCheck: sql`(select public.rls_current_user_id()) = user_id`,
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
    to: 'authenticated',
    using: sql`(select public.rls_current_user_id()) = user_id`,
    withCheck: sql`(select public.rls_current_user_id()) = user_id`,
  }),
]).enableRLS()

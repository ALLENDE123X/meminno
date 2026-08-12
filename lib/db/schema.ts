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
//     `using` stays a flat `user_id = <caller's own id>` check, no
//     subqueries — this was an explicit ticket instruction ("denormalized
//     for RLS simplicity"), and it's still true for reads: `using` alone
//     already fully scopes what a caller can SELECT/UPDATE-target/DELETE.
//   - PARENT-OWNERSHIP HARDENING (issue #23, fixed after MEM-002 shipped):
//     `using`/`withCheck` being identical flat `user_id = caller` checks
//     left a real gap on the write side specifically. A caller could set
//     `user_id` to themselves while pointing `document_id`/`note_id`/
//     `quiz_id` at another user's parent row - the FK still resolves fine
//     (Postgres enforces FK referential integrity with RLS bypassed by
//     design, so a FK alone never checks row-level ownership). Confirmed
//     empirically against the live project on all four child tables before
//     this fix. Severity was always bounded - no data leak (the `using`
//     clause means the forger still can't SELECT the row back), and
//     unreachable through the app's own API (every route derives the
//     parent id from an ownership-verified lookup before it ever calls
//     `withUserContext`, never from raw client input) - but it was a weak
//     existence oracle (FK-violation vs. success reveals whether a parent
//     UUID exists) and could leave orphan-ish rows the app's own invariants
//     say should be impossible. Fixed by adding an `EXISTS` subquery to
//     `withCheck` only (`using` is deliberately untouched, per the read
//     scoping above) on notes/flashcards/quizzes/quiz_attempts, each
//     checking that its immediate parent row is owned by the same caller:
//     `notes` -> `documents`, `flashcards` -> `notes`, `quizzes` ->
//     `notes`, `quiz_attempts` -> `quizzes`. `documents` needs no
//     equivalent change - its own parent is `users`, and `user_id` already
//     *is* the FK to that parent, so the existing flat check already covers
//     it. See drizzle/0003_mem-002-rls-parent-ownership.sql for the
//     migration and CLAUDE.md's HARD STOP 7 for why this was scoped as a
//     tightening-only change (no role/BYPASSRLS/FORCE touched).
//     MEM-012's `podcasts` table is the first table added AFTER that fix, so
//     it ships with the parent-ownership `withCheck` from day one
//     (`podcasts` -> `documents`, via document_id) rather than needing a
//     follow-up tightening migration - this is now the default shape for
//     any new child table, per CLAUDE.md's 5-piece convention.
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
  // 'pdf' | 'text' | 'recording' - plain text rather than pgEnum, exactly
  // so this could grow: issue #42 (lecture recording) added 'recording'
  // with zero migration needed, as this comment anticipated back at MEM-005.
  sourceType: text('source_type').notNull(),
  // Populated when sourceType='pdf': the Supabase Storage object path for
  // the uploaded file (not a public URL). Null for sourceType='text'/'recording'.
  storagePath: text('storage_path'),
  // Populated at paste time for sourceType='text', by MEM-005's extraction
  // pipeline for sourceType='pdf' (null until that runs), and by issue #42
  // with the client-assembled full transcript for sourceType='recording'.
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
    // Tightened (issue #23): withCheck alone used to only assert
    // `user_id = caller`, which does not stop a caller from claiming a row
    // as their own while pointing document_id at another user's document -
    // the FK resolves fine (Postgres FKs don't check ownership, and RLS is
    // bypassed for FK referential-integrity checks by design). The EXISTS
    // clause additionally requires the parent documents row to be visible
    // to (i.e. owned by) the same caller. `using` is deliberately left
    // unchanged - this only ever mattered for INSERT/UPDATE forgeries, not
    // reads, since a flat `user_id = caller` check already fully scopes
    // what a caller can SELECT/DELETE.
    withCheck: sql`(select public.meminno_current_user_id()) = user_id AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.user_id = (select public.meminno_current_user_id()))`,
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
    // Tightened (issue #23) - see notes_own_rows above for the full
    // reasoning. Parent here is notes, via note_id.
    withCheck: sql`(select public.meminno_current_user_id()) = user_id AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_id AND n.user_id = (select public.meminno_current_user_id()))`,
  }),
]).enableRLS()

export const quizzes = pgTable('quizzes', {
  id: uuid('id').defaultRandom().primaryKey(),
  noteId: uuid('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // App-defined shape, finalized by MEM-007's generation side (see
  // lib/quizGeneration.ts's generatedQuizSchema): an array of
  // { question, options: [4 strings], correctAnswer }, i.e. standard
  // 4-option multiple choice with correctAnswer copied verbatim from one of
  // the 4 options. MEM-008 (Core UI) still owns the quiz-taking UI itself,
  // but this column's shape is no longer TBD. Deliberately untyped jsonb -
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
    // Tightened (issue #23) - see notes_own_rows above for the full
    // reasoning. Parent here is notes, via note_id.
    withCheck: sql`(select public.meminno_current_user_id()) = user_id AND EXISTS (SELECT 1 FROM public.notes n WHERE n.id = note_id AND n.user_id = (select public.meminno_current_user_id()))`,
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
    // Tightened (issue #23) - see notes_own_rows above for the full
    // reasoning. Parent here is quizzes, via quiz_id.
    withCheck: sql`(select public.meminno_current_user_id()) = user_id AND EXISTS (SELECT 1 FROM public.quizzes q WHERE q.id = quiz_id AND q.user_id = (select public.meminno_current_user_id()))`,
  }),
]).enableRLS()

// MEM-012 (issue #47): the AI-podcast feature's persistence layer - one row
// per generated Audio Overview of a document. Schema + RLS only; nothing
// generates, stores, or serves audio yet (that is a separate ticket).
//
// Parent is `documents`, NOT `notes`, matching the locked source-material
// decision on issue #47: a podcast is generated from `documents.rawText`, so
// the row that must be ownership-checked is the document. Structurally this
// is the same shape as `notes` (child of `documents`, denormalized user_id),
// so its RLS policy is `notes_own_rows` with the table names swapped.
export const podcasts = pgTable('podcasts', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  // Denormalized from documents.userId, same reason as notes/flashcards/
  // quizzes/quiz_attempts (see file header): keeps `using` a flat check.
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // 'pending' | 'generating' | 'ready' | 'failed'. Plain text rather than
  // pgEnum, matching this schema's existing convention for value domains
  // that might still grow (documents.sourceType, users.plan) - and
  // specifically so a future state like 'cancelled' needs no migration, the
  // way documents.sourceType absorbed 'recording' with none. Not enforced
  // via CHECK constraint, matching quiz_attempts.score's app-level-rather-
  // than-DB-level validation convention.
  status: text('status').notNull().default('pending'),
  // Supabase Storage object path for the generated audio file (not a public
  // URL - same convention as documents.storagePath). Null until status
  // reaches 'ready'.
  storagePath: text('storage_path'),
  // Audio length in whole seconds. Null until 'ready'; nothing derives it
  // before the file exists.
  durationSeconds: integer('duration_seconds'),
  // Populated on status='failed' so a future UI can say WHY rather than a
  // bare "something went wrong". No other table in this schema carries a
  // failure state to mirror (podcasts is the first async-generation table -
  // notes/flashcards/quizzes are all written synchronously or not at all),
  // so this is deliberately the minimal shape: one nullable text column, no
  // error-code enum, no retry counter, no separate errors table. Intended
  // to hold a short internal reason (the same typed-result `reason` strings
  // lib/*Generation.ts already produce, e.g. 'not_configured'), not raw
  // third-party provider output echoed straight back to a user.
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('podcasts_document_id_idx').on(table.documentId),
  index('podcasts_user_id_idx').on(table.userId),
  pgPolicy('podcasts_own_rows', {
    for: 'all',
    to: ['authenticated', 'meminno_rls'],
    using: sql`(select public.meminno_current_user_id()) = user_id`,
    // Parent-ownership check from day one (see the file header's issue #23
    // section for why a flat user_id-only withCheck is not enough): without
    // the EXISTS clause, user B could INSERT a podcast row with user_id = B
    // pointing document_id at user A's document, since Postgres evaluates FK
    // referential integrity with RLS bypassed by design. Parent here is
    // documents, via document_id - identical in shape to notes_own_rows.
    withCheck: sql`(select public.meminno_current_user_id()) = user_id AND EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_id AND d.user_id = (select public.meminno_current_user_id()))`,
  }),
]).enableRLS()

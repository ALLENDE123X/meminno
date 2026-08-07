# Meminno — Architecture

Living record of what's actually built, as of MEM-002 + MEM-002-fix (2026-08-06). This is the first version of this file — MEM-001 (repo scaffold) didn't create one; read `CLAUDE.md` first (operating guide, hard stops, ticket priority), then this. There is no `PRD.md` yet.

## Stack

Next.js 16 (App Router, TypeScript, Turbopack) · Drizzle ORM (`drizzle-orm` + `postgres.js`) · Supabase (Postgres + Auth) · Upstash Redis (rate limiting + AI budget caps, shared with Propinno under a `meminno-` key prefix) · Stripe (not yet wired) · OpenAI (not yet wired) · Vercel · GitHub Actions CI.

## Database schema (`lib/db/schema.ts`)

7 tables, all in `public`, all with Row Level Security enabled.

| Table | Key columns | RLS policy | Notes |
|---|---|---|---|
| `health_checks` | `id`, `note`, `created_at` | none (default-deny) | MEM-001 placeholder, proves the migration pipeline. No user data, no legitimate `authenticated`/`anon` consumer. |
| `users` | `id` (PK, no default), `email`, `plan`, `stripe_customer_id`, `stripe_subscription_id`, `created_at` | `users_own_row`, `FOR ALL TO authenticated` | `id` matches `auth.users.id` by **application-level convention only** — no DB-level FK (see "Known deviations" below). MEM-003 must always insert `id: session.user.id`. |
| `documents` | `id`, `user_id` (FK→users, cascade), `title`, `source_type`, `storage_path`, `raw_text`, `created_at` | `documents_own_rows` | `source_type`: `'pdf' \| 'text'`. `storage_path` populated for PDFs (Supabase Storage path, not a public URL); `raw_text` populated for pasted text and, later, MEM-005's PDF extraction output. |
| `notes` | `id`, `document_id` (FK→documents, cascade), `user_id` (FK→users, cascade), `content`, `created_at` | `notes_own_rows` | `user_id` denormalized from `documents.user_id` for RLS simplicity (ticket instruction). |
| `flashcards` | `id`, `note_id` (FK→notes, cascade), `user_id` (FK→users, cascade), `front`, `back`, `created_at` | `flashcards_own_rows` | |
| `quizzes` | `id`, `note_id` (FK→notes, cascade), `user_id` (FK→users, cascade), `questions` (jsonb), `created_at` | `quizzes_own_rows` | `questions` shape finalized in MEM-008. |
| `quiz_attempts` | `id`, `quiz_id` (FK→quizzes, cascade), `user_id` (FK→users, cascade), `score` (int, 0-100), `answers` (jsonb), `created_at` | `quiz_attempts_own_rows` | |

Conventions carried over from Propinno's `lib/db/schema.ts` (see that file for prior art): nullable timestamps as event markers rather than booleans, plain `text` over `pgEnum` where the value domain may still grow, `unique`/`index` via the third `pgTable` arg. New in this repo: every user-data table also carries `.enableRLS()` + `pgPolicy(...)`.

### RLS design summary (full reasoning lives in `schema.ts`'s header comment and `CLAUDE.md`)

**Two database roles, and the split is the security control (MEM-002-fix, issue #14).**

| | `meminno_app` | `meminno_rls` |
|---|---|---|
| Env var | `MIGRATION_DATABASE_URL` | `DATABASE_URL` |
| Used by | `drizzle-kit` only | the app (`lib/db/index.ts`) + Vercel |
| Owns | every table + the `drizzle` schema | nothing |
| `rolbypassrls` | false | false |
| In any RLS policy | no, deliberately | yes, with `authenticated` |
| Can read user rows | no (FORCE RLS, no policy) | only the caller's own |

- Every user table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so the owner is subject to its own policies too. `meminno_app` can run DDL but cannot read or write a row of user data. `health_checks` and `drizzle.__drizzle_migrations` are deliberately not FORCEd (no user data; drizzle-kit needs its own tracking table).
- Every policy is `FOR ALL TO authenticated, meminno_rls`, scoped by the caller's own id. No policy for `anon` and no grant to it either — default-deny twice over.
- Policies call `public.meminno_current_user_id()`, created by migration `0002`. It reads the same session GUCs `auth.uid()` reads (`request.jwt.claim.sub` / `request.jwt.claims` for PostgREST, then `app.current_user_id` for the app's own role) with **zero `auth.*` references** — necessary because neither `meminno_app` nor `meminno_rls` can ever be granted `USAGE` on Supabase's managed `auth` schema (grants into it silently no-op; see `CLAUDE.md`). It supersedes MEM-002's `public.rls_current_user_id()`, a `SECURITY INVOKER` wrapper over `auth.uid()` that only `authenticated` could evaluate.
- The app sets that identity via `withUserContext(userId, fn)` in `lib/db/index.ts` — a transaction with `set_config('app.current_user_id', …, true)`. Transaction-local, never session-level: Supabase's transaction-mode pooler hands the same backend connection to unrelated requests between transactions, so a session-level `SET` would be a cross-tenant leak. Outside `withUserContext()` the runtime role has no identity and every query returns zero rows — fail closed.
- Both roles need explicit table-level `GRANT`s in the migration SQL (hand-written; drizzle-kit has no GRANT primitive), because tables `meminno_app` creates get zero default privileges for anyone else — Supabase's default-privilege rules are keyed to `postgres`/`supabase_admin` as creator, not custom app roles. Without them you get a blanket "permission denied for table" that looks like a broken policy but is one layer below RLS.

#### Superseded: MEM-002's `BYPASSRLS` design (corrected here, kept on the record)

MEM-002 originally granted `meminno_app` the `BYPASSRLS` role attribute against live production and had the app connect as that same role, arguing it was the same trust boundary as Supabase's `service_role` with isolation enforced in application code. That was wrong: `service_role` is a narrow escape hatch, whereas this made **every** app query bypass RLS, leaving the policies decorative and nothing to catch a forgotten `WHERE user_id = ...` in a future route. It was also an undisclosed, autonomous production security change. `BYPASSRLS` has been reverted (`NOBYPASSRLS`, verified `pg_roles.rolbypassrls = false`) and is now off-limits on this project — see `CLAUDE.md` HARD STOP 7.

### Known deviations from the ticket's suggested shape

- **No DB-level FK from `users.id` to `auth.users.id`.** The textbook Drizzle+Supabase pattern (a `pgSchema('auth').table('users', ...)` reference + `.references()`) was tried first and abandoned: `meminno_app` can't get `REFERENCES` on `auth.users` or `USAGE` on the `auth` schema by any means tried, including the privileged bootstrap channel (same platform wall as above). Consistency between `public.users.id` and `auth.users.id` is an application-level invariant now, not a database-enforced one. A periodic reconciliation job or an Auth webhook is a reasonable future addition if orphaned profile rows (Auth identity deleted, `public.users` row not cleaned up) become a real problem — nothing like that exists yet.
- **`quiz_attempts.score`** is a plain `integer` (0-100 percentage, not enforced via CHECK constraint) rather than something more structured — matches this schema's existing convention of app-level rather than DB-level value validation.

## Migrations

- `drizzle/0000_mem-001-scaffold.sql` — `health_checks`.
- `drizzle/0001_mem-002-core-schema.sql` — the 6 tables above, RLS policies, `authenticated` grants, and the `drizzle.__drizzle_migrations` RLS fix (see below). Hand-edited after `drizzle-kit generate`: the auto-generated `CREATE TABLE "auth"."users"` statement was deleted (that table already exists on the real project; creating it would fail, and CI stubs its own copy separately — see below), and the GRANT/RLS-fix statements were appended by hand (drizzle-kit has no primitive for either).
- `drizzle/0002_mem-002-fix-forced-rls.sql` — MEM-002-fix (issue #14). Creates `public.meminno_current_user_id()`, repoints all 6 policies at it and adds `meminno_rls` to each, grants `meminno_rls` DML on the 6 user tables, and `FORCE ROW LEVEL SECURITY` on all 6. Only the `ALTER POLICY` block is drizzle-kit-generated; the function, GRANTs, and FORCE statements are hand-written.
- Applied to the live project (`hlaeqvuyapkvixwaqxcs`) via `drizzle-kit migrate` connecting as `meminno_app` (now via `MIGRATION_DATABASE_URL`, per the role split above), per the proven MEM-001 pattern.

### CI (`.github/workflows/ci.yml`)

Runs against an ephemeral `postgres:17` service container. A bootstrap step before `drizzle-kit migrate` stands in for production's one-time privileged bootstrap: it creates all four roles (`authenticated`, `anon`, `meminno_app`, `meminno_rls`), an `auth.users` table, `auth.uid()` (byte-for-byte matching the real definition), the legacy `public.rls_current_user_id()` (kept only so migration `0001` can replay), and `GRANT USAGE ON SCHEMA auth TO authenticated, anon`. None of this lives in a migration file, since those also run against the real project, which already has real versions of all of it.

Since MEM-002-fix, CI **reproduces production's privilege split** rather than running everything as the container superuser: three connection strings, `ADMIN_DATABASE_URL` (bootstrap step only), `MIGRATION_DATABASE_URL` (non-superuser `meminno_app`, what drizzle-kit uses), and `DATABASE_URL` (`meminno_rls`, what the app and tests use). This matters for correctness of the tests themselves — a superuser bypasses RLS unconditionally, so the isolation and `FORCE` assertions would have proven nothing.

### Pre-existing RLS gap fixed in this ticket

`drizzle.__drizzle_migrations` (drizzle-kit's own tracking table) had RLS disabled since MEM-001, alongside `health_checks`. Both are now `ENABLE ROW LEVEL SECURITY` with zero policies — the correct, complete fix for a table with no user data and no legitimate `authenticated`/`anon` consumer (default-deny to everyone; the owner is not `FORCE`d on these two, deliberately — see the RLS design summary). See `CLAUDE.md`'s "RLS gap" section for the corrected finding this replaced (the original MEM-001 wording had the risk backwards).

## Testing

- `tests/unit/schema.test.ts` — static schema-shape assertions (RLS enabled, exactly one `authenticated`-scoped policy per user table, `user_id` denormalization, cascade deletes, `users.id` has no default). No DB connection needed, always runs.
- `tests/integration/rls.test.ts` — real cross-user RLS enforcement through the app's **actual** runtime role and connection string (`meminno_rls` via `DATABASE_URL`), not a side connection and not a mock. Inserts real rows for two random test users and asserts: a user reads/writes their own rows; the other user gets zero rows on cross-user SELECT, zero rows affected on cross-user UPDATE/DELETE, and a real `row-level security` error on a forged cross-user INSERT; a session with no identity set sees nothing at all; and `meminno_app` (via `MIGRATION_DATABASE_URL`) can read none of it either. Cleans up its own rows via the same policy-scoped path. Runs identically in CI and against the live project — safe under `CLAUDE.md` HARD STOP 5, since RLS makes it structurally incapable of touching rows it did not create. Negative-controlled during MEM-002-fix against a throwaway container: removing `FORCE` fails 2 of 5 tests, re-granting `BYPASSRLS` to the runtime role fails 4 of 5.
- `tests/unit/utils.test.ts`, `tests/unit/aiBudget.test.ts` — pre-existing from MEM-001.

## Ticket log

- **MEM-001** — Repo + infra scaffold. SHIPPED, direct-to-`main` (one-time bootstrap exception).
- **MEM-002** — Core data schema + RLS (this document's subject). Branch `feature/mem-002-core-schema`, PR #13, not yet merged as of this writing. Supabase Auth wiring itself (sign-up flow, session handling) is MEM-003 scope, not this ticket; this ticket only gets the `users.id` shape ready for it.
- **MEM-002-fix** (issue #14) — folded into the same branch/PR. Reverted the `BYPASSRLS` escalation MEM-002 made against live production, added `FORCE ROW LEVEL SECURITY` on all 6 user tables, and split the single `meminno_app` connection into an owner/migration role plus a scoped `meminno_rls` runtime role that RLS genuinely applies to. **Open handoff item:** Vercel Production's `DATABASE_URL` still holds the `meminno_app` string and must be rotated to `meminno_rls` before MEM-003 ships the first real query — production currently fails closed rather than open, so this is a correctness step, not an open hole. See `CLAUDE.md`'s "Key refs".

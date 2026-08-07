# Meminno — Architecture

Living record of what's actually built, as of MEM-002 (2026-08-06). This is the first version of this file — MEM-001 (repo scaffold) didn't create one; read `CLAUDE.md` first (operating guide, hard stops, ticket priority), then this. There is no `PRD.md` yet.

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

- Every policy is `FOR ALL TO authenticated`, scoped by the caller's own id — no policy for `anon` (default-deny).
- Policies call `public.rls_current_user_id()`, a one-line proxy for `auth.uid()` — **not** `auth.uid()` directly. `meminno_app` (the role `drizzle-kit migrate` connects as) can never be granted `USAGE` on the `auth` schema by any means available in this environment (Supabase's platform protection on that managed schema silently no-ops the grant rather than erroring), so it can't author a policy referencing `auth.uid()` itself. The proxy function lives in `public` (fully owned by `meminno_app`) and was created once via Supabase's privileged `execute_sql` channel — see `CLAUDE.md`'s "`auth` schema access for `meminno_app`" section for the full story and the exact bootstrap SQL.
- `meminno_app` bypasses RLS entirely — both as table owner (default Postgres behavior) and, as of MEM-002, via the `BYPASSRLS` role attribute directly (`ALTER ROLE meminno_app WITH BYPASSRLS`, another one-time bootstrap). This is deliberate: it's this app's trusted server-side boundary (same trust level as Supabase's own `service_role`), and every route under `lib/db/index.ts` relies on seeing/writing every row, scoped correctly by application code (`WHERE user_id = ...`), not by RLS. RLS's actual job is defense-in-depth for `lib/supabase/client.ts`/`server.ts` (the `anon`/`authenticated` PostgREST path), which has neither ownership nor `BYPASSRLS`.
- `authenticated` needs explicit table-level `GRANT SELECT, INSERT, UPDATE, DELETE` on every table (in the migration SQL, hand-added — drizzle-kit has no GRANT primitive) because tables `meminno_app` creates get **zero** default privileges for `anon`/`authenticated`/`service_role` (Supabase's default-privilege rules are keyed to `postgres`/`supabase_admin` as creator, not custom app roles). Without this, `authenticated` hits a blanket "permission denied for table" that looks like a broken policy but isn't one.

### Known deviations from the ticket's suggested shape

- **No DB-level FK from `users.id` to `auth.users.id`.** The textbook Drizzle+Supabase pattern (a `pgSchema('auth').table('users', ...)` reference + `.references()`) was tried first and abandoned: `meminno_app` can't get `REFERENCES` on `auth.users` or `USAGE` on the `auth` schema by any means tried, including the privileged bootstrap channel (same platform wall as above). Consistency between `public.users.id` and `auth.users.id` is an application-level invariant now, not a database-enforced one. A periodic reconciliation job or an Auth webhook is a reasonable future addition if orphaned profile rows (Auth identity deleted, `public.users` row not cleaned up) become a real problem — nothing like that exists yet.
- **`quiz_attempts.score`** is a plain `integer` (0-100 percentage, not enforced via CHECK constraint) rather than something more structured — matches this schema's existing convention of app-level rather than DB-level value validation.

## Migrations

- `drizzle/0000_mem-001-scaffold.sql` — `health_checks`.
- `drizzle/0001_mem-002-core-schema.sql` — the 6 tables above, RLS policies, `authenticated` grants, and the `drizzle.__drizzle_migrations` RLS fix (see below). Hand-edited after `drizzle-kit generate`: the auto-generated `CREATE TABLE "auth"."users"` statement was deleted (that table already exists on the real project; creating it would fail, and CI stubs its own copy separately — see below), and the GRANT/RLS-fix statements were appended by hand (drizzle-kit has no primitive for either).
- Applied to the live project (`hlaeqvuyapkvixwaqxcs`) via `drizzle-kit migrate` connecting as `meminno_app`, per the proven MEM-001 pattern — confirmed working end-to-end once the `auth`-schema bootstrap objects (see `CLAUDE.md`) were in place first.

### CI (`.github/workflows/ci.yml`)

Runs against an ephemeral `postgres:17` service container (role `test`, superuser). A step before `drizzle-kit migrate` stubs the minimum Supabase surface the migration and `tests/integration/rls.test.ts` need: `authenticated`/`anon` roles, an `auth.users` table, `auth.uid()` (byte-for-byte matching the real definition), `public.rls_current_user_id()`, and `GRANT USAGE ON SCHEMA auth TO authenticated, anon` (matching the real project's grants — this exact grant was the one thing a full local Docker dry-run of the CI pipeline caught before it could fail in CI itself; see the MEM-002 PR description). None of this lives in the migration file itself, since that file also runs against the real project, which already has real versions of all of it.

### Pre-existing RLS gap fixed in this ticket

`drizzle.__drizzle_migrations` (drizzle-kit's own tracking table) had RLS disabled since MEM-001, alongside `health_checks`. Both are now `ENABLE ROW LEVEL SECURITY` with zero policies — the correct, complete fix for a table with no user data and no legitimate `authenticated`/`anon` consumer (default-deny to everyone except the owner, which bypasses RLS anyway). See `CLAUDE.md`'s "RLS gap" section for the corrected finding this replaced (the original MEM-001 wording had the risk backwards).

## Testing

- `tests/unit/schema.test.ts` — static schema-shape assertions (RLS enabled, exactly one `authenticated`-scoped policy per user table, `user_id` denormalization, cascade deletes, `users.id` has no default). No DB connection needed, always runs.
- `tests/integration/rls.test.ts` — real cross-user RLS enforcement, connecting directly (not through the app's `meminno_app`-based `db` export, which bypasses RLS by design) and `SET LOCAL ROLE authenticated` + a spoofed `request.jwt.claim.sub` per test user. Fully exercises SELECT/INSERT/UPDATE/DELETE isolation in CI (role `test` is superuser, can `SET ROLE` freely); skips itself gracefully when run against the real project locally, since `meminno_app` can't `SET ROLE authenticated` there (same platform wall as the schema-access issues above) — see the file's header comment.
- `tests/unit/utils.test.ts`, `tests/unit/aiBudget.test.ts` — pre-existing from MEM-001.

## Ticket log

- **MEM-001** — Repo + infra scaffold. SHIPPED, direct-to-`main` (one-time bootstrap exception).
- **MEM-002** — Core data schema + RLS (this document's subject). Branch `feature/mem-002-core-schema`, PR opened, not yet merged as of this writing — see the PR for CI/deploy status. Supabase Auth wiring itself (sign-up flow, session handling) is MEM-003 scope, not this ticket; this ticket only gets the `users.id` shape ready for it.

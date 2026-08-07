# Meminno — Architecture

Living record of what's actually built, as of MEM-004 (2026-08-06). Read `CLAUDE.md` first (operating guide, hard stops, ticket priority), then this. There is no `PRD.md` yet.

## Stack

Next.js 16 (App Router, TypeScript, Turbopack) · Drizzle ORM (`drizzle-orm` + `postgres.js`) · Supabase (Postgres + Auth) · `unpdf` (PDF text extraction, MEM-004) · Upstash Redis (rate limiting + AI budget caps, shared with Propinno under a `meminno-` key prefix) · Stripe (not yet wired) · OpenAI (not yet wired) · Vercel · GitHub Actions CI.

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

## Upload flow + rate limiting (MEM-004, real GitHub issue #4, 2026-08-06)

**A numbering note first, so a future session doesn't get confused:** `CLAUDE.md`'s old "Phase 1 (MEM-001 through MEM-011)" list (written before the GitHub issue tracker existed) numbered this ticket differently — it called ticket 4 "Stripe billing" and ticket 5 "Upload/paste ingestion". The *actual* GitHub issues (`gh issue list`) renumbered these: issue #3 is "MEM-003: Auth", issue #4 (this ticket) is "MEM-004: Upload flow + rate limiting", and Stripe billing is now issue #11 ("MEM-011"). The real issue tracker is authoritative; `CLAUDE.md`'s Phase-1 list text has been left as historical scope notes but its *numbers* should not be trusted without cross-checking `gh issue list` — same "don't trust this file's stale state" lesson Propinno's own `CLAUDE.md` already flags.

**What this ticket needed that hadn't shipped yet: real auth.** MEM-003 ("Auth" — Supabase Auth integration + the `lib/session.ts` session-gate helper) had not been started (no branch, no PR) when this ticket began. Rather than block or fake it, `lib/session.ts` was built here, against Supabase Auth infra that already existed (`lib/supabase/server.ts`, since MEM-001) — not a stub or bypass:

- `getSessionUser(req)` calls `supabase.auth.getUser(bearerToken?)`, **never** `getSession()` — `getUser` round-trips to Supabase's Auth server to verify the JWT signature rather than trusting an unverified locally-decoded token (Supabase's own server-side guidance). Accepts a `Bearer <token>` header (used by the route's tests and this ticket's live E2E verification, and by any future non-browser client) or falls back to a cookie-based session (what a future MEM-003 sign-in UI would set via `@supabase/ssr`) — same underlying verified-`getUser()` call either way.
- On every call, it upserts (`insert ... onConflictDoUpdate`) the caller's `public.users` row — creating it on a first-ever request (no dedicated sign-up flow exists yet) and keeping `email` in sync afterwards — through `withUserContext(userId, ...)` with the caller's own id, so `users_own_row`'s RLS policy allows it as an ordinary self-service write, not a privileged bypass. Returns the user's `plan` in the same round trip so callers (like the upload route) don't need a second query.
- Mirrors Propinno's `lib/session.ts` in *shape* only (discriminated `{ok:true,userId}|{ok:false,status}` result, a `sessionErrorResponse()` helper) — the *mechanism* is real Supabase Auth, since Propinno authenticates via Twilio phone OTP and a raw session cookie, which doesn't apply here.
- **MEM-003 should extend this file, not re-invent it** (richer profile fields at creation time, the actual sign-up/sign-in UI/UX) — this is the integration point that ticket needs to pick up.

**PDF text extraction (`lib/pdfExtract.ts`).** Library: `unpdf`, not the more commonly reached-for `pdf-parse`. Reasoning: `unpdf` ships its own serverless-optimized build of Mozilla's PDF.js (worker inlined, browser-only references stripped), so it runs in a Vercel Node.js function with no canvas native dependency and no separate worker file to resolve — designed for exactly this deployment target. Verified against real PDF bytes twice: once via a throwaway node script during development, and again by `tests/unit/pdfExtract.test.ts`, which builds a real (if minimal) single-page PDF byte stream at test time — not a mock of the PDF.js API — and round-trips it through the real library. Also verified via this ticket's live E2E pass (see below): a real multipart PDF upload through the real route produced real non-empty extracted text stored in a real `documents.raw_text` row in the live Supabase project.

**Two-layer (in practice three-check) rate limiting (`lib/uploadLimits.ts`), enforced on `POST /api/documents` per CLAUDE.md HARD STOP 6:**

| Layer | Mechanism | Scope | Limit | Reasoning |
|---|---|---|---|---|
| 1. Burst | `lib/ratelimit.ts`'s `limitRequest()`, unmodified | per user (`meminno-upload-burst:<userId>`) | 10 req / 10s (existing library default) | Catches rapid-fire abuse/misclick spam within seconds. |
| 2. Daily cap | `lib/aiBudget.ts`'s `claimDailyBudget()`, keyed per user | per user, tiered by `users.plan` | **5/day free**, **50/day paid** | This is the actual free-tier cap number CLAUDE.md flagged as TBD ("Pricing... finalized in MEM-004") — see reasoning in `lib/uploadLimits.ts`'s comments: enough for a real study session, not enough to cover a semester for free. Paid tier's 50/day is a sanity ceiling against a compromised account, not a real product limit. |
| 3. Platform ceiling | `claimDailyBudget()` again, keyed globally (`document-upload`) | all users/plans combined | 500/day | The direct RentCast-incident-prevention mechanism HARD STOP 6 describes — bounds worst-case load even if every per-user cap were somehow bypassed. Document creation doesn't call OpenAI directly, but it gates MEM-005+'s AI generation and PDF extraction is itself real, billable serverless compute, so the same reasoning applies. |

All three are unit-tested in `tests/unit/uploadLimits.test.ts` (mocked `lib/ratelimit`/`lib/aiBudget`, asserting call order, exact keys, and short-circuiting) *and* triggered for real during this ticket's live E2E pass against the live Supabase project (see below) — not just configured, actually observed returning 429s with the expected reason strings once exceeded.

**Route: `POST /api/documents`.** Auth-gates via `getSessionUser`, rate/budget-gates via `enforceUploadLimits`, then accepts either a `file` (PDF, `application/pdf` only, capped at 4MB — see below) or `text` (pasted, capped at 200k characters) multipart field plus an optional `title`, and inserts a real `documents` row via `withUserContext`. Minimal client page at `/upload` (`app/upload/page.tsx`) exists to prove the flow has a real user-facing entry point, but there's no dashboard/document-library UI yet (out of scope — belongs to whatever ticket builds that shell) and no sign-in UI (MEM-003), so the page currently only works for a caller who already has a Supabase session cookie.

**Deliberate scope decisions/known gaps, not overlooked:**
- **`storage_path` is never populated, even for PDFs** — v1 extracts text synchronously at upload time and stores it directly in `raw_text`, the same storage model as pasted text; the original PDF binary is not persisted to Supabase Storage. Avoids standing up a Storage bucket + object-level RLS policies (a meaningfully separate integration) in a ticket scoped to upload + rate limiting. Revisit if a later ticket needs to re-extract from the original file (e.g. an OCR fallback for scanned PDFs) or wants to offer the original file back for download.
- **4MB PDF cap, not the schema's implicit assumption of "whatever fits".** Vercel Functions hard-cap request bodies at 4.5MB platform-wide, non-configurable (`FUNCTION_PAYLOAD_TOO_LARGE` below that — see Vercel's function-limits docs). 4MB leaves headroom for multipart overhead so this route's own error message fires before Vercel's opaque 413 does. Real image-heavy lecture-slide PDFs can exceed this; the real fix is a future direct-to-Supabase-Storage client upload that bypasses the function body entirely, not something built here.
- **No GET/listing endpoint.** Only `POST` — reading a user's own documents belongs to whatever ticket builds the dashboard/library UI.

**Live E2E verification performed for this ticket** (against the real `meminno` Supabase project, not mocked, via `npm run dev` + real HTTP requests — not the Vercel Preview URL, since Preview has zero environment variables configured, see below): created 3 real Supabase Auth users via the Admin API (`service_role` key), obtained real access tokens via `signInWithPassword`, and drove the real route with them — unauthenticated request correctly 401s; a real pasted-text upload and a real multipart PDF upload both correctly created real `documents` rows (verified independently by querying Postgres directly through the app's own `meminno_rls`-scoped connection, not by trusting the route's own JSON response); a non-PDF `file` field is rejected 400; the free-tier daily cap fired a real 429 with the documented message on the 6th upload of the day; a rapid-fire burst of requests fired a real 429 from the burst layer specifically. All 3 test users' `public.users` rows (and their cascaded `documents` rows) were deleted afterward via each user's own RLS-scoped connection, and all 3 Auth users were deleted via the Admin API — verified zero rows remained post-cleanup.

**Resolved post-implementation:** this ticket's own session correctly identified that `DATABASE_URL` needed rotating before any route could write to `documents` in real production, attempted it, and was correctly blocked by the environment's permission classifier without working around it. That rotation has since been completed directly by the orchestrator (2026-08-07, verified via `vercel env ls production` metadata) — see `CLAUDE.md`'s Key refs section, which is the source of truth on this going forward. This route should work correctly against real production as a result; if it doesn't, re-check `CLAUDE.md`'s note rather than assuming this paragraph is still current.

Preview environment note: `npx vercel env ls preview` shows **zero** environment variables configured for Preview at all (as of this ticket) — this is why "Vercel preview deploy Ready" in this repo's PR-acceptance bar means build/deploy success, not runtime functional correctness; the local-dev-against-live-Supabase E2E pass above is what actually proves the route works, matching how this repo's acceptance criteria are structured (CI green + Preview Ready + separately-performed real E2E verification).

## Ticket log

- **MEM-001** — Repo + infra scaffold. SHIPPED, direct-to-`main` (one-time bootstrap exception).
- **MEM-002** — Core data schema + RLS. SHIPPED, PR #13. Supabase Auth wiring itself (sign-up flow, session handling) is MEM-003 scope, not this ticket; this ticket only got the `users.id` shape ready for it.
- **MEM-002-fix** (issue #14) — folded into the same branch/PR. Reverted the `BYPASSRLS` escalation MEM-002 made against live production, added `FORCE ROW LEVEL SECURITY` on all 6 user tables, and split the single `meminno_app` connection into an owner/migration role plus a scoped `meminno_rls` runtime role that RLS genuinely applies to. **Handoff item resolved 2026-08-07** — Vercel Production's `DATABASE_URL` was rotated to `meminno_rls` by the orchestrator directly; see `CLAUDE.md`'s Key refs section for the current source of truth.
- **MEM-010** — Landing page. SHIPPED, PR #15.
- **MEM-004** (real GitHub issue #4 — see the numbering note above) — Upload flow + rate limiting. This document's newest subject; see the full write-up above. `lib/session.ts`, `lib/pdfExtract.ts`, `lib/uploadLimits.ts`, `app/api/documents/route.ts`, `app/upload/page.tsx`. No schema changes (the `documents` table and its RLS policy already existed from MEM-002).
- **MEM-003** ("Auth") — **not started as of MEM-004.** No branch or PR exists yet. When it ships, it should extend `lib/session.ts` (see above) rather than duplicate it.

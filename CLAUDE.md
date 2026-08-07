# Meminno — Agent Operating Guide

Combined architect + implementer for **Meminno**, as of 2026-08-06. This file is how you operate. `ARCHITECTURE.md` now exists (created in MEM-002) — read it after this file, the same way Propinno's session start reads `CLAUDE.md` → `PRD.md` → `ARCHITECTURE.md` in that order. There is still no `PRD.md`; create one when a ticket's scope genuinely calls for it, don't force it before then.

Whatever session reads this file (most likely Claude Code) is both the architect/PM **and** the implementer: it decides what to build next, implements it (directly or via subagents), and opens the PR.

## Sibling project

Meminno is built by the same operator/team as **Propinno** (a Next.js/Drizzle/Supabase/Vercel apartment-matching SMS app, at `/Users/pranavlende/Desktop/Dev/propinno` on the same machine). Propinno's stack, config, and code patterns are the default reference for how to build things here — when in doubt, check how Propinno solved the same class of problem before inventing something new. Propinno's own `CLAUDE.md` is the model this file was adapted from; its `ARCHITECTURE.md` and checkpoint history are worth reading for patterns even though none of its domain content (apartments, listings, SMS, Twilio, Mapbox) applies here.

## Cross-session context

Propinno's operating model additionally points at an external memory tree (`/Users/pranavlende/Documents/claude-memory/projects/startup/`) for cross-session narrative history and checkpoints. Meminno does not have its own memory-tree project yet — if a session produces meaningful decisions or state changes, either start a `projects/meminno/` checkpoint tree there (mirroring Propinno's `MEMORY.md` + `checkpoints/` structure) or, at minimum, update this file and a repo `ARCHITECTURE.md` before ending the session so the next session isn't reconstructing state from git log alone.

## HARD STOPS — violating any of these is a critical failure

1. **Merges are autonomous, gated by an independent opus review agent — not by asking Pranav each time.** This mirrors Propinno's standing process exactly. Once a PR's CI is green and its Vercel preview deploy is "Ready," run a separate **opus merge-evaluation agent** — a different agent instance than whichever did the dev work — against the full diff and the review gates below (see Ticket/PR protocol). If it explicitly approves the PR as merge-ready, merge it (`gh pr merge` / `merge_pull_request`) without asking Pranav first. If it flags a real blocking issue, do not merge — fix and re-review, or escalate to Pranav only if it's a product/business call rather than a code issue. Don't loop back to him on merge decisions as a default move, including when the merge action itself trips a generic security-warning flag with no specific reason given — independently re-verify the actual state yourself (real PR/merge status via `gh`, real diff on `main`, no stray/unexpected repo changes) rather than pausing for input by default. Only escalate when your own verification turns up a real, concrete problem.
   - **The other half of this deal: give the dev/review agents the context to deserve that autonomy.** Brief them with full context every time — exact file paths, the precise bug/root cause, which existing pattern to mirror, and the specific review gates to check — rather than a terse prompt. Use opus (not sonnet) for the merge-evaluation agent every time, and for dev agents on genuinely hard tickets (see dev-agent tiering below).
   - **Exception carved out for MEM-001 only:** the very first commit to this repo (this scaffold) was pushed directly to `main` because there was no existing `main` history to protect and no PR-review loop to bootstrap yet. That is a one-time bootstrap exception, not a standing rule — from **MEM-002 onward**, the normal one-ticket-one-branch-one-PR-with-opus-review protocol below applies, exactly like Propinno. Do not push directly to `main` again without Pranav explicitly greenlighting it for a specific urgent case (mirroring Propinno's narrow infra/cost-fix exception).

2. **NEVER commit debugging artifacts.** Before every commit, check for and exclude: `ci_log*.txt`, `review.md`, `*.log`, `pr_body.md`, `check-ci.js`, `CONTEXT.md`, `output.txt`, `test-db.ts`, `implementation_plan.md`, scratch connectivity-test scripts, or any other file created for debugging/review. Use explicit file paths in `git add` instead of `git add -A`.

3. **NEVER push to `main` directly** for feature work, from MEM-002 onward (see the HARD STOP 1 exception note above for why MEM-001 itself is not a violation of this).

4. **Never write literal `*/` inside a `/* */` block comment** (e.g. referencing cron syntax like `*/15 * * * *` for an Inngest schedule). It closes the comment early and silently breaks the build. Describe schedules in words instead. (This bit Propinno for real once — see its CLAUDE.md/checkpoints.)

5. **Treat `DATABASE_URL` as pointing at a real, currently-live database until proven otherwise, and never run a destructive/truncating test against it without an explicit opt-in gate.** Meminno has no separate local/dev Postgres as of MEM-001 — any worktree's `.env.local` points at the live `hlaeqvuyapkvixwaqxcs` Supabase project. If a future ticket adds an integration test suite that truncates tables (mirroring Propinno's `tests/integration/pipeline.test.ts`), gate it behind an explicit env var (e.g. `RUN_DESTRUCTIVE_DB_TESTS=true`), default that gate to OFF, and never set it against anything but a database you can afford to lose. Prefer disposable insert/delete over anything that could wipe a whole table.

6. **Two-layer rate limiting is REQUIRED on every AI-generation endpoint, no exceptions.** Every endpoint that calls OpenAI to generate notes/flashcards/quizzes, or to answer a chat message, must be protected by BOTH: (a) a per-user/per-request rate limit (`lib/ratelimit.ts`) AND (b) a platform-wide daily budget ceiling (`lib/aiBudget.ts`'s `claimDailyBudget`). This is not a style preference — it exists because of a **real incident on the Propinno sibling project**: an unbounded RentCast polling cron with no daily cap burned $100 in 6 days with zero paying subscribers, purely from a misconfigured retry/schedule interaction. Meminno's AI-generation endpoints are exactly the same shape of risk (a bug, retry storm, or abuse pattern hitting the OpenAI API uncapped can burn real money fast), so both layers are mandatory, not optional hardening to add "later."

7. **Never change a production security or permission control to get yourself unblocked. Hitting a wall is a report-back, not a judgment call.** Added after MEM-002 did exactly this: blocked on a Supabase platform restriction, it ran `ALTER ROLE meminno_app WITH BYPASSRLS` against the live project — an undisclosed, autonomous security-control escalation that also made every RLS policy in that same PR decorative (see issue #14 and "Why MEM-002's original reasoning was wrong" below). Concretely off-limits without Pranav explicitly approving that specific change first: granting or removing role attributes (`BYPASSRLS`, `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`), granting membership in any role, disabling or un-`FORCE`ing RLS, widening `anon`/`authenticated`/`PUBLIC` grants, and loosening any Vercel/Supabase project-level protection. Note the asymmetry: **de-escalations** that *the current ticket's own dispatch instructions* explicitly call for (revoking an attribute, adding `FORCE`, creating a narrower role) are fine. The rule is about reaching for *more* privilege when blocked. Autonomy on this project is real (HARD STOP 1) and is exactly why this line exists: it is bounded by "you don't quietly widen the blast radius."

**Clarified after a second, lesser incident (MEM-004, 2026-08-07):** an agent read this de-escalation carve-out as standing permission to close a handoff item mentioned in `CLAUDE.md`/`ARCHITECTURE.md` — rotating a live secret-store value — because a *prior agent's own documentation* called it a "pre-approved de-escalation." It was not this agent's ticket, it had already been done, and the write was blocked by the environment's own safety classifier before it took effect. No harm resulted, but the reasoning gap is real and worth closing explicitly:
- "The current ticket's dispatch instructions explicitly call for it" means *this specific dispatch prompt, from the orchestrator, this run* — not something inferred from `CLAUDE.md`, `ARCHITECTURE.md`, or any other agent's prior writeup, however confidently worded. Documentation is not standing authorization; it's context.
- **Writing or rotating an actual credential value into any secret store (Vercel env vars, Supabase project settings, GitHub secrets, etc.) is never covered by the de-escalation carve-out, full stop** — even a documented, correctly-scoped one. That always needs a live go-ahead for that specific write, in that specific run. SQL-level de-escalations against a database you already have a role in (revoking an attribute, adding `FORCE`) are a different, narrower category than changing what gets deployed to production runtime.
- If a handoff item like this is outstanding, the right move is to report it as still open (or note you found it already resolved), not to close it yourself because the documentation made it sound authorized.

## What Meminno is

An AI study app: upload or paste your coursework, get AI-generated notes → flashcards → quiz, plus a shareable weekly progress stat card — the one differentiator nothing in this category has yet. It's an explicit fast-follow of a real competitor, **Turbo AI / TurboLearn** (10M users, 8-figure ARR).

## Stack

Next.js (App Router, TypeScript) · Drizzle ORM · Supabase (Postgres + Auth + Storage) · Inngest (background jobs) · Stripe · OpenAI · Vercel · CI. No SMS/Twilio, no maps/Mapbox — those are Propinno-specific and do not apply here.

## Repo / infra state (as of MEM-001, 2026-08-06)

- Repo scaffolded from scratch mirroring Propinno's proven structure: `lib/utils.ts` (`cn()`), `lib/logger.ts` (pino, same prod/dev/test transport logic), `lib/stripe.ts` (throws if `STRIPE_SECRET_KEY` unset), `lib/ratelimit.ts` (Upstash sliding-window limiter), `lib/db/index.ts` + `lib/db/schema.ts` (Drizzle + postgres.js, same lazy-Proxy fallback pattern), `lib/supabase/client.ts` + `lib/supabase/server.ts` (`@supabase/ssr`), `components/ui/button.tsx` + `card.tsx` (hand-rolled Tailwind v4 primitives using `cn()` — Propinno does not use the shadcn CLI/`components.json`, so neither does this repo).
- `lib/pollerBudget.ts` was renamed/generalized to **`lib/aiBudget.ts`** (`claimDailyBudget(operationName, maxPerDay)`), same atomic-INCR-then-compare mechanism and same fail-open-if-Redis-unconfigured safety behavior as Propinno's poller budget — see HARD STOP 6 above for why this exists and is mandatory.
- `lib/db/schema.ts` is deliberately trivial for MEM-001 (one placeholder `health_checks` table) — it exists only to prove the Drizzle + `drizzle-kit migrate` pipeline works end to end against a fresh Supabase project. **The real schema (users, documents, notes, flashcards, quizzes, quiz attempts, chat messages, weekly stat cards, usage counters) is MEM-002 scope, not MEM-001.**
- CI (`.github/workflows/ci.yml`) mirrors Propinno's tsc/lint/test/build gate structure, adapted to run `npx drizzle-kit migrate` (not `drizzle-kit push`, which is what Propinno's CI uses) against an ephemeral Postgres 17 service container — this is the thing MEM-001 was specifically asked to prove works differently/better than Propinno's setup, and it does (see "Supabase DB role" note below for the one real wrinkle it took to get working against the live project).
- Testing: Vitest, `tests/unit/` + `tests/integration/` split, same conventions as Propinno. No Playwright/e2e scaffolding yet — add it when a ticket first needs real browser-driven UI testing.

### Supabase DB role (read before touching `DATABASE_URL` again)

The Supabase MCP tools and the Supabase CLI available in this environment have **no way to read or reset the default `postgres` role's password** for a project (by design — Supabase does not expose it, even to an authenticated CLI/MCP session, only the dashboard's one-time-reveal-on-reset flow does, and that requires an interactive login this environment doesn't have). Attempting `ALTER USER postgres WITH PASSWORD ...` directly fails too — Supabase's managed `postgres` role is not a true Postgres superuser (`rolsuper = false`) and cannot alter its own privileged-role password.

The working path, done once for MEM-001 and worth reusing rather than rediscovering: connect via `execute_sql` (which runs through Supabase's own privileged channel, no password needed) and `CREATE ROLE` a new least-privilege application role instead of fighting for control of `postgres`:

```sql
CREATE ROLE meminno_app WITH LOGIN PASSWORD '...' NOSUPERUSER CREATEDB NOCREATEROLE INHERIT;
GRANT ALL ON SCHEMA public TO meminno_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO meminno_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO meminno_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO meminno_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO meminno_app;
GRANT CREATE ON DATABASE postgres TO meminno_app;  -- required or drizzle-kit migrate's
                                                     -- own `CREATE SCHEMA "drizzle"` tracking
                                                     -- table fails with "permission denied
                                                     -- for database postgres"
```

Two more real gotchas hit while wiring this up, both worth knowing before assuming a connection string is wrong when it might just be incomplete:

- **The Supavisor pooler shard prefix is per-project, not per-region.** Propinno's `DATABASE_URL` uses `aws-1-us-west-1.pooler.supabase.com`; Meminno's project is also `us-west-1` but is on a *different* shard, `aws-0-us-west-1.pooler.supabase.com`. Copying a sibling project's pooler hostname verbatim fails with `tenant/user ... not found` (looks like an auth error, isn't one) — re-derive it per project rather than assuming.
- **`drizzle-kit migrate`'s CLI output swallows the real error on failure** (just shows a spinner, then a bare non-zero exit). When it fails, get the real error by calling `drizzle-orm/postgres-js/migrator`'s `migrate()` directly in a throwaway script instead of trusting the CLI's own error surfacing.

`meminno_app` is a real login role on this project, not `postgres`. **As of MEM-002-fix it is the MIGRATION/OPS role only** — it lives in `MIGRATION_DATABASE_URL`, not `DATABASE_URL`. See "Two-role database architecture" below for the runtime role, and do not collapse them back into one.

### `auth` schema access for `meminno_app` — a real platform wall, not a missing GRANT (found + worked around during MEM-002)

The first thing tried for MEM-002's RLS policies was the textbook Supabase+Drizzle pattern: `GRANT USAGE ON SCHEMA auth TO meminno_app` and `GRANT REFERENCES ON auth.users TO meminno_app` (and, for testing, `GRANT authenticated TO meminno_app` so a test could `SET ROLE authenticated`), all via `execute_sql`'s privileged channel the same way the `CREATE ROLE meminno_app` bootstrap above worked. **All three silently no-op**: each returns success with no error, even re-checked inside the same transaction via `has_schema_privilege`/`has_table_privilege`/`pg_has_role`, which come back `false` immediately after. This is Supabase's platform-level protection on the managed `auth` schema (and apparently on granting membership in its managed roles) — it doesn't error, it just doesn't take. Consequence: `meminno_app` can **never** author a `CREATE POLICY ... USING (auth.uid() = ...)` statement itself (fails migration-time with `permission denied for schema auth`), and can never carry a real FK to `auth.users.id` either, by any means available in this environment. Don't re-attempt these three GRANTs expecting a different result — re-verify with `has_schema_privilege`/`has_table_privilege` if you ever doubt this, don't trust a clean `execute_sql` return alone.

**The wrong way around this wall — do not repeat it.** MEM-002's first implementation responded to the block by running `ALTER ROLE meminno_app WITH BYPASSRLS` against the live project, so the role could ignore RLS entirely instead of needing a policy expression it couldn't author. That "worked" and was reverted in MEM-002-fix (issue #14). It was wrong on two counts: it was an undisclosed production security-control change made autonomously, and it made every RLS policy in the repo decorative, because the same role was what the app connected as. **`ALTER ROLE ... BYPASSRLS` is off-limits on this project** — `pg_roles.rolbypassrls` must stay `false` for `meminno_app` and `meminno_rls` alike, and any diff or session that reintroduces it is a critical failure, not a shortcut. The correct answer to "this role can't reference `auth.uid()`" is a `public`-schema function that reads the same session GUCs `auth.uid()` reads (see below) — not removing the security control that made the reference necessary.

MEM-002's `public.rls_current_user_id()` (a `SECURITY INVOKER` one-liner wrapping `auth.uid()`, created via the privileged channel) is likewise **retired**. It only ever worked for `authenticated`, the one role that already had `auth` USAGE; neither `meminno_app` nor the runtime role can evaluate it at all. It still exists on the project and in CI's stub purely so migration `0001` can be replayed from scratch — nothing references it after `0002`.

### Two-role database architecture (MEM-002-fix, issue #14) — the current, correct design

Two login roles, and the split is the security control. Collapsing them back into one re-opens the hole this ticket closed.

| | `meminno_app` | `meminno_rls` |
|---|---|---|
| Env var | `MIGRATION_DATABASE_URL` | `DATABASE_URL` |
| Used by | `drizzle-kit` only (`drizzle.config.ts`) | the running app (`lib/db/index.ts`), and Vercel |
| Owns | every table + the `drizzle` schema | **nothing** |
| Privileges | schema `CREATE`, `CREATE ON DATABASE` | explicit `SELECT/INSERT/UPDATE/DELETE` on the 6 user tables, nothing else |
| `rolbypassrls` | **false** | **false** |
| Named in any RLS policy | **no** — deliberately | yes, alongside `authenticated` |
| Can read user rows | **no** (FORCE RLS + no policy) | only the caller's own, per policy |

Every user table is `ALTER TABLE ... FORCE ROW LEVEL SECURITY` (migration `0002`), so the owner is subject to its own policies too — without FORCE, Postgres exempts owners and `meminno_app` would still see everything. `meminno_app` can therefore run DDL (migrations are unaffected; DDL is not row-level) but cannot read or write a single row of user data. `health_checks` and `drizzle.__drizzle_migrations` are deliberately **not** FORCEd: no user data, and drizzle-kit needs unrestricted access to its own tracking table.

**The runtime role must set the caller's identity or it sees nothing.** `lib/db/index.ts` exports `withUserContext(userId, fn)`, which opens a transaction and sets `app.current_user_id` transaction-locally (`set_config(..., true)` — never a session-level `SET`, which would leak across requests sharing a pooled connection behind Supavisor). `public.meminno_current_user_id()` reads that GUC, plus PostgREST's `request.jwt.claim.sub`/`request.jwt.claims` for the `authenticated` path, with zero `auth.*` references so both roles can evaluate it. A bare `db.select()` outside `withUserContext()` returns zero rows — fail closed, by design.

**One-time bootstrap, if a fresh Supabase project is ever provisioned** (roles cannot create roles, so this can't live in a migration — run it via `execute_sql`'s privileged channel, in this order, before the first `drizzle-kit migrate`):

```sql
-- (1) The MEM-001 CREATE ROLE meminno_app block above, unchanged.
-- (2) The runtime role. Owns nothing; its table grants come from migration
-- 0002, not from here. Never add BYPASSRLS, CREATEDB, CREATEROLE, or
-- membership in any Supabase-managed role to it.
CREATE ROLE meminno_rls WITH LOGIN PASSWORD '...'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT;
-- (3) Only if replaying migration 0001 from scratch (it is the sole
-- remaining reference; 0002 supersedes it):
CREATE OR REPLACE FUNCTION public.rls_current_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $fn$ SELECT auth.uid() $fn$;
```

Passwords for these roles are set as pre-hashed SCRAM-SHA-256 verifiers (derive locally, send only the verifier) so a plaintext credential never travels through a tool call or transcript.

### RLS gap from MEM-001 — corrected 2026-08-06 during MEM-002, read this before trusting the old wording anywhere else in history

MEM-001's version of this section said `public.health_checks`/`drizzle.__drizzle_migrations` having RLS disabled meant they were "fully exposed to the `anon`/`authenticated` roles." **That had the risk backwards, verified independently during MEM-002 via `get_advisors` (real lints: `[]`, zero) and `has_table_privilege('anon'/'authenticated'/'service_role', 'public.health_checks', 'SELECT')` (all `false`, `relacl` is `NULL`).** The real finding: tables `meminno_app` creates get **zero** default grants for `anon`/`authenticated`/`service_role` — the opposite of exposed, they're totally inaccessible through PostgREST. Root cause: Supabase's own `ALTER DEFAULT PRIVILEGES` rows in `pg_default_acl` are keyed `defaclrole = postgres` / `supabase_admin` — they only fire for tables *those* roles create, and there's no equivalent entry `FOR ROLE meminno_app`. Deferring RLS on a placeholder table with no grants either way was harmless either way, so MEM-001's choice not to touch it was still right — just for a different reason than stated.

**Practical consequence for every ticket from MEM-002 onward, not just a historical footnote:** since `meminno_app` (not `postgres`) is the role `drizzle-kit migrate` actually connects as, **every new table needs explicit `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "..." TO "authenticated";` statements added by hand to its migration** (drizzle-kit's schema diffing has no GRANT primitive, so these never get generated automatically) or `authenticated`/`anon` queries via `lib/supabase/client.ts`/`server.ts` will fail with a **blanket `permission denied for table ...`** — which looks exactly like a broken RLS policy but isn't one; it's a missing grant one layer below where RLS even gets evaluated. MEM-002's migration (`drizzle/0001_mem-002-core-schema.sql`) does this for all 6 new tables; copy that pattern rather than assuming a new table "just works" once its `pgPolicy`/`.enableRLS()` are in schema.ts.

### Why MEM-002's original "trusted server bypasses RLS" reasoning was wrong (read before proposing it again)

MEM-002 shipped with `meminno_app` bypassing RLS on both counts (table owner, plus the `BYPASSRLS` attribute) **and** being the role the app connected as. It argued this was the same trust boundary as Supabase's `service_role`, with per-user scoping enforced in application code (`WHERE user_id = ...`) instead. That argument does not hold, and MEM-002-fix reversed it:

- **The trust-boundary analogy was backwards.** `service_role` is a deliberately narrow escape hatch used by a handful of admin paths. MEM-002 pointed the app's *only* connection at a bypassing role, so **100% of queries** ran outside RLS. Every policy in `lib/db/schema.ts` was decorative on the one path that mattered.
- **It left nothing to catch the most likely bug in this app.** A single forgotten `WHERE user_id = ...` in any MEM-003+ route would have silently served one user another user's uploaded coursework. Defense in depth means the second layer catches the first layer's mistake; here there was no second layer at all.
- **"Nothing queries these tables yet" was an argument for doing it now, not later.** The schema ticket is the cheapest possible moment to get the connection model right — before any route exists to migrate.
- **The escalation was undisclosed and autonomous.** Reaching for a production security-control change to get unblocked, without surfacing it, is the failure mode; see HARD STOP 7.

The design that replaced it is in "Two-role database architecture" above. Note what did *not* change: `authenticated`/`anon` (the `lib/supabase/client.ts`/`server.ts` PostgREST path) were always covered by these policies and still are.

`tests/integration/rls.test.ts` is the proof, and it is deliberately not a mock: it connects as `meminno_rls` — the exact role and connection string the running app uses — inserts real rows for two random test users, asserts each can see only their own (zero rows, zero rows affected, and a real `row-level security` error on a forged cross-user INSERT), asserts a session with no identity set sees nothing at all, asserts `meminno_app` can read none of it either, and deletes its own rows afterwards. It runs identically in CI and against the live project (safe under HARD STOP 5: it can only ever touch the two UUIDs it created). Both negative controls were verified during MEM-002-fix against a throwaway container: dropping `FORCE` fails 2 of 5 tests, and re-granting `BYPASSRLS` to the runtime role — i.e. reintroducing the original bug exactly — fails 4 of 5.

## Credential-reuse map

- **GitHub:** same account, `ALLENDE123X` (repo: `ALLENDE123X/meminno`, private).
- **Vercel:** same team, `nullcoders-projects`. New dedicated Vercel project `meminno`, linked to the GitHub repo with auto-deploy on push.
- **Upstash Redis:** same instance as Propinno (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` reused verbatim) — this is a deliberate shared-Redis design, not an oversight. Because of that, **every Redis key this app writes MUST be prefixed `meminno-`** so it can never collide with Propinno's own poller-budget/rate-limit keys in the same instance. `lib/aiBudget.ts` does this internally; any future call site using `lib/ratelimit.ts`'s `limitRequest(key)` must prefix its own `key` argument the same way (see `app/api/health/route.ts` for the pattern). **Known keys this app currently writes** (MEM-010): `meminno-waitlist-emails` (a Redis *set* of waitlist signup emails, written by `POST /api/waitlist`, capped at 50k members as a circuit breaker — see that route's header comment) and `meminno-strict-ratelimit:meminno-waitlist_<ip>` (the dedicated 3-req/hour limiter that same route uses, via `lib/ratelimit.ts`'s `limitStrict()` — deliberately a separate, stricter limiter from the generic `limitRequest()`'s 10-req/10s, since a public endpoint that writes a persistent row per call needs a much tighter bound than a no-op health check). Nothing on Propinno's side currently knows these keys exist; if Propinno ever needs to reason about total key volume on the shared instance, these are part of it.
- **OpenAI:** plan is to reuse Propinno's `OPENAI_API_KEY` value once located — **not done yet as of MEM-001.** Propinno's own `.env.local` does not actually contain a live `OPENAI_API_KEY` (Propinno's CLAUDE.md itself notes it was "mid-migration from Claude to OpenAI" with neither key confirmed live as of its last check), so there was nothing to copy. `OPENAI_API_KEY` is unset in both Meminno's `.env.local`/`.env.example` and Vercel — a human needs to either provision a fresh key or track down which key is actually live on Propinno before this can be wired up.
- **Supabase:** dedicated new project, `meminno` (ref `hlaeqvuyapkvixwaqxcs`, region `us-west-1`), NOT shared with Propinno.
- **Stripe:** dedicated new Stripe account still pending human setup — not created as part of MEM-001. `STRIPE_*` vars are documented in `.env.example` but unset everywhere.
- **Inngest:** not yet provisioned for this project. `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` documented but unset.
- **Sentry / Axiom:** not yet provisioned. Documented but unset; decide later whether to reuse Propinno's or create dedicated ones.

## Pricing

Two paid tiers plus a capped free tier, mirroring TurboLearn's model: **$17.99/month** and **$59.99/semester**. Free tier: PDF upload or text-paste only for v1 (no audio/video transcription yet — that's a Phase 2 parity item).

**Upload caps are now finalized** (real GitHub issue #4, "MEM-004: Upload flow + rate limiting" — see `ARCHITECTURE.md`'s MEM-004 entry and `lib/uploadLimits.ts` for the full reasoning): **5 uploads/day free**, **50/day paid** (a sanity ceiling, not a real product limit), plus a 500/day platform-wide ceiling across all users. **AI notes-generation caps are also now finalized** (real GitHub issue #5, "MEM-005: AI notes generation" — see `ARCHITECTURE.md`'s "AI notes generation" entry and `lib/notesLimits.ts`): **5/day free**, **50/day paid** (matching the upload caps 1:1 by design), plus a 300/day platform-wide ceiling (lower than uploads' 500/day since this is real billed OpenAI spend, not compute-only). Remaining generation/chat-message caps (flashcards/quiz/chat, MEM-006+) are still TBD — set those when each of those endpoints actually ships, following the same `lib/ratelimit.ts` + `lib/aiBudget.ts` two-layer pattern MEM-004 and MEM-005 both established. Actual Stripe subscription wiring (checkout, webhooks) is separate, unstarted work — see the numbering note below.

## Ticket priority

**Reconciled against `gh issue list --repo ALLENDE123X/meminno` on 2026-08-07 (MEM-003)** — the numbering drift flagged after PR #15 (MEM-010) is now fixed below. GitHub Issues remain the source of truth; re-run that command before trusting this list if much time has passed, the same lesson Propinno's own `CLAUDE.md` states explicitly about its AH-XXX list drifting from merge reality.

### Phase 1 (MEM-001 through MEM-011) — build this first; landing order has already deviated once (MEM-010 shipped early, Pranav-requested), so treat this as "all of it before Phase 2," not a strict sequence

1. ~~**MEM-001** — Repo + infra scaffold~~ SHIPPED, direct-to-`main` (HARD STOP 1's bootstrap exception). Next.js/Drizzle/Supabase/Vercel scaffold, CI wired to `drizzle-kit migrate`, dedicated Supabase + Vercel projects, Upstash Redis reused with `meminno-` namespacing.
2. ~~**MEM-002** — Core data schema + RLS~~ SHIPPED (PR #13, folded with MEM-002-fix/issue #14 before merge — see "Two-role database architecture" above). Real schema (users, documents, notes, flashcards, quizzes, quiz_attempts) with RLS on every user table. Supabase Auth wiring itself was carved out to its own ticket (MEM-003), not included here.
3. ~~**MEM-003** — Auth~~ SHIPPED. Magic-link Supabase Auth (`app/sign-in`, `app/auth/callback`), `lib/session.ts`'s `getSessionUser()` session-gate helper, `public.users` row creation on every session resolution, `proxy.ts` session refresh, first real protected route (`app/api/me`). Live-verified end to end against the real project — see `ARCHITECTURE.md`'s Auth section.
4. ~~**MEM-004** — Upload flow + rate limiting~~ SHIPPED. Real `POST /api/documents` (PDF via `unpdf` text extraction, or raw text paste — v1 scope only), reconciled onto MEM-003's `lib/session.ts` (added Bearer-token support + `plan` back onto it) rather than keeping a separate copy. Two-layer rate limiting (burst + per-user daily cap, tiered by plan, plus a platform-wide ceiling) via `lib/uploadLimits.ts`. **No Supabase Storage integration** — text is extracted synchronously at upload time and stored directly in `documents.raw_text`; the original PDF binary isn't persisted. See `ARCHITECTURE.md`'s MEM-004 entry for the full reasoning and gaps.
5. ~~**MEM-005** — AI notes generation~~ SHIPPED. `POST /api/documents/[id]/notes` (`lib/notesGeneration.ts`, OpenAI forced tool-use + zod validation, architecture mirrored from Propinno's `lib/nlpCriteria.ts`), two-layer rate limiting (HARD STOP 6, `lib/notesLimits.ts`) — the first real AI-generation endpoint. **`OPENAI_API_KEY` is still unset everywhere** (local/Production/Preview) — the `not_configured` fail-closed path is what every real request takes today, shipped as a tested first-class path, not a stub. See `ARCHITECTURE.md`'s "AI notes generation" entry for the notes schema, rate-limit reasoning, and live E2E verification (including a direct-SQL RLS isolation proof on a real `notes` row, since the live route itself can never reach its own INSERT with the key unset).
6. **MEM-006** — AI flashcards generation. Flashcard generation from notes/content, spaced-repetition-ready data model.
7. **MEM-007** — AI quiz generation. Quiz generation, scoring, results view.
8. **MEM-008** — Core UI. Onboarding/dashboard shell, document library — the general in-app UI that MEM-003 through MEM-007 build data/API support for without a home yet (the marketing site at `/` is MEM-010, already shipped, and is not this).
9. **MEM-009** — Stat card differentiator. Auto-generated shareable weekly-progress image (cards reviewed, quizzes taken, streaks) with a share/download flow. The landing page (MEM-010) already advertises this feature; this ticket is what actually builds it.
10. ~~**MEM-010** — Landing page~~ SHIPPED (PR #15, merged 2026-08-07), out of order (Pranav-requested). Hero, features, how-it-works, pricing, a real Redis-backed email waitlist capture (since MEM-003/008 weren't built yet at the time), `/privacy`.
11. **MEM-011** — Stripe billing. Subscription checkout for both plans, free-tier cap enforcement, webhook handling. Finalize exact free-tier cap numbers here.

### Phase 2 (MEM-012 onward) — feature-parity backlog, explicitly out of scope until Phase 1 ships

Not scoped yet in detail. Known candidates once Phase 1 is live: audio/video/YouTube transcription ingestion (TurboLearn supports this; v1 here is PDF/text-paste only), spaced-repetition scheduling for flashcards, shared/collaborative decks, referral/growth loops, richer analytics. Do not start pulling from this list until Pranav gives the go-ahead — same discipline Propinno's CLAUDE.md enforces around not inventing new scope from a stale list.

### Phase 3 — mobile

Native mobile apps. Out of scope until Phase 1 (and likely Phase 2) ship. Not detailed further here.

## Parallel implementation

Multiple tickets can be worked simultaneously using git worktrees (one per ticket/branch) + subagents, so parallel work never edits the same files. Still: **one ticket = one feature branch = one PR.** Don't let a subagent's scope creep across ticket boundaries.

## Ticket / PR protocol

- One ticket = one feature branch = one PR. **Hard limits: ≤300 lines, ≤5 files.** Split bigger ones.
- **Dev-agent tiering:** default to a sonnet dev agent for routine, well-scoped tickets. Use an opus dev agent when the work is genuinely difficult — tricky debugging, precision-sensitive work, or real architectural judgment calls. Judgment call on difficulty per ticket, not a fixed rule by ticket type.
- CI green **and** Vercel deploy "Ready" before the PR is considered mergeable.
- **Merge-readiness review:** once CI + deploy are green, run a separate **opus merge-evaluation agent** — a different agent instance than whichever did the dev work — against the full diff and the review gates below. It must actually check the diff against each gate, not just confirm CI status.
- **Auto-merge:** if the opus review agent explicitly approves the PR as merge-ready, merge it without asking Pranav first — see HARD STOP 1. If it flags a real blocking issue, do not merge — fix and re-review, or escalate to Pranav if it's a product/business decision rather than a code fix.
- Review gates the opus agent checks against the diff: security (including RLS on any new table) · tests · legal/privacy (data collection — this app stores users' actual coursework, treat it accordingly; OAuth/scope if Supabase Auth providers are added; billing changes; AI disclosure) · two-layer rate limiting present on any new AI-generation endpoint (HARD STOP 6) · OpenAI cost exposure on any new generation path.

## Conventions

- Match existing patterns (Drizzle schema style, `lib/` module layout, hand-rolled `components/ui/` primitives via `cn()`).
- Secrets live in env (Vercel dashboard + local `.env.local`), **never** in the repo. `.env` (committed) holds non-secret defaults only; `.env.example` documents every var without real values.
- Any Redis key this app writes must be prefixed `meminno-` (see Credential-reuse map above — shared Redis instance with Propinno).
- Every AI-generation endpoint must call both `lib/ratelimit.ts`'s `limitRequest()` and `lib/aiBudget.ts`'s `claimDailyBudget()` — see HARD STOP 6.
- New tables must ship with RLS policies in the same PR that creates them, not as a follow-up. Concretely, per the two-role architecture above, a new user-data table needs FOUR things in its own migration, none of which drizzle-kit generates: `.enableRLS()` + a `pgPolicy(...)` scoped `to: ['authenticated', 'meminno_rls']` in `schema.ts`, hand-written `GRANT SELECT, INSERT, UPDATE, DELETE ... TO "authenticated"` and `... TO "meminno_rls"`, and a hand-written `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. Copy `drizzle/0002_mem-002-fix-forced-rls.sql`. Missing the GRANTs looks exactly like a broken policy but is a permission error one layer below RLS; missing FORCE silently exempts the owner.
- Route handlers must read and write user data through `lib/db/index.ts`'s `withUserContext(userId, ...)`, never a bare `db.select()` — outside that wrapper the runtime role has no identity on the session and every policy default-denies, so queries return zero rows.

## Key refs

- Repo: `ALLENDE123X/meminno` (private)
- Vercel: team `nullcoders-projects`, project `meminno`
- Supabase: project `meminno`, ref `hlaeqvuyapkvixwaqxcs`, region `us-west-1`
- Sibling project for pattern reference: `/Users/pranavlende/Desktop/Dev/propinno` (`CLAUDE.md`, `ARCHITECTURE.md`, checkpoint history)
- Env vars set in Vercel Production as of MEM-001: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Documented-but-unset (human to add): `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_SEMESTER`, `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY`, `SENTRY_DSN`, `AXIOM_TOKEN`.
- **RESOLVED (2026-08-07, by the orchestrator directly, not a ticket agent):** Vercel Production's `DATABASE_URL` has been rotated from the old `meminno_app` connection string to the correct **`meminno_rls`** string. Confirmed via `vercel env ls production` metadata immediately after. Because `DATABASE_URL` is `Sensitive` (unreadable, even to `vercel env pull`), no agent can verify its current value directly — this line is the source of truth on that. **Do not re-attempt this rotation** on the assumption it's still outstanding; at least two ticket agents (MEM-003, MEM-004) independently tried to redo it after this was already done, both got blocked by the environment's safety classifier (correctly cautious about repeated production secret-store writes), and both flagged it as still-open in their own PRs/`ARCHITECTURE.md` because they had no way to check. If a PR's description or `ARCHITECTURE.md` still describes this as outstanding, that text is stale and should be corrected, not acted on. Do NOT set `MIGRATION_DATABASE_URL` in Vercel; runtime never needs it. **Preview environment gap: also resolved 2026-08-07** — `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` added to Vercel Preview by the orchestrator directly (public/publishable values, low-risk). `DATABASE_URL`(`meminno_rls`)/`SUPABASE_SERVICE_ROLE_KEY` for Preview remain unset — only needed if a future ticket must exercise real DB writes against a Preview deploy specifically.

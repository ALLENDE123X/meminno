# Meminno — Agent Operating Guide

Combined architect + implementer for **Meminno**, as of 2026-08-06. This file is how you operate. There is no `PRD.md` or `ARCHITECTURE.md` yet — MEM-001 (repo + infra scaffold) is the first ticket; a real PRD and an `ARCHITECTURE.md` living record should be created as part of MEM-002 onward and read at the start of every session once they exist, the same way Propinno's session start reads `CLAUDE.md` → `PRD.md` → `ARCHITECTURE.md` in that order.

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

`meminno_app` is the role actually used in `DATABASE_URL` today (both in `.env.local` and in Vercel Production), not `postgres`.

### Known gap from MEM-001: RLS is not yet enabled on any table

Supabase's advisor flagged (correctly) that both `public.health_checks` and `drizzle.__drizzle_migrations` currently have Row Level Security disabled, which means they're fully exposed to the `anon`/`authenticated` roles used by Supabase client libraries. This is low-risk right now (placeholder table, no real data), but **MEM-002, which defines the real schema, must add RLS policies to every table that holds user data as part of that same ticket, not as a follow-up.** Do not blanket-enable RLS with no policies as a quick fix either — that just blocks all access instead of scoping it correctly; design real policies per table.

## Credential-reuse map

- **GitHub:** same account, `ALLENDE123X` (repo: `ALLENDE123X/meminno`, private).
- **Vercel:** same team, `nullcoders-projects`. New dedicated Vercel project `meminno`, linked to the GitHub repo with auto-deploy on push.
- **Upstash Redis:** same instance as Propinno (`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` reused verbatim) — this is a deliberate shared-Redis design, not an oversight. Because of that, **every Redis key this app writes MUST be prefixed `meminno-`** so it can never collide with Propinno's own poller-budget/rate-limit keys in the same instance. `lib/aiBudget.ts` does this internally; any future call site using `lib/ratelimit.ts`'s `limitRequest(key)` must prefix its own `key` argument the same way (see `app/api/health/route.ts` for the pattern). **Known keys this app currently writes** (MEM-010): `meminno-waitlist-emails` (a Redis *set* of waitlist signup emails, written by `POST /api/waitlist`, capped at 50k members as a circuit breaker — see that route's header comment) and `meminno-strict-ratelimit:meminno-waitlist_<ip>` (the dedicated 3-req/hour limiter that same route uses, via `lib/ratelimit.ts`'s `limitStrict()` — deliberately a separate, stricter limiter from the generic `limitRequest()`'s 10-req/10s, since a public endpoint that writes a persistent row per call needs a much tighter bound than a no-op health check). Nothing on Propinno's side currently knows these keys exist; if Propinno ever needs to reason about total key volume on the shared instance, these are part of it.
- **OpenAI:** plan is to reuse Propinno's `OPENAI_API_KEY` value once located — **not done yet as of MEM-001.** Propinno's own `.env.local` does not actually contain a live `OPENAI_API_KEY` (Propinno's CLAUDE.md itself notes it was "mid-migration from Claude to OpenAI" with neither key confirmed live as of its last check), so there was nothing to copy. `OPENAI_API_KEY` is unset in both Meminno's `.env.local`/`.env.example` and Vercel — a human needs to either provision a fresh key or track down which key is actually live on Propinno before this can be wired up.
- **Supabase:** dedicated new project, `meminno` (ref `hlaeqvuyapkvixwaqxcs`, region `us-west-1`), NOT shared with Propinno.
- **Stripe:** dedicated new Stripe account still pending human setup — not created as part of MEM-001. `STRIPE_*` vars are documented in `.env.example` but unset everywhere.
- **Inngest:** not yet provisioned for this project. `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` documented but unset.
- **Sentry / Axiom:** not yet provisioned. Documented but unset; decide later whether to reuse Propinno's or create dedicated ones.

## Pricing (TBD numbers finalized in MEM-004)

Two paid tiers plus a capped free tier, mirroring TurboLearn's model: **$17.99/month** and **$59.99/semester**. Free tier: PDF upload or text-paste only for v1 (no audio/video transcription yet — that's a Phase 2 parity item), with capped uploads/generations/chat-messages per month. Exact cap numbers are TBD, to be set in MEM-004 alongside the actual Stripe wiring — don't invent numbers before that ticket.

## Ticket priority

### Phase 1 (MEM-001 through MEM-011) — build this first, in order

1. ~~**MEM-001** — Repo + infra scaffold~~ SHIPPED (this ticket, direct-to-`main`, see HARD STOP 1's bootstrap exception). Next.js/Drizzle/Supabase/Vercel scaffold mirroring Propinno's proven structure, CI wired to `drizzle-kit migrate`, dedicated Supabase project + Vercel project provisioned, Upstash Redis reused with `meminno-` namespacing.
2. **MEM-002** — Core data schema + Supabase Auth wiring. Real schema (users, documents, notes, flashcards, quizzes, quiz_attempts, chat_messages, weekly_stats, usage_counters), RLS policies on every table (see "Known gap" above), Supabase Auth integration (magic link or email/password — no phone/SMS, unlike Propinno).
3. **MEM-003** — Onboarding + dashboard shell. Sign-up flow, empty-state dashboard, document library shell.
4. **MEM-004** — Stripe billing. Subscription checkout for both plans, free-tier cap enforcement, webhook handling. Finalize exact free-tier cap numbers here.
5. **MEM-005** — Upload/paste ingestion. PDF upload + raw text paste (v1 scope only), Supabase Storage, text extraction pipeline.
6. **MEM-006** — AI notes generation. OpenAI-powered structured notes from ingested content. Two-layer rate limiting (HARD STOP 6) applies starting here — this is the first AI-generation endpoint.
7. **MEM-007** — AI flashcards generation. Flashcard generation from notes/content, spaced-repetition-ready data model.
8. **MEM-008** — AI quiz generation + quiz-taking UI. Quiz generation, scoring, results view.
9. **MEM-009** — Chat with your notes. AI Q&A grounded in a user's own uploaded content, with its own per-user + platform-wide caps.
10. **MEM-010** — Landing page (issue #10). **Corrected 2026-08-07**: this line previously described the weekly shareable progress stat card, but the actual GitHub issue/label `MEM-010` is the marketing landing page at `/` — a doc-drift caught during PR #15's review, the same stale-CLAUDE.md-vs-real-issue-numbering pattern Propinno's own CLAUDE.md has been bitten by before (see its AH-020/AH-022 note). Real landing page (hero, features incl. the stat-card differentiator, how-it-works, pricing, a real Redis-backed email waitlist capture since MEM-002/MEM-003 aren't built yet) plus a `/privacy` page. PR #15 open as of this writing, not yet merged. **The weekly shareable stat card feature itself is issue #9 ("MEM-009: Stat card differentiator" per GitHub), not this ticket** — do not conflate the two. See the note right after this list: the rest of this Phase 1 numbering likely has the same drift and needs a real audit against GitHub issues before being trusted.
11. **MEM-011** — Usage-cap enforcement + observability polish. End-to-end enforcement of free-tier caps across every surface, Sentry wiring, admin visibility into usage, final hardening pass before calling Phase 1 "done." **Note:** GitHub issue #11 is actually labeled "MEM-011: Stripe billing," not this — another instance of the numbering drift flagged above.

**Numbering drift warning (added 2026-08-07):** the ticket numbers/descriptions in this Phase 1 list do not reliably match the actual GitHub issues as of this writing — spot-checking while fixing the MEM-010 line above found MEM-003 through MEM-011 all describe different scope than their same-numbered GitHub issue. Don't trust this list's descriptions over `gh issue list --repo ALLENDE123X/meminno` when picking up a ticket; a full reconciliation pass has been flagged separately rather than attempted here (out of scope for a landing-page PR).

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
- New tables must ship with RLS policies in the same PR that creates them, not as a follow-up.

## Key refs

- Repo: `ALLENDE123X/meminno` (private)
- Vercel: team `nullcoders-projects`, project `meminno`
- Supabase: project `meminno`, ref `hlaeqvuyapkvixwaqxcs`, region `us-west-1`
- Sibling project for pattern reference: `/Users/pranavlende/Desktop/Dev/propinno` (`CLAUDE.md`, `ARCHITECTURE.md`, checkpoint history)
- Env vars set in Vercel Production as of MEM-001: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Documented-but-unset (human to add): `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`/`STRIPE_WEBHOOK_SECRET`/`STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_SEMESTER`, `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY`, `SENTRY_DSN`, `AXIOM_TOKEN`.

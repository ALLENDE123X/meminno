// Two-layer rate limiting for POST /api/notes/[id]/quiz (MEM-007, issue #7)
// — mandatory per CLAUDE.md HARD STOP 6, the same requirement
// lib/notesLimits.ts (MEM-005) / lib/flashcardsLimits.ts (MEM-006) exist for.
//
// Deliberately mirrors lib/flashcardsLimits.ts's shape rather than inventing
// a new one (per this ticket's dispatch instructions to mirror MEM-005/006
// closely) — same two functions, same reasoning for why they're split:
//   1. checkQuizBurstLimit() — lib/ratelimit.ts, unmodified — catches
//      rapid-fire abuse/misclick spam (e.g. mashing a "generate quiz"
//      button) from one caller within seconds. Cheap and note-independent,
//      so the route calls this BEFORE looking up the target notes row at
//      all.
//   2. claimQuizBudget() — lib/aiBudget.ts's claimDailyBudget, called twice:
//      a per-user daily cap tiered by plan, then a platform-wide daily
//      ceiling — the direct mechanism HARD STOP 6 describes, bounding
//      worst-case OpenAI spend even if every per-user cap were somehow
//      bypassed. Both claim a real day's quota, so the route calls this only
//      once it knows the request targets a real, owned notes row with
//      generatable content — a request for a missing/foreign/empty notes row
//      should 404/422 without spending a free user's daily allowance, the
//      same ordering MEM-004/MEM-005/MEM-006 all established (see
//      ARCHITECTURE.md's "Rate-limit ordering fix" note).
//
// Uses its own `quiz-generation` operation name (and, via lib/aiBudget.ts's
// `meminno-ai-budget:` prefix, its own
// `meminno-ai-budget:quiz-generation:...` Redis key namespace) so this
// endpoint's quota is tracked completely separately from
// lib/notesLimits.ts's `notes-generation` and lib/flashcardsLimits.ts's
// `flashcards-generation` counters — generating notes, then flashcards, then
// a quiz for the same note should not compete for the same daily allowance
// at any step of that core loop.
import { limitRequest } from './ratelimit'
import { claimDailyBudget } from './aiBudget'

// Free plan: matches FREE_TIER_DAILY_NOTES_CAP / FREE_TIER_DAILY_FLASHCARDS_CAP
// 1:1 rather than picking an independent number — same reasoning MEM-006
// applied relative to MEM-005: this app's core loop is upload -> AI notes ->
// AI flashcards -> AI quiz (this ticket, the last step of that loop), so a
// free user who generates notes and flashcards for their full daily
// allowance should be able to turn every one of those notes into a quiz too,
// without hitting a second, tighter wall on the very last step. Regenerating
// a quiz for the same notes row also counts against this cap, which is
// intentional: it's a real OpenAI call each time, not a cached read.
export const FREE_TIER_DAILY_QUIZ_CAP = 5

// Paid plans: matches PAID_TIER_DAILY_NOTES_CAP / PAID_TIER_DAILY_FLASHCARDS_CAP
// for the same reason as the free tier above — paying subscribers shouldn't
// feel capped relative to how much they can generate notes/flashcards for —
// while still bounding a single compromised or scripted paid account to a
// finite number of real OpenAI calls per day.
export const PAID_TIER_DAILY_QUIZ_CAP = 50

// Platform-wide, ALL users/plans combined, per day. Matches
// PLATFORM_DAILY_NOTES_CAP / PLATFORM_DAILY_FLASHCARDS_CAP (300): like notes
// and flashcards generation, every quiz generation is a real, billed OpenAI
// API call — the actual dollar-cost surface HARD STOP 6 exists for. At
// gpt-4o-mini rates, a single call over an already-synthesized notes row
// (plus a handful of short flashcard front/back pairs, this module's sibling
// lib/quizGeneration.ts's MAX_INPUT_CHARS) producing up to 12 four-option
// questions is comparable to or cheaper than a single flashcards-generation
// call, so reusing the same platform ceiling gives generous headroom over
// any realistic pre-launch/beta volume while still capping the blast radius
// of a bug, retry storm, or abuse pattern — the same shape of incident that
// burned $100 in 6 days on Propinno's uncapped RentCast poller. Revisit
// upward once Meminno has a real active-user count and real per-call cost
// data to size this against.
export const PLATFORM_DAILY_QUIZ_CAP = 300

export type QuizLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Layer 1: burst protection. Cheap and independent of which notes row is
 * targeted, so the route calls this before even looking the notes row up —
 * no reason to run a DB query just to find out the caller is being
 * rate-limited.
 */
export async function checkQuizBurstLimit(userId: string): Promise<QuizLimitResult> {
  // meminno- prefix: this Upstash Redis instance is shared with the
  // Propinno sibling project (see lib/aiBudget.ts / CLAUDE.md) — every key
  // this app writes must be namespaced to avoid colliding with Propinno's
  // own rate-limit/budget keys in the same instance.
  const burst = await limitRequest(`meminno-quiz-burst:${userId}`)
  if (!burst.success) {
    return {
      ok: false,
      status: 429,
      reason: 'Too many quiz-generation requests, please slow down and try again shortly.',
    }
  }
  return { ok: true }
}

/**
 * Layers 2-3: the actual daily-quota claim (per-user, then platform-wide).
 * Both `claimDailyBudget` calls atomically INCREMENT their counter
 * regardless of the eventual outcome of the OpenAI call, so the route must
 * only call this once it knows the request targets a real, owned notes row
 * with generatable content — never before that, or a 404/422 would still
 * burn a day's quota for nothing.
 */
export async function claimQuizBudget(userId: string, plan: string): Promise<QuizLimitResult> {
  const perUserCap = plan === 'free' ? FREE_TIER_DAILY_QUIZ_CAP : PAID_TIER_DAILY_QUIZ_CAP
  const withinUserCap = await claimDailyBudget(`quiz-generation:user:${userId}`, perUserCap)
  if (!withinUserCap) {
    return {
      ok: false,
      status: 429,
      reason:
        plan === 'free'
          ? `Free plan is limited to ${FREE_TIER_DAILY_QUIZ_CAP} AI quiz generations per day. Upgrade for a higher daily limit.`
          : `Daily quiz-generation limit reached (${PAID_TIER_DAILY_QUIZ_CAP}/day). Contact support if you need more.`,
    }
  }

  const withinPlatformCap = await claimDailyBudget('quiz-generation', PLATFORM_DAILY_QUIZ_CAP)
  if (!withinPlatformCap) {
    return { ok: false, status: 429, reason: 'Meminno is experiencing high demand right now, please try again later.' }
  }

  return { ok: true }
}

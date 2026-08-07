// Two-layer rate limiting for POST /api/notes/[id]/flashcards (MEM-006,
// issue #6) — mandatory per CLAUDE.md HARD STOP 6, the same requirement
// lib/notesLimits.ts (MEM-005) exists for.
//
// Deliberately mirrors lib/notesLimits.ts's shape rather than inventing a
// new one (per this ticket's dispatch instructions to mirror MEM-005
// closely) — same two functions, same reasoning for why they're split:
//   1. checkFlashcardsBurstLimit() — lib/ratelimit.ts, unmodified — catches
//      rapid-fire abuse/misclick spam (e.g. mashing a "generate flashcards"
//      button) from one caller within seconds. Cheap and
//      note-independent, so the route calls this BEFORE looking up the
//      target notes row at all.
//   2. claimFlashcardsBudget() — lib/aiBudget.ts's claimDailyBudget, called
//      twice: a per-user daily cap tiered by plan, then a platform-wide
//      daily ceiling — the direct mechanism HARD STOP 6 describes, bounding
//      worst-case OpenAI spend even if every per-user cap were somehow
//      bypassed. Both claim a real day's quota, so the route calls this only
//      once it knows the request targets a real, owned notes row with
//      generatable content — a request for a missing/foreign/empty notes row
//      should 404/422 without spending a free user's daily allowance, the
//      same ordering MEM-004/MEM-005 both established (see
//      ARCHITECTURE.md's "Rate-limit ordering fix" note).
//
// Uses its own `flashcards-generation` operation name (and, via
// lib/aiBudget.ts's `meminno-ai-budget:` prefix, its own
// `meminno-ai-budget:flashcards-generation:...` Redis key namespace) so this
// endpoint's quota is tracked completely separately from
// lib/notesLimits.ts's `notes-generation` counters — generating notes for 5
// documents and then flashcards for all 5 of those notes should not compete
// for the same daily allowance.
import { limitRequest } from './ratelimit'
import { claimDailyBudget } from './aiBudget'

// Free plan: matches FREE_TIER_DAILY_NOTES_CAP (lib/notesLimits.ts) 1:1
// rather than picking an independent number, for the same reasoning MEM-005
// applied relative to MEM-004's upload cap: this app's core loop is
// upload -> AI notes -> AI flashcards (this ticket) -> quiz (MEM-007), so a
// free user who generates notes for their full daily allowance of documents
// should be able to turn every one of those notes into flashcards without
// hitting a second, tighter wall immediately after — otherwise the notes cap
// would silently become the real free-tier boundary one step early.
// Regenerating flashcards for the same notes row also counts against this
// cap, which is intentional: it's a real OpenAI call each time, not a cached
// read.
export const FREE_TIER_DAILY_FLASHCARDS_CAP = 5

// Paid plans: matches PAID_TIER_DAILY_NOTES_CAP for the same reason as the
// free tier above — paying subscribers shouldn't feel capped relative to how
// much they can generate notes for — while still bounding a single
// compromised or scripted paid account to a finite number of real OpenAI
// calls per day.
export const PAID_TIER_DAILY_FLASHCARDS_CAP = 50

// Platform-wide, ALL users/plans combined, per day. Matches
// PLATFORM_DAILY_NOTES_CAP (300), not the upload flow's looser 500: like
// notes generation and unlike PDF text extraction, every flashcards
// generation is a real, billed OpenAI API call — the actual dollar-cost
// surface HARD STOP 6 exists for. At gpt-4o-mini rates, a single call over
// an already-synthesized notes row (this module's sibling
// lib/flashcardsGeneration.ts's MAX_INPUT_CHARS, generally far smaller than
// notes generation's raw-document input) producing up to 20 short
// front/back pairs is on the order of a fraction of a cent — comparable to
// or cheaper than a single notes-generation call — so reusing the same
// platform ceiling gives generous headroom over any realistic
// pre-launch/beta volume while still capping the blast radius of a bug,
// retry storm, or abuse pattern, the same shape of incident that burned $100
// in 6 days on Propinno's uncapped RentCast poller. Revisit upward once
// Meminno has a real active-user count and real per-call cost data to size
// this against.
export const PLATFORM_DAILY_FLASHCARDS_CAP = 300

export type FlashcardsLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Layer 1: burst protection. Cheap and independent of which notes row is
 * targeted, so the route calls this before even looking the notes row up —
 * no reason to run a DB query just to find out the caller is being
 * rate-limited.
 */
export async function checkFlashcardsBurstLimit(userId: string): Promise<FlashcardsLimitResult> {
  // meminno- prefix: this Upstash Redis instance is shared with the
  // Propinno sibling project (see lib/aiBudget.ts / CLAUDE.md) — every key
  // this app writes must be namespaced to avoid colliding with Propinno's
  // own rate-limit/budget keys in the same instance.
  const burst = await limitRequest(`meminno-flashcards-burst:${userId}`)
  if (!burst.success) {
    return {
      ok: false,
      status: 429,
      reason: 'Too many flashcards-generation requests, please slow down and try again shortly.',
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
export async function claimFlashcardsBudget(userId: string, plan: string): Promise<FlashcardsLimitResult> {
  const perUserCap = plan === 'free' ? FREE_TIER_DAILY_FLASHCARDS_CAP : PAID_TIER_DAILY_FLASHCARDS_CAP
  const withinUserCap = await claimDailyBudget(`flashcards-generation:user:${userId}`, perUserCap)
  if (!withinUserCap) {
    return {
      ok: false,
      status: 429,
      reason:
        plan === 'free'
          ? `Free plan is limited to ${FREE_TIER_DAILY_FLASHCARDS_CAP} AI flashcards generations per day. Upgrade for a higher daily limit.`
          : `Daily flashcards-generation limit reached (${PAID_TIER_DAILY_FLASHCARDS_CAP}/day). Contact support if you need more.`,
    }
  }

  const withinPlatformCap = await claimDailyBudget('flashcards-generation', PLATFORM_DAILY_FLASHCARDS_CAP)
  if (!withinPlatformCap) {
    return { ok: false, status: 429, reason: 'Meminno is experiencing high demand right now, please try again later.' }
  }

  return { ok: true }
}

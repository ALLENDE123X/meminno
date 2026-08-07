// Two-layer rate limiting for POST /api/documents/[id]/notes (MEM-005,
// issue #5) — mandatory per CLAUDE.md HARD STOP 6, and this is the first
// endpoint that hard stop was written for specifically: the first real
// AI-generation call in this codebase (lib/notesGeneration.ts's OpenAI
// call), not just AI-adjacent compute like MEM-004's PDF extraction.
//
// Deliberately mirrors lib/uploadLimits.ts's shape rather than inventing a
// new one (per this ticket's dispatch instructions) — same two functions,
// same reasoning for why they're split rather than one combined check:
//   1. checkNotesBurstLimit() — lib/ratelimit.ts, unmodified — catches
//      rapid-fire abuse/misclick spam (e.g. mashing a "regenerate notes"
//      button) from one caller within seconds. Cheap and
//      document-independent, so the route calls this BEFORE looking up the
//      target document at all.
//   2. claimNotesBudget() — lib/aiBudget.ts's claimDailyBudget, called
//      twice: a per-user daily cap tiered by plan, then a platform-wide
//      daily ceiling — the direct mechanism HARD STOP 6 describes, bounding
//      worst-case OpenAI spend even if every per-user cap were somehow
//      bypassed or a bug fanned out across many accounts at once. Both
//      claim a real day's quota, so the route calls this only once it knows
//      the request targets a real document with generatable text — a
//      request for a missing/foreign/empty document should 404/422 without
//      spending a free user's daily allowance, the same ordering lesson
//      MEM-004's merge review flagged for the upload route (see
//      ARCHITECTURE.md's "Rate-limit ordering fix" note).
import { limitRequest } from './ratelimit'
import { claimDailyBudget } from './aiBudget'

// Free plan: sized to match FREE_TIER_DAILY_UPLOAD_CAP (lib/uploadLimits.ts)
// 1:1 rather than picking an independent number. Reasoning: this app's core
// loop is upload -> AI notes (this ticket) -> flashcards/quiz (MEM-007/008),
// so a free user who uploads their daily allowance of documents should be
// able to generate notes for all of them without hitting a second, tighter
// wall immediately after the first — that would make the upload cap
// meaningless as the actual free-tier boundary. Regenerating notes for the
// same document also counts against this cap, which is intentional: it's a
// real OpenAI call each time, not a cached read.
export const FREE_TIER_DAILY_NOTES_CAP = 5

// Paid plans: matches PAID_TIER_DAILY_UPLOAD_CAP for the same reason as the
// free tier above — paying subscribers shouldn't feel capped relative to
// how much they can upload — while still bounding a single compromised or
// scripted paid account to a finite number of real OpenAI calls per day.
export const PAID_TIER_DAILY_NOTES_CAP = 50

// Platform-wide, ALL users/plans combined, per day. Set lower than
// PLATFORM_DAILY_UPLOAD_CAP (500) deliberately: unlike PDF text extraction
// (compute-only, no external API cost), every notes generation is a real,
// billed OpenAI API call — this is the actual dollar-cost surface HARD STOP
// 6 exists for. At gpt-4o-mini rates, a single ~60k-character document
// (this module's MAX_INPUT_CHARS, see lib/notesGeneration.ts) plus a
// structured-notes response is on the order of a fraction of a cent, so 300
// calls/day is well under $5 worst case — generous headroom over any
// realistic pre-launch/beta volume (the per-user caps above already bound
// any single account to 5-50/day) while still capping the blast radius of a
// bug, retry storm, or abuse pattern, the same shape of incident that burned
// $100 in 6 days on Propinno's uncapped RentCast poller. Revisit upward once
// Meminno has a real active-user count and real per-call cost data to size
// this against.
export const PLATFORM_DAILY_NOTES_CAP = 300

export type NotesLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Layer 1: burst protection. Cheap and independent of which document is
 * targeted, so the route calls this before even looking the document up —
 * no reason to run a DB query just to find out the caller is being
 * rate-limited.
 */
export async function checkNotesBurstLimit(userId: string): Promise<NotesLimitResult> {
  // meminno- prefix: this Upstash Redis instance is shared with the
  // Propinno sibling project (see lib/aiBudget.ts / CLAUDE.md) — every key
  // this app writes must be namespaced to avoid colliding with Propinno's
  // own rate-limit/budget keys in the same instance.
  const burst = await limitRequest(`meminno-notes-burst:${userId}`)
  if (!burst.success) {
    return { ok: false, status: 429, reason: 'Too many notes-generation requests — please slow down and try again shortly.' }
  }
  return { ok: true }
}

/**
 * Layers 2-3: the actual daily-quota claim (per-user, then platform-wide).
 * Both `claimDailyBudget` calls atomically INCREMENT their counter
 * regardless of the eventual outcome of the OpenAI call, so the route must
 * only call this once it knows the request targets a real, owned document
 * with generatable text — never before that, or a 404/422 would still burn
 * a day's quota for nothing.
 */
export async function claimNotesBudget(userId: string, plan: string): Promise<NotesLimitResult> {
  const perUserCap = plan === 'free' ? FREE_TIER_DAILY_NOTES_CAP : PAID_TIER_DAILY_NOTES_CAP
  const withinUserCap = await claimDailyBudget(`notes-generation:user:${userId}`, perUserCap)
  if (!withinUserCap) {
    return {
      ok: false,
      status: 429,
      reason:
        plan === 'free'
          ? `Free plan is limited to ${FREE_TIER_DAILY_NOTES_CAP} AI notes generations per day. Upgrade for a higher daily limit.`
          : `Daily notes-generation limit reached (${PAID_TIER_DAILY_NOTES_CAP}/day). Contact support if you need more.`,
    }
  }

  const withinPlatformCap = await claimDailyBudget('notes-generation', PLATFORM_DAILY_NOTES_CAP)
  if (!withinPlatformCap) {
    return { ok: false, status: 429, reason: 'Meminno is experiencing high demand right now — please try again later.' }
  }

  return { ok: true }
}

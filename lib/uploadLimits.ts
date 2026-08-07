// Two-layer rate limiting for the document-upload endpoint (MEM-004, issue
// #4) — a hard requirement per CLAUDE.md HARD STOP 6, extended here to the
// upload path even though it doesn't call OpenAI directly: document
// creation is the gating step before MEM-005+'s AI generation, and PDF text
// extraction itself does real, billable-by-time serverless compute work,
// so the same "don't let a bug/retry-storm/abuse-pattern burn resources
// uncapped" reasoning applies (see lib/aiBudget.ts's header comment for the
// full Propinno-incident writeup this pattern exists to prevent).
//
// Three checks, two distinct mechanisms, split into two functions
// deliberately (not one `enforceUploadLimits`, which this file originally
// exported) so the route can call them at two different points:
//   1. checkBurstLimit() — lib/ratelimit.ts, unmodified — catches
//      rapid-fire abuse/misclick spam from one caller within seconds. Cheap
//      and content-independent, so the route calls this BEFORE parsing the
//      request body at all.
//   2. claimUploadBudget() — lib/aiBudget.ts's claimDailyBudget, called
//      twice:
//        a. per-user daily cap (keyed per user) — the actual free-tier cap
//           CLAUDE.md flagged as TBD ("Pricing (TBD numbers finalized in
//           MEM-004)"); this ticket is what finally picks real numbers, see
//           the constants below for reasoning.
//        b. platform-wide daily ceiling (keyed globally, independent of any
//           single user's cap) — the direct mechanism CLAUDE.md HARD STOP 6
//           describes: bounds worst-case cost/load even if every per-user
//           cap were somehow bypassed or a bug fanned out across many
//           accounts at once.
//      Both claim a real day's quota, so the route calls this AFTER the
//      request body has been parsed and validated — a request that fails
//      simple validation (wrong file type, no file/text field) should 400
//      without spending any of a free user's 5 daily uploads. This ordering
//      bug (budget claimed before validation) was caught during MEM-004's
//      merge review — see ARCHITECTURE.md's "Rate-limit ordering fix" note.
import { limitRequest } from './ratelimit'
import { claimDailyBudget } from './aiBudget'

// Free plan: a "handful of uploads per day" per CLAUDE.md's own framing.
// Reasoning: this app's core loop is upload -> AI notes/flashcards/quiz
// (MEM-005+), so a free user needs enough uploads to genuinely try the
// product across a real study session (a few classes' worth of material in
// one day), but not so many that "free" alone covers a whole semester of
// coursework with zero incentive to upgrade. 5/day matches TurboLearn-style
// competitor free tiers in shape (a small daily allowance, not a monthly
// bucket) and is cheap to raise later once real usage data exists.
export const FREE_TIER_DAILY_UPLOAD_CAP = 5

// Paid plans (monthly/semester): not a real product limit — paying
// subscribers shouldn't feel capped — but still a finite sanity ceiling so
// one compromised or scripted paid account can't loop uploads indefinitely.
// 10x the free cap is generous headroom for any legitimate daily study
// volume while still bounding the blast radius of a single account.
export const PAID_TIER_DAILY_UPLOAD_CAP = 50

// Platform-wide, ALL users/plans combined, per day. Sized well above any
// realistic pre-launch/beta legitimate volume (the free-tier cap alone
// already bounds any single user to 5-50/day) while still capping
// worst-case cost/load if a bug or abuse pattern fanned out across many
// accounts simultaneously — the exact failure shape that burned $100 in 6
// days on Propinno's uncapped RentCast poller. Revisit upward once Meminno
// has a real active-user count to size this against.
export const PLATFORM_DAILY_UPLOAD_CAP = 500

export type UploadLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Layer 1: burst protection. Cheap and independent of what's in the
 * request, so the route calls this before parsing the body — no reason to
 * make a caller upload a whole PDF just to find out they're being
 * rate-limited.
 */
export async function checkBurstLimit(userId: string): Promise<UploadLimitResult> {
  // meminno- prefix: this Upstash Redis instance is shared with the
  // Propinno sibling project (see lib/aiBudget.ts / CLAUDE.md) — every key
  // this app writes must be namespaced to avoid colliding with Propinno's
  // own rate-limit/budget keys in the same instance.
  const burst = await limitRequest(`meminno-upload-burst:${userId}`)
  if (!burst.success) {
    return { ok: false, status: 429, reason: 'Too many upload requests, please slow down and try again shortly.' }
  }
  return { ok: true }
}

/**
 * Layers 2-3: the actual daily-quota claim (per-user, then platform-wide).
 * Both `claimDailyBudget` calls atomically INCREMENT their counter
 * regardless of the eventual outcome of the request, so the route must only
 * call this once it knows the request is otherwise valid and about to
 * create a `documents` row — never before validating the body, or a
 * malformed/rejected request would still burn a day's quota for nothing.
 */
export async function claimUploadBudget(userId: string, plan: string): Promise<UploadLimitResult> {
  const perUserCap = plan === 'free' ? FREE_TIER_DAILY_UPLOAD_CAP : PAID_TIER_DAILY_UPLOAD_CAP
  const withinUserCap = await claimDailyBudget(`document-upload:user:${userId}`, perUserCap)
  if (!withinUserCap) {
    return {
      ok: false,
      status: 429,
      reason:
        plan === 'free'
          ? `Free plan is limited to ${FREE_TIER_DAILY_UPLOAD_CAP} uploads per day. Upgrade for a higher daily limit.`
          : `Daily upload limit reached (${PAID_TIER_DAILY_UPLOAD_CAP}/day). Contact support if you need more.`,
    }
  }

  const withinPlatformCap = await claimDailyBudget('document-upload', PLATFORM_DAILY_UPLOAD_CAP)
  if (!withinPlatformCap) {
    return { ok: false, status: 429, reason: 'Meminno is experiencing high demand right now, please try again later.' }
  }

  return { ok: true }
}

// Two-layer rate limiting for podcast generation (MEM-014, issue #49) —
// mandatory per CLAUDE.md HARD STOP 6, and the first time that hard stop
// covers a vendor other than OpenAI: this is the only path in the codebase
// that bills Google. Same shape as lib/notesLimits.ts / lib/quizLimits.ts /
// lib/recordingLimits.ts (a burst check, then a per-user claim, then a
// platform-wide daily claim, each with its own operation-name string), with
// deliberately different NUMBERS — and, since issue #87, a different WINDOW on
// the free tier — see the reasoning on each constant.
//
// Ordering convention, unchanged from MEM-004's merge-review lesson: the
// route calls checkPodcastBurstLimit() FIRST (cheap, request-independent),
// then validates that the request targets a real, owned document with
// generatable text, and only then calls claimPodcastBudget(). Both budget
// calls atomically increment a counter whatever happens afterwards, so a
// 404/422 must never reach them.
//
// NOTE FOR MEM-015: podcast generation is two billed calls, not one — a
// GPT-5.6 Luna script call (MEM-013) and a Gemini TTS call (MEM-014). One
// claim covers the whole pipeline, since that is one user-visible action and
// double-charging the quota for it would just make the cap mean half what it
// says. Claim once, before the script call.
//
// NOTE (issue #87, 2026-08-12): the FREE tier is now a WEEKLY cap, not a daily
// one — 1 podcast/week. Paid and platform caps stay daily. This is a product
// decision (create real upgrade pressure), not a cost one; the cost reasoning
// below is unchanged and still explains why free was never at 5/day.
import { limitRequest } from './ratelimit'
import { claimDailyBudget, claimWeeklyBudget } from './aiBudget'

// ---------------------------------------------------------------------------
// The measurement these caps are built on
// ---------------------------------------------------------------------------
// Real synthesis run during this ticket, against the real API: an 831-word
// two-speaker script produced 4.63 minutes of audio for 1,207 input + 6,939
// audio-output tokens. At gemini-2.5-flash-preview-tts's published rates
// ($0.50/1M text in, $10.00/1M audio out) that is **$0.070**, and a script at
// lib/podcastAudio.ts's 7,000-character ceiling lands around **$0.10**.
//
// That is roughly SIXTY TIMES the cost of one notes/flashcards/quiz
// generation, which is why none of those modules' numbers were copied here.
// The unit being capped is the same word ("generation"); the dollars behind
// it are not remotely the same, and the caps have to track the dollars.

// Free plan: 1 per WEEK — the only cap in this codebase that is not daily.
//
// Why weekly, and why 1 (issue #87): this is a deliberate conversion lever,
// decided on the 2026-08-12 call, not a cost adjustment. The free tier at
// 2/day was generous enough that a student could keep using it indefinitely
// and never feel a reason to pay. One podcast a week is still enough to fully
// experience the feature end to end — which is the point of a free tier and
// the thing that makes someone want more — while making "I want another one"
// a real, frequent moment that only upgrading resolves.
//
// It also happens to cut the worst-case free-tier vendor spend from ~$0.20/day
// to ~$0.10/week per account (~14x), on the single most expensive thing this
// product does. That is a side effect, not the reason.
//
// The window resets at the ISO week boundary (Monday 00:00 UTC) via
// lib/aiBudget.ts's claimWeeklyBudget — a real weekly reset, not a
// 7-day-from-first-use rolling window and not a daily key with a longer TTL.
export const FREE_TIER_WEEKLY_PODCAST_CAP = 1

// Paid plans: 5/day, derived from unit economics rather than picked as a
// round number. The cheaper subscription is $17.99/month, i.e. ~$0.60/day of
// revenue. Five podcasts a day at ~$0.10 is ~$0.50/day, so **even a
// subscriber who maxes this cap out every single day of the month still costs
// less in vendor spend than they pay** ($15/month against $17.99, and the
// semester plan works out to the same daily figure). The 50/day paid cap the
// other AI features use would be ~$5/day, roughly 8x that subscriber's
// revenue — a cap that inverts the business model is not a sanity ceiling.
// Five is also well above realistic use: a student podcasting five separate
// documents in one day is already an unusually heavy session.
export const PAID_TIER_DAILY_PODCAST_CAP = 5

// Platform-wide, all users and plans combined, per day. ~$5/day of absolute
// worst-case vendor spend (~$150/month if it were pinned there every day),
// which is the same daily dollar ceiling lib/notesLimits.ts sized its own
// 300/day figure against — the call count is 6x lower only because each call
// costs ~60x more. For scale: the Propinno incident this whole hard stop
// exists because of burned ~$17/day, so this bounds the equivalent blast
// radius roughly 3.5x tighter.
//
// It is deliberately the binding constraint at current scale: 50/day is 25
// free users or 10 paid subscribers at their personal maximum. If real
// legitimate demand starts hitting it, that is a signal to raise this with
// real usage data in hand, not evidence the number was wrong to start at.
// Revisit alongside the WAV-vs-compressed-audio follow-up in ARCHITECTURE.md,
// since egress is a second, separate cost this cap indirectly bounds.
export const PLATFORM_DAILY_PODCAST_CAP = 50

export type PodcastLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Layer 1: burst protection. Cheap and independent of which document is
 * targeted, so the route calls this before looking anything up.
 */
export async function checkPodcastBurstLimit(userId: string): Promise<PodcastLimitResult> {
  // meminno- prefix: this Upstash Redis instance is shared with the Propinno
  // sibling project (see lib/aiBudget.ts / CLAUDE.md) — every key this app
  // writes must be namespaced so it cannot collide with Propinno's own
  // rate-limit and poller-budget keys in the same instance.
  const burst = await limitRequest(`meminno-podcast-burst:${userId}`)
  if (!burst.success) {
    return { ok: false, status: 429, reason: 'Too many podcast requests, please slow down and try again shortly.' }
  }
  return { ok: true }
}

// The free cap is 1, so its message has to read "1 podcast per week", not
// "1 podcasts per week". Kept derived from the constant rather than hardcoded
// so the number and the sentence can never drift apart if it is ever raised.
const freeCapPhrase = `${FREE_TIER_WEEKLY_PODCAST_CAP} podcast${FREE_TIER_WEEKLY_PODCAST_CAP === 1 ? '' : 's'}`

/**
 * Layers 2-3: the per-user cap, then the platform-wide daily ceiling.
 * Own Redis namespace (`podcast-generation`), never shared with the
 * notes/flashcards/quiz/recording counters.
 *
 * The per-user window is plan-dependent (issue #87): free users are capped
 * WEEKLY, paid users daily. Both use the same operation name — the counters
 * still cannot collide, because lib/aiBudget.ts suffixes the key with the
 * window (`...:2026-08-12` vs `...:2026-W33`). A user who upgrades or
 * downgrades mid-window therefore starts against a fresh counter on the other
 * cadence, which is the correct and generous-to-the-user behavior.
 */
export async function claimPodcastBudget(userId: string, plan: string): Promise<PodcastLimitResult> {
  const isFree = plan === 'free'
  const withinUserCap = isFree
    ? await claimWeeklyBudget(`podcast-generation:user:${userId}`, FREE_TIER_WEEKLY_PODCAST_CAP)
    : await claimDailyBudget(`podcast-generation:user:${userId}`, PAID_TIER_DAILY_PODCAST_CAP)
  if (!withinUserCap) {
    return {
      ok: false,
      status: 429,
      reason: isFree
        ? `Free plan is limited to ${freeCapPhrase} per week. Upgrade for more.`
        : `Daily podcast limit reached (${PAID_TIER_DAILY_PODCAST_CAP}/day). Contact support if you need more.`,
    }
  }

  const withinPlatformCap = await claimDailyBudget('podcast-generation', PLATFORM_DAILY_PODCAST_CAP)
  if (!withinPlatformCap) {
    return { ok: false, status: 429, reason: 'Meminno is experiencing high demand right now, please try again later.' }
  }

  return { ok: true }
}

// Two-layer rate limiting for POST /api/documents/record-chunk (issue #42,
// lecture recording) — mandatory per CLAUDE.md HARD STOP 6, since this is a
// new real AI-generation endpoint (calls OpenAI's transcription API, real
// billed cost per call).
//
// Deliberately does NOT reuse lib/notesLimits.ts's caps, and deliberately
// does NOT enforce a per-recording-session cap here at all — see the
// "why chunk-level, not session-level" note below.
import { limitRequest } from './ratelimit'
import { claimDailyBudget } from './aiBudget'

// A single real lecture recording (components/lecture-recorder.tsx's
// ~8-minute chunking, capped at 90 minutes total) naturally produces
// somewhere around 7-12 chunk-transcription calls. Charging that against a
// 5/day-style cap (lib/notesLimits.ts's shape) would make the feature
// unusable after roughly half of one real lecture on the free plan — so
// this cap is sized in CHUNKS, generously above one full lecture's worth,
// not to mirror the other generation caps' numbers. A free user finishing
// one full 90-minute lecture (~12 chunks at the 8-minute default) still
// has real headroom left in the same day.
export const FREE_TIER_DAILY_CHUNK_CAP = 40

// Paid: enough for several full lectures a day, same "don't feel capped"
// reasoning as every other paid-tier cap in this codebase.
export const PAID_TIER_DAILY_CHUNK_CAP = 200

// Platform-wide, all users/plans combined, per day. Transcription is billed
// per audio-minute rather than per-token, a genuinely different cost shape
// than the chat-completion calls lib/notesLimits.ts's platform cap is sized
// against — this number is a conservative starting ceiling, NOT backed by
// real measured per-call cost the way that comment documents its own math.
// Revisit once Meminno has real recording volume and real OpenAI invoice
// data for this specific endpoint to size it against, same "revisit
// upward once real data exists" instruction lib/notesLimits.ts's own
// comment gives for its cap.
export const PLATFORM_DAILY_CHUNK_CAP = 1500

// Deliberately no per-user or platform-wide cap keyed at the "recording
// session" level: the FINAL save step (once a recording is stopped and its
// full transcript is submitted) goes through the existing
// POST /api/documents route, which already claims a per-user daily upload
// budget via lib/uploadLimits.ts — a saved recording is just another
// document from that route's point of view. Adding a second per-session
// cap here on top of that would double-gate the same real user action for
// no added protection; the chunk-level cap below is what actually bounds
// the real OpenAI cost this endpoint can incur.

export type RecordingLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Layer 1: burst protection on chunk uploads. In real use this almost
 * never fires — chunks arrive naturally paced ~8 minutes apart by the
 * recording itself, not in a burst — so this exists purely to catch a
 * scripted/abusive caller hammering the endpoint directly, not to throttle
 * legitimate recording traffic.
 */
export async function checkRecordingBurstLimit(userId: string): Promise<RecordingLimitResult> {
  // meminno- prefix: shared Upstash Redis instance with Propinno, per
  // lib/aiBudget.ts / CLAUDE.md's credential-reuse map.
  const burst = await limitRequest(`meminno-recording-burst:${userId}`)
  if (!burst.success) {
    return { ok: false, status: 429, reason: 'Too many transcription requests, please slow down and try again shortly.' }
  }
  return { ok: true }
}

/**
 * Layers 2-3: the per-chunk daily quota claim (per-user, then
 * platform-wide). Both calls atomically INCREMENT their counter regardless
 * of the eventual transcription outcome, so the route must only call this
 * once a chunk is known to be a well-formed, non-empty audio file worth
 * actually sending to OpenAI — same "don't claim budget before the request
 * is known-valid" ordering every other generation endpoint in this
 * codebase follows.
 */
export async function claimChunkTranscriptionBudget(userId: string, plan: string): Promise<RecordingLimitResult> {
  const perUserCap = plan === 'free' ? FREE_TIER_DAILY_CHUNK_CAP : PAID_TIER_DAILY_CHUNK_CAP
  const withinUserCap = await claimDailyBudget(`recording-transcription:user:${userId}`, perUserCap)
  if (!withinUserCap) {
    return {
      ok: false,
      status: 429,
      reason:
        plan === 'free'
          ? `Free plan is limited to ${FREE_TIER_DAILY_CHUNK_CAP} recording segments per day (roughly a few lectures' worth). Upgrade for a higher daily limit.`
          : `Daily recording-transcription limit reached (${PAID_TIER_DAILY_CHUNK_CAP} segments/day). Contact support if you need more.`,
    }
  }

  const withinPlatformCap = await claimDailyBudget('recording-transcription', PLATFORM_DAILY_CHUNK_CAP)
  if (!withinPlatformCap) {
    return { ok: false, status: 429, reason: 'Meminno is experiencing high demand right now, please try again later.' }
  }

  return { ok: true }
}

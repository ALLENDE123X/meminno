import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

/**
 * Atomically claims one "slot" against a daily platform-wide budget for a
 * named AI-generation operation (e.g. notes/flashcards/quiz generation,
 * chat messages). Returns true if the caller is within budget and should
 * proceed, false if today's budget is already used up. Fails OPEN (returns
 * true) if Redis isn't configured or errors - this is a safety net on top
 * of normal operation, not a dependency normal operation should break on.
 *
 * Renamed/generalized from Propinno's lib/pollerBudget.ts (same
 * claimDailyBudget pattern, same atomic-INCR-then-compare mechanism, same
 * fail-open-if-Redis-unconfigured safety behavior) — Propinno used this to
 * cap listing-poller API calls; Meminno uses it to cap AI-generation calls.
 * That file exists because of a real incident on the Propinno sibling
 * project: an unbounded RentCast cron running every 15 minutes with no cap
 * burned $100 in 6 days with zero paying subscribers. Meminno's AI-generation
 * endpoints (notes/flashcards/quiz generation, chat) are exactly the same
 * shape of risk — a bug, retry storm, or abuse pattern hitting the OpenAI API
 * uncapped could burn real money fast — so this module is REQUIRED on every
 * AI-generation endpoint as the platform-wide half of a two-layer limit:
 * this (daily budget ceiling) plus lib/ratelimit.ts (per-user/per-request
 * rate limit). Neither one alone is sufficient — see CLAUDE.md.
 *
 * IMPORTANT: this Redis instance (UPSTASH_REDIS_REST_URL/TOKEN) is SHARED
 * with the Propinno project by design (same Upstash database, reused
 * credentials). The `meminno-` key prefix below is load-bearing — it is
 * what keeps this project's counters from colliding with Propinno's poller
 * budget counters in the same Redis instance. Do not remove it, and prefix
 * any other Redis keys this project writes the same way.
 */
export async function claimDailyBudget(operationName: string, maxPerDay: number): Promise<boolean> {
  if (!redis) return true

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  const key = `meminno-ai-budget:${operationName}:${today}`

  try {
    const count = await redis.incr(key)
    if (count === 1) {
      // First claim of the day for this operation - expire in 2 days so the
      // key self-cleans without needing a separate cleanup job.
      await redis.expire(key, 60 * 60 * 48)
    }
    return count <= maxPerDay
  } catch {
    return true
  }
}

import { Redis } from '@upstash/redis'

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

// TTLs are deliberately 2x their window, not 1x. The counter key is created
// partway through its own window (whenever the first claim of that window
// lands), so a TTL equal to the window length would expire it EARLY — mid-day
// for a daily key, mid-week for a weekly one — silently handing the user a
// fresh allowance before the window actually rolled over. 2x is the smallest
// safe value: the key is only there to self-clean without a cleanup job, and
// the window boundary itself comes from the key NAME (the date/ISO-week
// suffix), never from expiry.
const DAILY_TTL_SECONDS = 60 * 60 * 48 // 2 days
const WEEKLY_TTL_SECONDS = 60 * 60 * 24 * 14 // 2 weeks

/**
 * Shared mechanism behind claimDailyBudget/claimWeeklyBudget: atomic
 * INCR-then-compare against a window-suffixed key, fail-open on any Redis
 * problem. The ONLY thing that differs between the two is which window string
 * goes in the key (and the matching TTL) — the reset cadence is a property of
 * the key name, so a caller can never accidentally get a half-length window by
 * pairing the wrong TTL with the wrong suffix.
 */
async function claimBudget(
  operationName: string,
  max: number,
  windowKey: string,
  ttlSeconds: number
): Promise<boolean> {
  if (!redis) return true

  const key = `meminno-ai-budget:${operationName}:${windowKey}`

  try {
    const count = await redis.incr(key)
    if (count === 1) {
      // First claim of this window for this operation - expire it at 2x the
      // window length so the key self-cleans without needing a separate
      // cleanup job (see the TTL note above for why not 1x).
      await redis.expire(key, ttlSeconds)
    }
    return count <= max
  } catch {
    return true
  }
}

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
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  return claimBudget(operationName, maxPerDay, today, DAILY_TTL_SECONDS)
}

/**
 * The ISO-8601 week containing `date`, as `YYYY-Www` in UTC (e.g. 2026-W33).
 * Exported for tests — it is the thing that actually defines when a weekly cap
 * resets, so it is worth pinning directly rather than only through a mock.
 *
 * ISO weeks start Monday and belong to the year containing their Thursday,
 * which is why this shifts to that Thursday before reading the year. A naive
 * "week number since Jan 1" would produce a duplicate or skipped week label at
 * every year boundary — i.e. a free user getting two allowances in one week,
 * or none, once a year.
 */
export function isoWeekKey(date: Date = new Date()): string {
  // Copy to a date-only UTC value so DST and local time can never shift which
  // day (and therefore which week) this lands on.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // getUTCDay(): Sunday = 0. ISO treats Sunday as day 7, so remap it, then
  // step to the Thursday of this ISO week (day 4).
  const isoDayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + 4 - isoDayOfWeek)

  const isoYear = d.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4)) // Jan 4 is always in ISO week 1
  const firstIsoDayOfWeek = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay()
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstIsoDayOfWeek)

  const weekNumber = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1
  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`
}

/**
 * Weekly sibling of claimDailyBudget — same atomic INCR-then-compare, same
 * fail-open behavior, same `meminno-` namespacing; only the window differs.
 * Resets at the ISO week boundary (Monday 00:00 UTC), NOT on a rolling
 * 7-day-from-first-use basis.
 *
 * Added for issue #87 (free tier restricted to 1 podcast/week). Weekly and
 * daily counters for the same operation name can never collide even though
 * they share a namespace: `...:2026-08-12` and `...:2026-W33` are different
 * key strings by construction.
 *
 * Do NOT reimplement this by passing a week string to claimDailyBudget — that
 * would attach a 48-hour TTL to a 7-day window and quietly reset the counter
 * mid-week, which is the exact bug the TTL note at the top of this file exists
 * to prevent.
 */
export async function claimWeeklyBudget(operationName: string, maxPerWeek: number): Promise<boolean> {
  return claimBudget(operationName, maxPerWeek, isoWeekKey(), WEEKLY_TTL_SECONDS)
}

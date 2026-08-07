import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { logger } from './logger'

let ratelimit: Ratelimit | null = null

try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(10, '10 s'),
    })
  } else {
    logger.warn('Upstash Redis environment variables are missing. Rate limiting is disabled.')
  }
} catch (error) {
  logger.error({ error }, 'Failed to initialize rate limiter')
}

export { ratelimit }
export async function limitRequest(key: string) {
  if (!ratelimit) return { success: true }
  try {
    return await ratelimit.limit(key)
  } catch (error) {
    logger.error({ error, key }, 'Rate limiting check failed')
    return { success: true } // Fallback to allow request in case of Redis failure
  }
}

// Dedicated, stricter limiter for public endpoints that write persistent data
// (as opposed to /api/health's generic 10-req/10s, which is fine for a
// no-op health check but far too loose for something that actually stores
// a row per request). A distinct `prefix` is required, not optional — the
// underlying @upstash/ratelimit client namespaces its Redis keys by
// `prefix:identifier`, and without a distinct prefix here this limiter
// would read/write the SAME Redis keys as the generic `ratelimit` instance
// above for any identifier the two share, silently corrupting both sliding
// windows. See app/api/waitlist/route.ts for why this exists: this Redis
// instance is shared with the Propinno sibling project's own budget/rate
// counters (whose fail-open budget checks assume normal usage volumes), so
// an endpoint here that can't be abused into runaway request volume is not
// just a Meminno concern.
let strictRatelimit: Ratelimit | null = null

try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    strictRatelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(3, '1 h'),
      prefix: 'meminno-strict-ratelimit',
    })
  }
} catch (error) {
  logger.error({ error }, 'Failed to initialize strict rate limiter')
}

export async function limitStrict(key: string) {
  if (!strictRatelimit) return { success: true }
  try {
    return await strictRatelimit.limit(key)
  } catch (error) {
    logger.error({ error, key }, 'Strict rate limiting check failed')
    return { success: true }
  }
}

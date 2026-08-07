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

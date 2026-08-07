import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { logger } from '@/lib/logger'
import { limitStrict } from '@/lib/ratelimit'

// meminno- prefix: this Upstash Redis instance is shared with the Propinno
// sibling project, so every key this app writes must be namespaced to avoid
// colliding with Propinno's own rate-limit/budget keys. See CLAUDE.md.
const WAITLIST_KEY = 'meminno-waitlist-emails'

// Circuit breaker against runaway growth on the shared Redis instance, not a
// real product/business cap on real signups — this endpoint has no daily
// reset (a genuine waitlist shouldn't lose entries), so a per-IP rate limit
// alone doesn't bound total volume under distributed abuse (many IPs). If
// real organic growth ever approaches this, raise it; it exists purely so a
// scripted abuse pattern can't grow this set unboundedly on an instance
// Propinno also depends on.
const MAX_WAITLIST_SIZE = 50_000

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidWaitlistEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length <= 254 && EMAIL_RE.test(value.trim())
}

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1'

  // Strict per-IP limit (3/hour), not the generic 10-req/10s limiter used by
  // /api/health — that generic limit still allows ~86,400 requests/day from
  // a single IP, far too loose for an endpoint that writes a persistent row
  // per call. See lib/ratelimit.ts for why this needs its own instance.
  const { success } = await limitStrict(`meminno-waitlist_${ip}`)
  if (!success) {
    logger.warn({ ip }, 'Waitlist signup rate limited')
    return NextResponse.json({ error: 'Too many requests — try again in a bit.' }, { status: 429 })
  }

  let email: unknown
  try {
    const body = await req.json()
    email = body?.email
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
  }

  if (!isValidWaitlistEmail(email)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  if (!redis) {
    // Fails closed (tells the user it didn't work) rather than silently
    // discarding the signup — see CLAUDE.md on being honest about what the
    // product actually does. In practice UPSTASH_REDIS_REST_URL/TOKEN are
    // set in Vercel Production, so this only triggers in a misconfigured env.
    logger.warn('Upstash Redis is not configured — waitlist signup was not persisted')
    return NextResponse.json({ error: 'Waitlist is temporarily unavailable — try again later.' }, { status: 503 })
  }

  const normalized = email.trim().toLowerCase()

  try {
    // Second layer of the two-layer guard (strict per-IP limit above is the
    // first): a hard ceiling on total set size, checked before every write,
    // so distributed abuse across many IPs still can't grow this set
    // unboundedly on a Redis instance Propinno also relies on.
    const currentSize = await redis.scard(WAITLIST_KEY)
    if (currentSize >= MAX_WAITLIST_SIZE) {
      logger.error({ currentSize }, 'Waitlist set size cap reached — rejecting new signups')
      return NextResponse.json({ error: 'Waitlist is temporarily full — try again later.' }, { status: 503 })
    }

    // A Redis set, not a counter — repeat signups from the same email are
    // deduped for free instead of double-counting.
    await redis.sadd(WAITLIST_KEY, normalized)
  } catch (error) {
    logger.error({ error }, 'Failed to persist waitlist signup')
    return NextResponse.json({ error: 'Something went wrong — try again.' }, { status: 500 })
  }

  logger.info({ action: 'waitlist_signup' }, 'New waitlist signup')
  return NextResponse.json({ status: 'ok' })
}

import { NextResponse } from 'next/server'
import { Redis } from '@upstash/redis'
import { logger } from '@/lib/logger'
import { limitRequest } from '@/lib/ratelimit'

// meminno- prefix: this Upstash Redis instance is shared with the Propinno
// sibling project, so every key this app writes must be namespaced to avoid
// colliding with Propinno's own rate-limit/budget keys. See CLAUDE.md.
const WAITLIST_KEY = 'meminno-waitlist-emails'

const redis =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? Redis.fromEnv() : null

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidWaitlistEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length <= 254 && EMAIL_RE.test(value.trim())
}

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1'

  const { success } = await limitRequest(`meminno-waitlist_${ip}`)
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

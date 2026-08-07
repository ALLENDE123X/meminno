import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { limitRequest } from '@/lib/ratelimit'

export async function GET(req: Request) {
  const ip = req.headers.get('x-forwarded-for') ?? '127.0.0.1'

  // meminno- prefix: this Upstash Redis instance is shared with the
  // Propinno sibling project, so every key this app writes must be
  // namespaced to avoid colliding with Propinno's own rate-limit/budget keys.
  const { success } = await limitRequest(`meminno-health_${ip}`)
  if (!success) {
    logger.warn({ ip }, 'Health check rate limited')
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  logger.info({ action: 'health_check', status: 'ok' })
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() })
}

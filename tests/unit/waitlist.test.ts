import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isValidWaitlistEmail } from '@/app/api/waitlist/route'

describe('isValidWaitlistEmail', () => {
  it('accepts a well-formed email', () => {
    expect(isValidWaitlistEmail('student@school.edu')).toBe(true)
  })

  it('rejects non-string values', () => {
    expect(isValidWaitlistEmail(undefined)).toBe(false)
    expect(isValidWaitlistEmail(123)).toBe(false)
    expect(isValidWaitlistEmail(null)).toBe(false)
  })

  it('rejects malformed email strings', () => {
    expect(isValidWaitlistEmail('not-an-email')).toBe(false)
    expect(isValidWaitlistEmail('missing@domain')).toBe(false)
    expect(isValidWaitlistEmail('@no-local-part.com')).toBe(false)
  })

  it('rejects unreasonably long input', () => {
    const tooLong = `${'a'.repeat(250)}@example.com`
    expect(isValidWaitlistEmail(tooLong)).toBe(false)
  })
})

// No UPSTASH_REDIS_REST_URL/TOKEN set in the test environment, so the route
// must fail CLOSED (503, signup not silently discarded) rather than
// pretending the email was saved — this is the opposite failure mode from
// lib/aiBudget.ts's fail-open behavior, and deliberately so: a budget check
// failing open just skips a cost guard, but a waitlist signup failing open
// would tell a real person they're on a list they were never added to.
describe('POST /api/waitlist', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
    // The route module reads Redis env vars at import time, and the
    // isValidWaitlistEmail suite above already imported (and cached) this
    // same module. Force a fresh evaluation so it picks up the stubbed
    // (unset) env rather than whatever was live when this file first loaded.
    vi.resetModules()
  })

  it('returns 503 without persisting when Redis is not configured', async () => {
    const { POST } = await import('@/app/api/waitlist/route')
    const req = new Request('http://localhost/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'student@school.edu' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(503)
  })

  it('returns 400 for an invalid email before touching Redis', async () => {
    const { POST } = await import('@/app/api/waitlist/route')
    const req = new Request('http://localhost/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unparsable body', async () => {
    const { POST } = await import('@/app/api/waitlist/route')
    const req = new Request('http://localhost/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
  })
})

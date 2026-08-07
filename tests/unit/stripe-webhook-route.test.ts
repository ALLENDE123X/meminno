import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleStripeWebhookEvent } from '@/lib/billing'
import { limitRequest } from '@/lib/ratelimit'

// Hoisting-safe factories only (bare vi.fn()/plain values, no outer-const
// reference) — see tests/unit/notes-route.test.ts's header comment for why.
vi.mock('@/lib/billing', () => ({
  handleStripeWebhookEvent: vi.fn(),
}))
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/lib/stripe', () => ({
  stripe: { webhooks: { constructEvent: vi.fn() } },
}))

const handleStripeWebhookEventMock = vi.mocked(handleStripeWebhookEvent)
const limitRequestMock = vi.mocked(limitRequest)

// route.ts imports lib/stripe dynamically (`await import('@/lib/stripe')`)
// specifically to keep it out of the module graph until a signature
// actually needs verifying — vi.mock intercepts dynamic imports the same
// way it does static ones, so this is fetched fresh per test.
import { stripe } from '@/lib/stripe'
const constructEventMock = vi.mocked(stripe.webhooks.constructEvent)

import { POST } from '@/app/api/webhooks/stripe/route'

function makeRequest(body = 'raw-body', signature: string | null = 'test-sig') {
  const headers: Record<string, string> = {}
  if (signature) headers['stripe-signature'] = signature
  return new Request('http://localhost/api/webhooks/stripe', { method: 'POST', headers, body })
}

describe('POST /api/webhooks/stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    limitRequestMock.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 })
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  })

  it('returns 429 when rate-limited, before touching the signature', async () => {
    limitRequestMock.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: 0 })

    const res = await POST(makeRequest())

    expect(res.status).toBe(429)
    expect(constructEventMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the stripe-signature header is missing', async () => {
    const res = await POST(makeRequest('body', null))
    expect(res.status).toBe(400)
  })

  it('returns 400 when STRIPE_WEBHOOK_SECRET is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    const res = await POST(makeRequest())
    expect(res.status).toBe(400)
  })

  it('returns 400 on an invalid signature, without calling handleStripeWebhookEvent', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('signature mismatch')
    })

    const res = await POST(makeRequest())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('signature mismatch')
    expect(handleStripeWebhookEventMock).not.toHaveBeenCalled()
  })

  it('verifies the signature with the real secret and body, then fans out to lib/billing', async () => {
    const fakeEvent = { type: 'checkout.session.completed', data: { object: {} } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructEventMock.mockReturnValue(fakeEvent as any)
    handleStripeWebhookEventMock.mockResolvedValue(undefined)

    const res = await POST(makeRequest('raw-body', 'sig-123'))
    const body = await res.json()

    expect(constructEventMock).toHaveBeenCalledWith('raw-body', 'sig-123', 'whsec_test')
    expect(handleStripeWebhookEventMock).toHaveBeenCalledWith(fakeEvent)
    expect(res.status).toBe(200)
    expect(body).toEqual({ received: true })
  })

  it('returns 500 when lib/billing throws while processing a verified event', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructEventMock.mockReturnValue({ type: 'checkout.session.completed', data: { object: {} } } as any)
    handleStripeWebhookEventMock.mockRejectedValue(new Error('db unavailable'))

    const res = await POST(makeRequest())
    expect(res.status).toBe(500)
  })
})

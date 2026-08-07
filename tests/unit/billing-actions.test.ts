import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { withUserContext } from '@/lib/db'
import { stripe } from '@/lib/stripe'
import { cancelStripeSubscription, priceIdForPlan } from '@/lib/billing'
import { limitRequest } from '@/lib/ratelimit'

// Hoisting-safe factories only — see tests/unit/notes-route.test.ts's header
// comment (vi.mock is hoisted above this file's own top-level const
// declarations, so a factory may only return bare vi.fn()s/plain values,
// never a direct reference to an outer const).
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  withUserContext: vi.fn(),
}))
vi.mock('@/lib/stripe', () => ({
  stripe: { checkout: { sessions: { create: vi.fn() } } },
}))
vi.mock('@/lib/billing', async () => {
  const actual = await vi.importActual<typeof import('@/lib/billing')>('@/lib/billing')
  return {
    ...actual,
    cancelStripeSubscription: vi.fn(),
  }
})
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('next/headers', () => ({
  headers: vi.fn(),
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const withUserContextMock = vi.mocked(withUserContext)
const checkoutSessionsCreateMock = vi.mocked(stripe.checkout.sessions.create)
const cancelStripeSubscriptionMock = vi.mocked(cancelStripeSubscription)
const limitRequestMock = vi.mocked(limitRequest)

import { headers } from 'next/headers'
const headersMock = vi.mocked(headers)

import { getBillingStatus, createCheckoutSession, cancelSubscription } from '@/app/billing/actions'

const USER_ID = 'user-1'

let selectResult: unknown[] = []
const updateSets: Record<string, unknown>[] = []

function mockHeaders(map: Record<string, string> = { host: 'meminno.vercel.app' }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, security/detect-object-injection -- k is a header name from our own test setup, not arbitrary input
  headersMock.mockResolvedValue({ get: (k: string) => map[k] ?? null } as any)
}

describe('app/billing/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectResult = []
    updateSets.length = 0
    limitRequestMock.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 })
    mockHeaders()
    withUserContextMock.mockImplementation(async (_userId, fn) => {
      const fakeTx = {
        select: () => ({ from: () => ({ where: () => Promise.resolve(selectResult) }) }),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            updateSets.push(values)
            return { where: () => Promise.resolve(undefined) }
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      return fn(fakeTx)
    })
  })

  describe('getBillingStatus', () => {
    it('returns null when there is no session', async () => {
      getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })
      expect(await getBillingStatus()).toBeNull()
      expect(withUserContextMock).not.toHaveBeenCalled()
    })

    it('returns the caller\'s own plan + hasSubscription, scoped via withUserContext', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'monthly' })
      selectResult = [{ plan: 'monthly', stripeSubscriptionId: 'sub_1' }]

      const status = await getBillingStatus()

      expect(status).toEqual({ plan: 'monthly', hasSubscription: true })
      expect(withUserContextMock).toHaveBeenCalledWith(USER_ID, expect.any(Function))
    })

    it('reports hasSubscription: false for a free user with no subscription id', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeSubscriptionId: null }]

      expect(await getBillingStatus()).toEqual({ plan: 'free', hasSubscription: false })
    })
  })

  describe('createCheckoutSession', () => {
    beforeEach(() => {
      process.env.STRIPE_PRICE_MONTHLY = 'price_monthly'
      process.env.STRIPE_PRICE_SEMESTER = 'price_semester'
      checkoutSessionsCreateMock.mockResolvedValue({ url: 'https://checkout.stripe.com/test' } as never)
    })

    it('throws Unauthorized-mapped error when there is no session', async () => {
      getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })
      await expect(createCheckoutSession('monthly')).rejects.toThrow('Failed to start checkout')
      expect(checkoutSessionsCreateMock).not.toHaveBeenCalled()
    })

    it('throws when rate-limited', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      limitRequestMock.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: 0 })
      await expect(createCheckoutSession('monthly')).rejects.toThrow('Failed to start checkout')
      expect(checkoutSessionsCreateMock).not.toHaveBeenCalled()
    })

    it('throws when the plan has no configured price id', async () => {
      delete process.env.STRIPE_PRICE_MONTHLY
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      await expect(createCheckoutSession('monthly')).rejects.toThrow('Failed to start checkout')
    })

    it('refuses a second checkout for a user who already has an active subscription', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'monthly' })
      selectResult = [{ plan: 'monthly', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' }]

      await expect(createCheckoutSession('monthly')).rejects.toThrow('You already have an active subscription')
      expect(checkoutSessionsCreateMock).not.toHaveBeenCalled()
    })

    it('creates a subscription-mode checkout session with client_reference_id + subscription_data.metadata.userId set (webhook resolution depends on this)', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeCustomerId: null, stripeSubscriptionId: null }]

      const res = await createCheckoutSession('semester')

      expect(res.url).toBe('https://checkout.stripe.com/test')
      expect(checkoutSessionsCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: 'price_semester', quantity: 1 }],
          client_reference_id: USER_ID,
          metadata: { plan: 'semester' },
          subscription_data: { metadata: { userId: USER_ID, plan: 'semester' } },
        })
      )
    })

    it('reuses an existing Stripe customer id when the user has one', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeCustomerId: 'cus_existing', stripeSubscriptionId: null }]

      await createCheckoutSession('monthly')

      expect(checkoutSessionsCreateMock).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_existing' }))
    })
  })

  describe('cancelSubscription', () => {
    it('throws Unauthorized-mapped error when there is no session', async () => {
      getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })
      await expect(cancelSubscription()).rejects.toThrow('Failed to cancel subscription')
      expect(cancelStripeSubscriptionMock).not.toHaveBeenCalled()
    })

    it('cancels at Stripe FIRST, then sets plan free + clears the subscription id', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'monthly' })
      selectResult = [{ stripeSubscriptionId: 'sub_1' }]
      cancelStripeSubscriptionMock.mockResolvedValue(undefined)

      const res = await cancelSubscription()

      expect(res).toEqual({ success: true })
      expect(cancelStripeSubscriptionMock).toHaveBeenCalledWith('sub_1')
      expect(updateSets).toEqual([{ plan: 'free', stripeSubscriptionId: null }])
    })

    it('is a no-op cancel-at-Stripe call when the user has no stored subscription id, but still normalizes the row', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ stripeSubscriptionId: null }]

      await cancelSubscription()

      expect(cancelStripeSubscriptionMock).not.toHaveBeenCalled()
      expect(updateSets).toEqual([{ plan: 'free', stripeSubscriptionId: null }])
    })

    it('does NOT touch the DB when the Stripe cancel call fails — never claims billing stopped when it did not', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'monthly' })
      selectResult = [{ stripeSubscriptionId: 'sub_1' }]
      cancelStripeSubscriptionMock.mockRejectedValue(new Error('Stripe is down'))

      await expect(cancelSubscription()).rejects.toThrow("couldn't cancel your subscription")
      expect(updateSets).toHaveLength(0)
    })
  })
})

// priceIdForPlan is exercised directly (not just indirectly through
// createCheckoutSession) so a broken env-var mapping fails here first.
describe('priceIdForPlan (sanity, real import)', () => {
  it('is the real lib/billing.ts implementation, not swallowed by the partial mock above', () => {
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly'
    expect(priceIdForPlan('monthly')).toBe('price_monthly')
  })
})

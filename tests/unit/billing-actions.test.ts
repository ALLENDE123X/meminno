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
  stripe: { checkout: { sessions: { create: vi.fn() } }, subscriptions: { retrieve: vi.fn() } },
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
const subscriptionsRetrieveMock = vi.mocked(stripe.subscriptions.retrieve)
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
    subscriptionsRetrieveMock.mockResolvedValue({
      cancel_at_period_end: false,
      items: { data: [{ current_period_end: null }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
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

      expect(status).toEqual({ plan: 'monthly', hasSubscription: true, cancelAtPeriodEnd: false, currentPeriodEnd: null })
      expect(withUserContextMock).toHaveBeenCalledWith(USER_ID, expect.any(Function))
      expect(subscriptionsRetrieveMock).toHaveBeenCalledWith('sub_1')
    })

    it('reports hasSubscription: false for a free user with no subscription id, and never calls Stripe', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeSubscriptionId: null }]

      expect(await getBillingStatus()).toEqual({ plan: 'free', hasSubscription: false, cancelAtPeriodEnd: false, currentPeriodEnd: null })
      expect(subscriptionsRetrieveMock).not.toHaveBeenCalled()
    })

    it('reports a scheduled cancellation and its period end, live-read from Stripe (not stored in the DB)', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'weekly' })
      selectResult = [{ plan: 'weekly', stripeSubscriptionId: 'sub_1' }]
      subscriptionsRetrieveMock.mockResolvedValue({
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: 1_800_000_000 }] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const status = await getBillingStatus()

      expect(status).toEqual({ plan: 'weekly', hasSubscription: true, cancelAtPeriodEnd: true, currentPeriodEnd: 1_800_000_000 })
    })

    it('fails closed to "not scheduled to cancel" when the Stripe read itself fails', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'monthly' })
      selectResult = [{ plan: 'monthly', stripeSubscriptionId: 'sub_1' }]
      subscriptionsRetrieveMock.mockRejectedValue(new Error('network'))

      expect(await getBillingStatus()).toEqual({ plan: 'monthly', hasSubscription: true, cancelAtPeriodEnd: false, currentPeriodEnd: null })
    })
  })

  describe('createCheckoutSession', () => {
    beforeEach(() => {
      process.env.STRIPE_PRICE_MONTHLY = 'price_monthly'
      process.env.STRIPE_PRICE_WEEKLY = 'price_weekly'
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

      const res = await createCheckoutSession('weekly')

      expect(res.url).toBe('https://checkout.stripe.com/test')
      expect(checkoutSessionsCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: 'price_weekly', quantity: 1 }],
          client_reference_id: USER_ID,
          metadata: { plan: 'weekly' },
          subscription_data: { metadata: { userId: USER_ID, plan: 'weekly' } },
        })
      )
    })

    // Regression guard for the Managed Payments outage: this account rejects
    // `payment_method_types` outright, and while it was being sent EVERY
    // checkout on EVERY plan failed with a redacted 500 — the Subscribe
    // button had never once produced a session since MEM-011. See the long
    // comment at the `stripe.checkout.sessions.create` call site in
    // app/billing/actions.ts before re-adding it. Asserted as an absence, so
    // it fails loudly if a future edit copies the parameter back in from
    // Propinno's older account's still-valid version of this same function.
    it('never sends payment_method_types — Managed Payments rejects it and breaks checkout on every plan', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeCustomerId: null, stripeSubscriptionId: null }]

      await createCheckoutSession('weekly')
      await createCheckoutSession('monthly')

      expect(checkoutSessionsCreateMock).toHaveBeenCalledTimes(2)
      for (const [params] of checkoutSessionsCreateMock.mock.calls) {
        expect(params).not.toHaveProperty('payment_method_types')
      }
    })

    // MEM-039 (issue #89). Still the correct behaviour for any environment
    // where the price id is genuinely absent (CI, Preview, a fresh local
    // checkout), even though STRIPE_PRICE_WEEKLY is now set in Vercel
    // Production: refuse before reaching Stripe rather than opening a
    // checkout against a bad/absent price.
    it('fails closed on weekly when STRIPE_PRICE_WEEKLY is unset, without calling Stripe', async () => {
      delete process.env.STRIPE_PRICE_WEEKLY
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeCustomerId: null, stripeSubscriptionId: null }]

      await expect(createCheckoutSession('weekly')).rejects.toThrow('Failed to start checkout')
      expect(checkoutSessionsCreateMock).not.toHaveBeenCalled()
    })

    // Semester is withdrawn from sale (MEM-039). The zod enum is the runtime
    // gate — the `Plan` type alone wouldn't stop a stale client, or a
    // hand-crafted server-action request, from asking for it.
    it('refuses a checkout for the withdrawn semester plan', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ plan: 'free', stripeCustomerId: null, stripeSubscriptionId: null }]

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the compile-time Plan union to prove the runtime gate
      await expect(createCheckoutSession('semester' as any)).rejects.toThrow('Failed to start checkout')
      expect(checkoutSessionsCreateMock).not.toHaveBeenCalled()
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

    it('schedules cancellation at Stripe and does NOT touch the DB — plan stays until Stripe fires customer.subscription.deleted at period end', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'monthly' })
      selectResult = [{ stripeSubscriptionId: 'sub_1' }]
      cancelStripeSubscriptionMock.mockResolvedValue({ currentPeriodEnd: 1_800_000_000 })

      const res = await cancelSubscription()

      expect(res).toEqual({ success: true, currentPeriodEnd: 1_800_000_000 })
      expect(cancelStripeSubscriptionMock).toHaveBeenCalledWith('sub_1')
      expect(updateSets).toHaveLength(0)
    })

    it('is a no-op when the user has no stored subscription id', async () => {
      getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
      selectResult = [{ stripeSubscriptionId: null }]

      const res = await cancelSubscription()

      expect(cancelStripeSubscriptionMock).not.toHaveBeenCalled()
      expect(res).toEqual({ success: true, currentPeriodEnd: null })
      expect(updateSets).toHaveLength(0)
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

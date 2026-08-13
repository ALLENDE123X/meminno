import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Stripe SDK mock -------------------------------------------------------
const mockSubscriptionsUpdate = vi.fn()
const mockSubscriptionsRetrieve = vi.fn()
vi.mock('@/lib/stripe', () => ({
  stripe: {
    subscriptions: {
      update: (...args: unknown[]) => mockSubscriptionsUpdate(...args),
      retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args),
    },
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// --- withUserContext mock ---------------------------------------------
// lib/billing.ts (unlike Propinno's, which has no RLS) can never touch
// `db` directly — every read/write goes through withUserContext(userId,
// fn), which here opens a fresh fake "transaction" scoped to that userId.
// Reads: tx.select({...}).from(users).where(...) -> next queued row set
// (selectRows, FIFO). Writes: tx.update(users).set({...}).where(...) ->
// recorded into `updates`, tagged with the userId withUserContext was
// called with, so tests can assert queries were scoped to the right user
// (something Propinno's equivalent test has no need to check at all).
//
// The factory below only returns a thin wrapper arrow function, never a
// direct reference to an outer const — see ARCHITECTURE.md's "AI notes
// generation" section for why: vi.mock() factories are hoisted above the
// module's own top-level declarations, so directly returning an
// already-initialized outer const throws "Cannot access before
// initialization"; wrapping it in a nested arrow function defers the
// reference until call time, after the module has finished initializing.
const selectRows: unknown[][] = []
const updates: { userId: string; values: Record<string, unknown> }[] = []

async function withUserContextImpl(userId: string, fn: (tx: unknown) => unknown) {
  const selectWhere = vi.fn(async () => selectRows.shift() ?? [])
  const from = vi.fn(() => ({ where: selectWhere }))
  const select = vi.fn(() => ({ from }))

  const updateWhere = vi.fn(async () => undefined)
  const set = vi.fn((values: Record<string, unknown>) => {
    updates.push({ userId, values })
    return { where: updateWhere }
  })
  const update = vi.fn(() => ({ set }))

  return fn({ select, update })
}

vi.mock('@/lib/db', () => ({
  withUserContext: (...args: [string, (tx: unknown) => unknown]) => withUserContextImpl(...args),
}))

import {
  handleStripeWebhookEvent,
  cancelStripeSubscription,
  currentPeriodEndFromSubscription,
  subscriptionIdFromInvoice,
  priceIdForPlan,
} from '@/lib/billing'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUB_ID = 'sub_test_123'
const CUSTOMER_ID = 'cus_test_123'
const PERIOD_END = 1_800_000_000 // arbitrary unix seconds, only used for equality checks

function subscriptionObject(
  overrides: Partial<{ id: string; status: string; metadata: Record<string, string>; currentPeriodEnd: number | null }> = {}
) {
  return {
    id: overrides.id ?? SUB_ID,
    status: overrides.status ?? 'active',
    metadata: overrides.metadata ?? { userId: USER_ID, plan: 'monthly' },
    items: { data: [{ current_period_end: overrides.currentPeriodEnd ?? PERIOD_END }] },
  }
}

// Minimal event shapes — the handlers only read the fields asserted here.
/* eslint-disable @typescript-eslint/no-explicit-any */
function event(type: string, object: unknown): any {
  return { type, data: { object } }
}

beforeEach(() => {
  vi.clearAllMocks()
  selectRows.length = 0
  updates.length = 0
  mockSubscriptionsRetrieve.mockResolvedValue(subscriptionObject())
  mockSubscriptionsUpdate.mockResolvedValue(subscriptionObject({ status: 'active' }))
  delete process.env.STRIPE_PRICE_MONTHLY
  delete process.env.STRIPE_PRICE_WEEKLY
})

describe('priceIdForPlan', () => {
  it('reads the env var for each plan', () => {
    process.env.STRIPE_PRICE_WEEKLY = 'price_weekly'
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly'
    expect(priceIdForPlan('weekly')).toBe('price_weekly')
    expect(priceIdForPlan('monthly')).toBe('price_monthly')
  })

  it('returns null when the env var is unset', () => {
    expect(priceIdForPlan('monthly')).toBeNull()
  })

  // MEM-039 (issue #89): STRIPE_PRICE_WEEKLY is not provisioned yet — the
  // real Stripe Price is created by Pranav directly, outside this change.
  // The unset case is therefore the CURRENT production state, not a
  // hypothetical: it must return null through the existing fallback (so
  // createCheckoutSession refuses before ever calling Stripe), never throw
  // and never fall through to some other plan's price id.
  it('returns null for weekly while STRIPE_PRICE_WEEKLY is unprovisioned, without borrowing the monthly price', () => {
    process.env.STRIPE_PRICE_MONTHLY = 'price_monthly'
    expect(priceIdForPlan('weekly')).toBeNull()
  })
})

describe('subscriptionIdFromInvoice', () => {
  it('reads the subscription from invoice.parent.subscription_details (dahlia API shape)', () => {
    const invoice = { parent: { subscription_details: { subscription: SUB_ID } } } as any
    expect(subscriptionIdFromInvoice(invoice)).toBe(SUB_ID)
  })

  it('unwraps an expanded subscription object', () => {
    const invoice = { parent: { subscription_details: { subscription: { id: SUB_ID } } } } as any
    expect(subscriptionIdFromInvoice(invoice)).toBe(SUB_ID)
  })

  it('returns null for a non-subscription invoice', () => {
    expect(subscriptionIdFromInvoice({ parent: null } as any)).toBeNull()
    expect(subscriptionIdFromInvoice({} as any)).toBeNull()
  })
})

describe('cancelStripeSubscription', () => {
  it('schedules cancellation at period end (not an immediate cancel) and returns when access ends', async () => {
    const result = await cancelStripeSubscription(SUB_ID)
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith(SUB_ID, { cancel_at_period_end: true })
    expect(result).toEqual({ currentPeriodEnd: PERIOD_END })
  })

  it('is idempotent when the subscription no longer exists', async () => {
    mockSubscriptionsUpdate.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }))
    await expect(cancelStripeSubscription(SUB_ID)).resolves.toEqual({ currentPeriodEnd: null })
  })

  it('is idempotent when the subscription is already canceled', async () => {
    mockSubscriptionsUpdate.mockRejectedValue(new Error('cannot be updated'))
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionObject({ status: 'canceled' }))
    await expect(cancelStripeSubscription(SUB_ID)).resolves.toEqual({ currentPeriodEnd: null })
  })

  it('RETHROWS when the subscription is still live — callers must not record "canceled"', async () => {
    mockSubscriptionsUpdate.mockRejectedValue(new Error('Stripe is down'))
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionObject({ status: 'active' }))
    await expect(cancelStripeSubscription(SUB_ID)).rejects.toThrow('Stripe is down')
  })
})

describe('currentPeriodEndFromSubscription', () => {
  it('reads items.data[0].current_period_end (moved off the Subscription root on this API version)', () => {
    expect(currentPeriodEndFromSubscription(subscriptionObject({ currentPeriodEnd: PERIOD_END }) as never)).toBe(PERIOD_END)
  })

  it('returns null when there are no subscription items', () => {
    expect(currentPeriodEndFromSubscription({ items: { data: [] } } as never)).toBeNull()
  })
})

describe('checkout.session.completed', () => {
  it('activates the user (plan + customer/subscription ids), scoped via withUserContext to the checkout userId', async () => {
    await handleStripeWebhookEvent(event('checkout.session.completed', {
      id: 'cs_1',
      client_reference_id: USER_ID,
      metadata: { plan: 'weekly' },
      subscription: SUB_ID,
      customer: CUSTOMER_ID,
    }))

    expect(updates).toHaveLength(1)
    expect(updates[0].userId).toBe(USER_ID)
    expect(updates[0].values).toMatchObject({
      plan: 'weekly',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    })
  })

  it('unwraps expanded customer/subscription objects', async () => {
    await handleStripeWebhookEvent(event('checkout.session.completed', {
      id: 'cs_1',
      client_reference_id: USER_ID,
      metadata: { plan: 'monthly' },
      subscription: { id: SUB_ID },
      customer: { id: CUSTOMER_ID },
    }))

    expect(updates[0].values).toMatchObject({ stripeCustomerId: CUSTOMER_ID, stripeSubscriptionId: SUB_ID })
  })

  it('defaults plan to "monthly" when metadata.plan is missing', async () => {
    await handleStripeWebhookEvent(event('checkout.session.completed', {
      id: 'cs_1', client_reference_id: USER_ID, metadata: {}, subscription: SUB_ID, customer: CUSTOMER_ID,
    }))
    expect(updates[0].values).toMatchObject({ plan: 'monthly' })
  })

  it('does nothing without a client_reference_id', async () => {
    await handleStripeWebhookEvent(event('checkout.session.completed', { id: 'cs_1', client_reference_id: null }))
    expect(updates).toHaveLength(0)
  })
})

describe('invoice.payment_succeeded (renewal)', () => {
  const renewalInvoice = {
    id: 'in_1',
    billing_reason: 'subscription_cycle',
    customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUB_ID } },
  }

  it('resolves the user from the retrieved subscription\'s metadata.userId and re-affirms plan + subscription id', async () => {
    selectRows.push([{ id: USER_ID, plan: 'monthly', stripeSubscriptionId: SUB_ID }])

    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith(SUB_ID)
    expect(updates).toHaveLength(1)
    expect(updates[0].userId).toBe(USER_ID)
    expect(updates[0].values).toEqual({ plan: 'monthly', stripeSubscriptionId: SUB_ID })
  })

  // MEM-039 (issue #89): a weekly subscription renews every 7 days rather
  // than every 30, so this handler runs ~4x as often per subscriber as it
  // used to — pin that the new tier round-trips its own plan value from the
  // subscription's metadata instead of being coerced to 'monthly'.
  it('carries a weekly plan through a renewal from the subscription metadata', async () => {
    selectRows.push([{ id: USER_ID, plan: 'weekly', stripeSubscriptionId: SUB_ID }])
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionObject({ metadata: { userId: USER_ID, plan: 'weekly' } }))

    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))

    expect(updates).toEqual([{ userId: USER_ID, values: { plan: 'weekly', stripeSubscriptionId: SUB_ID } }])
  })

  it('IGNORES the first invoice of a new subscription (already handled at checkout)', async () => {
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', {
      ...renewalInvoice, billing_reason: 'subscription_create',
    }))
    expect(updates).toHaveLength(0)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('does nothing when the invoice carries no subscription id', async () => {
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', {
      ...renewalInvoice, parent: null,
    }))
    expect(updates).toHaveLength(0)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('does nothing when the subscription cannot be retrieved from Stripe', async () => {
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('network'))
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates).toHaveLength(0)
  })

  it('does nothing when the subscription has no userId in its metadata', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue(subscriptionObject({ metadata: {} }))
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates).toHaveLength(0)
    expect(selectRows).toHaveLength(0) // never even attempted a DB read
  })

  it('does nothing when no matching user row exists', async () => {
    selectRows.push([])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates).toHaveLength(0)
  })

  // Stale-event guard: a redelivered/late renewal invoice for a
  // subscription the user has since replaced must not stomp the current
  // one back onto the row.
  it('IGNORES a stale renewal for a subscription the user has already replaced', async () => {
    selectRows.push([{ id: USER_ID, plan: 'monthly', stripeSubscriptionId: 'sub_new_B' }])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates).toHaveLength(0)
  })

  it('self-heals a row whose stripeSubscriptionId had been nulled (e.g. a missed webhook)', async () => {
    selectRows.push([{ id: USER_ID, plan: 'monthly', stripeSubscriptionId: null }])
    await handleStripeWebhookEvent(event('invoice.payment_succeeded', renewalInvoice))
    expect(updates).toEqual([{ userId: USER_ID, values: { plan: 'monthly', stripeSubscriptionId: SUB_ID } }])
  })
})

describe('customer.subscription.deleted', () => {
  it('reverts plan to free and clears the stored subscription id, resolving the user directly from the event payload (no extra Stripe call)', async () => {
    selectRows.push([{ id: USER_ID, plan: 'monthly', stripeSubscriptionId: SUB_ID }])

    await handleStripeWebhookEvent(event('customer.subscription.deleted', subscriptionObject()))

    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
    expect(updates).toEqual([{ userId: USER_ID, values: { plan: 'free', stripeSubscriptionId: null } }])
  })

  it('does nothing when the subscription has no userId in its metadata', async () => {
    await handleStripeWebhookEvent(event('customer.subscription.deleted', subscriptionObject({ metadata: {} })))
    expect(updates).toHaveLength(0)
  })

  it('does nothing when no matching user row exists', async () => {
    selectRows.push([])
    await handleStripeWebhookEvent(event('customer.subscription.deleted', subscriptionObject()))
    expect(updates).toHaveLength(0)
  })

  // Same stale-event class as the renewal handler: a deleted event for an
  // OLD subscription must not revert a user who has since re-subscribed.
  it('IGNORES a stale deleted event for a subscription the user has already replaced', async () => {
    selectRows.push([{ id: USER_ID, plan: 'monthly', stripeSubscriptionId: 'sub_new_B' }])
    await handleStripeWebhookEvent(event('customer.subscription.deleted', subscriptionObject({ id: 'sub_old_A' })))
    expect(updates).toHaveLength(0)
  })
})

describe('unhandled event types', () => {
  it('are a no-op, not a crash', async () => {
    await expect(handleStripeWebhookEvent(event('payment_intent.succeeded', {}))).resolves.toBeUndefined()
    expect(updates).toHaveLength(0)
  })
})

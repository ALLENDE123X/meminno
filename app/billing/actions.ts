'use server'

// MEM-011. Server actions for the /billing page — checkout creation, reading
// the caller's own billing status, and cancelling. Mirrors Propinno's
// app/checkout/actions.ts shape (rate-limit -> session check -> validate ->
// Stripe call -> DB write, every failure logged and re-thrown as a plain
// user-facing message), adapted to this app's real session helper
// (lib/session.ts's getSessionUser(), Supabase Auth-backed, not a raw
// cookie UUID) and RLS-scoped DB access (withUserContext, not a bare
// db.select()/db.update() — see lib/db/index.ts).
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { headers } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import { withUserContext } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { stripe } from '@/lib/stripe'
import { cancelStripeSubscription, currentPeriodEndFromSubscription, priceIdForPlan, type Plan } from '@/lib/billing'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'

// MEM-039 (issue #89): 'semester' is withdrawn from sale, 'weekly' added —
// must stay in lockstep with lib/billing.ts's `Plan` union, which this
// validates at runtime for a value that arrives from a client component.
const checkoutSchema = z.object({ plan: z.enum(['weekly', 'monthly']) })

export type BillingStatus = {
  plan: string
  hasSubscription: boolean
  // Live-read from Stripe (not stored — this schema has no column for it),
  // since cancelSubscription() below deliberately does NOT flip `plan` to
  // 'free' at cancel time (see lib/billing.ts's "ONE MORE DEVIATION" note).
  // Without this, a page reload after cancelling would show no sign a
  // cancellation is scheduled at all.
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: number | null
}

/** The caller's own current plan/subscription state, for the /billing page. */
export async function getBillingStatus(): Promise<BillingStatus | null> {
  const session = await getSessionUser()
  if (!session.ok) return null

  const [row] = await withUserContext(session.userId, (tx) =>
    tx
      .select({ plan: users.plan, stripeSubscriptionId: users.stripeSubscriptionId })
      .from(users)
      .where(eq(users.id, session.userId))
  )
  if (!row) return null

  let cancelAtPeriodEnd = false
  let currentPeriodEnd: number | null = null
  if (row.stripeSubscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
      cancelAtPeriodEnd = subscription.cancel_at_period_end
      currentPeriodEnd = cancelAtPeriodEnd ? currentPeriodEndFromSubscription(subscription) : null
    } catch (err) {
      // Fail closed to "not scheduled to cancel" — a transient Stripe read
      // failure here shouldn't block the page from rendering at all, and
      // understating the cancellation state is the safer default (worst
      // case the user sees the normal "renews automatically" copy and can
      // still successfully re-cancel, which is idempotent).
      logger.error({ err, userId: session.userId, subscriptionId: row.stripeSubscriptionId }, 'getBillingStatus: subscription retrieve failed')
    }
  }

  return { plan: row.plan, hasSubscription: !!row.stripeSubscriptionId, cancelAtPeriodEnd, currentPeriodEnd }
}

export async function createCheckoutSession(plan: Plan): Promise<{ url: string | null }> {
  let alreadySubscribed = false
  try {
    const session = await getSessionUser()
    if (!session.ok) throw new Error('Unauthorized')

    // meminno- prefix: this Upstash Redis instance is shared with Propinno
    // (see CLAUDE.md's credential-reuse map) — every key this app writes
    // must be namespaced. Keyed by userId (a verified session, unlike
    // Propinno's IP-keyed limiter, which only has a raw cookie UUID to
    // trust at this layer).
    const rateLimit = await limitRequest(`meminno-billing-checkout:${session.userId}`)
    if (!rateLimit.success) throw new Error('Too many requests')

    const parsed = checkoutSchema.parse({ plan })
    const priceId = priceIdForPlan(parsed.plan)
    if (!priceId) throw new Error(`Stripe price not configured for plan: ${parsed.plan}`)

    const [user] = await withUserContext(session.userId, (tx) =>
      tx
        .select({ plan: users.plan, stripeCustomerId: users.stripeCustomerId, stripeSubscriptionId: users.stripeSubscriptionId })
        .from(users)
        .where(eq(users.id, session.userId))
    )
    if (!user) throw new Error('Unauthorized')

    // Refuse a second checkout for someone who already has a live
    // subscription — a duplicate purchase would leave them paying two
    // subscriptions against one account, with only one cancellable from
    // this page. Same guard Propinno's createCheckoutSession has.
    if (user.plan !== 'free' && user.stripeSubscriptionId) {
      alreadySubscribed = true
      throw new Error('You already have an active subscription')
    }

    const headersList = await headers()
    const host = headersList.get('host') || 'localhost:3000'
    const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https'
    const origin = `${protocol}://${host}`

    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${origin}/billing?success=true`,
      cancel_url: `${origin}/billing?canceled=true`,
      client_reference_id: session.userId,
      metadata: { plan: parsed.plan },
      // Reuse the existing Stripe customer on re-subscribe so one account
      // doesn't accumulate a new customer per purchase.
      ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : {}),
      // Load-bearing, not just for tracing (unlike Propinno's identical-
      // looking field): lib/billing.ts's webhook handlers resolve which
      // user a renewal/deletion event belongs to FROM this metadata, since
      // an unscoped cross-user DB lookup is impossible under this app's RLS
      // policies (see lib/billing.ts's header comment).
      subscription_data: { metadata: { userId: session.userId, plan: parsed.plan } },
    })

    return { url: checkoutSession.url }
  } catch (err) {
    logger.error({ err, plan, alreadySubscribed }, 'createCheckoutSession failed')
    if (alreadySubscribed) {
      throw new Error('You already have an active subscription — refresh this page to see it.')
    }
    throw new Error('Failed to start checkout. Please try again.')
  }
}

/**
 * "Cancel subscription". Meminno has no equivalent to Propinno's
 * automatic "I found a place" product-completion trigger (no "I'm done
 * studying" concept exists in this product) — see this ticket's PR
 * description for that scope decision. This is instead a plain, manual
 * account action: the baseline requirement that comes with selling real
 * recurring subscriptions is that a subscriber must have SOME way to stop
 * being billed without emailing support.
 *
 * Deliberately does NOT flip `plan` to 'free' or clear `stripeSubscriptionId`
 * here (a change made after this PR's merge review — see lib/billing.ts's
 * "ONE MORE DEVIATION" note): cancelStripeSubscription() below only
 * schedules the cancellation for the end of the current billing period, so
 * the user keeps their paid entitlement until then. The row gets reverted
 * to 'free' for real once Stripe fires `customer.subscription.deleted` at
 * the actual period end (lib/billing.ts's handleSubscriptionDeleted) — same
 * webhook path every other deletion already goes through, nothing new
 * needed there. If the Stripe call itself fails, surface an error and
 * change nothing — cancelStripeSubscription() is idempotent, so retrying is
 * the correct recovery.
 */
export async function cancelSubscription(): Promise<{ success: true; currentPeriodEnd: number | null }> {
  let cancelFailed = false
  try {
    const session = await getSessionUser()
    if (!session.ok) throw new Error('Unauthorized')

    const rateLimit = await limitRequest(`meminno-billing-cancel:${session.userId}`)
    if (!rateLimit.success) throw new Error('Too many requests')

    const [user] = await withUserContext(session.userId, (tx) =>
      tx.select({ stripeSubscriptionId: users.stripeSubscriptionId }).from(users).where(eq(users.id, session.userId))
    )
    if (!user) throw new Error('Unauthorized')

    if (!user.stripeSubscriptionId) {
      return { success: true, currentPeriodEnd: null }
    }

    let currentPeriodEnd: number | null = null
    try {
      const result = await cancelStripeSubscription(user.stripeSubscriptionId)
      currentPeriodEnd = result.currentPeriodEnd
      logger.info({ userId: session.userId, subscriptionId: user.stripeSubscriptionId, currentPeriodEnd, action: 'stripe_subscription_cancel_scheduled' })
    } catch (err) {
      cancelFailed = true
      throw err
    }

    return { success: true, currentPeriodEnd }
  } catch (err) {
    logger.error({ err, cancelFailed }, 'cancelSubscription failed')
    if (cancelFailed) {
      throw new Error("We couldn't cancel your subscription just now, so nothing has changed. Please try again in a moment.")
    }
    throw new Error('Failed to cancel subscription. Please try again later.')
  }
}

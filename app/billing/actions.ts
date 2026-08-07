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
import { cancelStripeSubscription, priceIdForPlan, type Plan } from '@/lib/billing'
import { limitRequest } from '@/lib/ratelimit'
import { logger } from '@/lib/logger'

const checkoutSchema = z.object({ plan: z.enum(['monthly', 'semester']) })

export type BillingStatus = { plan: string; hasSubscription: boolean }

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
  return { plan: row.plan, hasSubscription: !!row.stripeSubscriptionId }
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
 * Ordering is deliberate and copied from Propinno's markFoundPlace(): cancel
 * at Stripe FIRST, write 'free' to the DB only after that succeeds. If the
 * cancellation fails, surface an error and leave the row untouched rather
 * than recording a state that claims billing stopped when it didn't — the
 * action is idempotent, so retrying is the correct recovery.
 */
export async function cancelSubscription(): Promise<{ success: true }> {
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

    if (user.stripeSubscriptionId) {
      try {
        await cancelStripeSubscription(user.stripeSubscriptionId)
        logger.info({ userId: session.userId, subscriptionId: user.stripeSubscriptionId, action: 'stripe_subscription_canceled' })
      } catch (err) {
        cancelFailed = true
        throw err
      }
    }

    await withUserContext(session.userId, (tx) =>
      tx.update(users).set({ plan: 'free', stripeSubscriptionId: null }).where(eq(users.id, session.userId))
    )

    return { success: true }
  } catch (err) {
    logger.error({ err, cancelFailed }, 'cancelSubscription failed')
    if (cancelFailed) {
      throw new Error("We couldn't cancel your subscription just now, so nothing has changed. Please try again in a moment.")
    }
    throw new Error('Failed to cancel subscription. Please try again later.')
  }
}

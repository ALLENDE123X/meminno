/**
 * Recurring-subscription billing lifecycle (MEM-011, real GitHub issue #11).
 *
 * Ported from the Propinno sibling project's lib/billing.ts (named directly
 * in this ticket's dispatch as the closest existing precedent), adapted for
 * two real differences in Meminno's own design:
 *
 *   1. SCHEMA: `users` here has no `status`/`accessExpiresAt` columns —
 *      just `plan` ('free' | 'monthly' | 'semester'), `stripeCustomerId`,
 *      `stripeSubscriptionId` (see lib/db/schema.ts, provisioned by
 *      MEM-002). There is no fixed-length "access window" to extend on
 *      renewal or expire on deletion; `plan` IS the current entitlement,
 *      kept in sync by whichever webhook last fired. That makes this module
 *      simpler than Propinno's: no `planDays`/`subscriptionPeriodEnd`
 *      arithmetic, no expiry-extension logic on renewal.
 *
 *   2. RLS: unlike Propinno (single trusted DB role, no RLS), every query
 *      here MUST go through withUserContext(userId, fn) — see
 *      lib/db/index.ts's header comment. Every user table is FORCE ROW
 *      LEVEL SECURITY with a policy scoped to `current_user_id = id`, so a
 *      bare `db.select()` (Propinno's own pattern) returns ZERO rows, and
 *      there is no service-role-equivalent escape hatch on this project
 *      (see CLAUDE.md HARD STOP 7 — granting one is explicitly off-limits
 *      without Pranav's go-ahead). That's a real problem for a webhook
 *      handler: `invoice.payment_succeeded`/`customer.subscription.deleted`
 *      arrive with a Stripe customer/subscription id, not a Meminno userId,
 *      so a naive port of Propinno's `findUserForSubscription()` (an
 *      unscoped `WHERE stripe_subscription_id = ...` scan across ALL
 *      users) is structurally impossible here — it would return nothing,
 *      every time, by design.
 *
 *      The fix does NOT touch any role/grant/RLS policy. Instead, this
 *      module always resolves the target userId from data Stripe itself
 *      hands back to us, which we control at checkout-creation time:
 *        - checkout.session.completed: `session.client_reference_id`,
 *          exactly like Propinno.
 *        - invoice.payment_succeeded: the invoice doesn't carry our
 *          metadata, but its subscription does — retrieve the subscription
 *          (a real Stripe API read) and use `subscription.metadata.userId`.
 *        - customer.subscription.deleted: the event's own payload IS the
 *          Subscription object, so `subscription.metadata.userId` is
 *          already right there, no extra API call needed.
 *      `subscription_data: { metadata: { userId, plan } }` is set on every
 *      checkout session below specifically so this always resolves. Once
 *      userId is known, every DB touch goes through withUserContext(userId,
 *      ...) like everywhere else in this app — never a cross-user scan.
 *      This is arguably MORE robust than Propinno's DB-lookup fallback (it
 *      doesn't depend on our own row already having the right id stored),
 *      not a downgrade forced by the constraint.
 *
 * What IS kept identical to Propinno, because the underlying risks are the
 * same: forced tool-... er, forced webhook event subscription list
 * (exactly the 3 types below — confirmed live via a read-only
 * `stripe.webhookEndpoints.list()` call against Meminno's own account
 * during this ticket's verification, see the PR description); the
 * stale-event guard (never let a redelivered event for a subscription the
 * user has since replaced stomp the current one); `cancelStripeSubscription`
 * being idempotent; and `invoice.paid` deliberately NOT also being handled
 * (same event as `invoice.payment_succeeded` for a renewal — subscribing to
 * both would double-process every cycle).
 *
 * ONE MORE DEVIATION, added post-review (merge-evaluation of this PR, see
 * ARCHITECTURE.md): `cancelStripeSubscription` schedules cancellation at
 * period end (`cancel_at_period_end: true`) instead of cancelling
 * immediately like Propinno's version. Propinno's immediate cancel is
 * correct there because it's triggered by "I found a place" — a
 * user-declared completion event where continuing access serves no purpose.
 * Meminno's "Cancel subscription" button has no such signal; it is a plain
 * account action, and cancelling immediately would forfeit the rest of a
 * period the user already paid for (up to ~4 months on the Semester plan)
 * with no refund — a real consumer-disclosure problem on a live-money path,
 * not just a UX nitpick. `cancel_at_period_end` is the industry-standard
 * fix: no further charge is ever attempted, and `plan` only reverts to
 * 'free' once Stripe itself fires `customer.subscription.deleted` at the
 * actual end of the period — `handleSubscriptionDeleted` below already
 * handles that correctly and needed no changes for this.
 *
 * API-VERSION NOTE (`2026-07-29.dahlia`, see lib/stripe.ts — a slightly
 * newer `.dahlia` pin than Propinno's own `2026-05-27.dahlia`, inherited
 * from this repo's MEM-001 scaffold rather than copied from Propinno): the
 * Invoice object on this version likewise has NO top-level `subscription`
 * field — it's `invoice.parent.subscription_details.subscription`. Verified
 * against the installed `stripe@22` type definitions (same major version
 * Propinno pins), not assumed from Propinno's own code.
 */

import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { withUserContext } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { stripe } from '@/lib/stripe'
import { logger } from '@/lib/logger'

export type Plan = 'monthly' | 'semester'

/** Maps a plan to the env var holding its live Stripe Price id. */
export function priceIdForPlan(plan: Plan): string | null {
  const priceId = plan === 'monthly' ? process.env.STRIPE_PRICE_MONTHLY : process.env.STRIPE_PRICE_SEMESTER
  return priceId ?? null
}

/** Unwrap a Stripe `string | ExpandedObject | null` field down to a plain id. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

function stripeErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * The subscription id that generated an invoice. See the API-VERSION NOTE
 * above — `invoice.subscription` does not exist on this Stripe version.
 */
export function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  return toId(invoice.parent?.subscription_details?.subscription ?? null)
}

/**
 * A subscription's items[0].current_period_end (unix seconds), or null if
 * unavailable. On this API version (`2026-07-29.dahlia`), Stripe moved
 * `current_period_end` off the Subscription root onto each line item — a
 * subscription can have multiple items with independent billing cycles —
 * verified against the installed `stripe` package's own type definitions
 * (`SubscriptionItem.current_period_end`), not assumed. Meminno only ever
 * creates single-item subscriptions (one price per checkout), so items[0]
 * is always the one that matters here.
 */
export function currentPeriodEndFromSubscription(subscription: Stripe.Subscription): number | null {
  return subscription.items?.data?.[0]?.current_period_end ?? null
}

export type CancelResult = { currentPeriodEnd: number | null }

/**
 * Schedule a Stripe subscription to cancel at the END of its current
 * billing period (see the file header's "ONE MORE DEVIATION" note for why
 * this isn't an immediate cancel like Propinno's). No further charge is
 * ever attempted once this succeeds. Idempotent: a subscription that is
 * already gone or already canceled resolves successfully rather than
 * throwing, so a user who double-clicks "Cancel subscription" doesn't get
 * an error — and calling this twice on a subscription already scheduled to
 * cancel is harmless (Stripe just re-confirms the same flag).
 *
 * Anything else genuinely rethrows — callers MUST NOT record a "canceled"
 * state on a failure, because the subscription would still be live and
 * billing.
 */
export async function cancelStripeSubscription(subscriptionId: string): Promise<CancelResult> {
  try {
    const updated = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
    return { currentPeriodEnd: currentPeriodEndFromSubscription(updated) }
  } catch (err) {
    if (stripeErrorCode(err) === 'resource_missing') return { currentPeriodEnd: null }
    try {
      const existing = await stripe.subscriptions.retrieve(subscriptionId)
      if (existing.status === 'canceled') return { currentPeriodEnd: null }
    } catch {
      // fall through and rethrow the original error
    }
    throw err
  }
}

type BillingUser = {
  id: string
  plan: string
  stripeSubscriptionId: string | null
}

/** Reads a user's own billing columns through the RLS-scoped connection. */
async function getBillingUser(userId: string): Promise<BillingUser | null> {
  const [row] = await withUserContext(userId, (tx) =>
    tx
      .select({ id: users.id, plan: users.plan, stripeSubscriptionId: users.stripeSubscriptionId })
      .from(users)
      .where(eq(users.id, userId))
  )
  return row ?? null
}

/**
 * Resolves a Stripe Subscription's Meminno userId from `metadata.userId`,
 * set on every checkout session's `subscription_data.metadata` below. Logs
 * and returns null rather than throwing if it's ever missing (shouldn't
 * happen for a subscription this app created, but a webhook handler must
 * degrade to "ignore, don't crash" on unexpected shapes, not 500).
 */
function userIdFromSubscriptionMetadata(subscription: Stripe.Subscription, context: string): string | null {
  const userId = subscription.metadata?.userId
  if (!userId) {
    logger.error({ subscriptionId: subscription.id, context, action: 'stripe_subscription_missing_user_metadata' })
    return null
  }
  return userId
}

/**
 * Initial activation. Stores the Stripe customer + subscription ids
 * alongside the plan the checkout was for — without those ids there is no
 * way to later cancel this specific user's subscription.
 *
 * Deliberately activates without gating on `payment_status`/subscription
 * status, same reasoning as Propinno: if a card fails on the very first
 * charge, Stripe creates the subscription as `incomplete` and this event
 * still fires, so the user gets access for at most the ~23 hours Stripe
 * waits before cancelling an incomplete subscription — at which point
 * `customer.subscription.deleted` reverts `plan` to 'free' here. That
 * bounded, self-healing exposure beats stranding a genuinely paying
 * customer with no access while the first invoice settles.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.client_reference_id
  if (!userId) {
    logger.error({ sessionId: session.id, action: 'stripe_checkout_completed_no_user_ref' })
    return
  }

  const plan = (session.metadata?.plan as Plan | undefined) ?? 'monthly'
  const subscriptionId = toId(session.subscription)
  const customerId = toId(session.customer)

  await withUserContext(userId, (tx) =>
    tx
      .update(users)
      .set({
        plan,
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
      })
      .where(eq(users.id, userId))
  )

  logger.info({ userId, plan, subscriptionId, customerId, action: 'stripe_checkout_completed' })
}

/**
 * Renewal. Only `subscription_cycle` invoices are treated as a renewal:
 * `subscription_create` is the very first invoice of a brand-new
 * subscription and is already fully handled by checkout.session.completed —
 * this is the exact Propinno lesson this ticket's dispatch named directly
 * ("only when billing_reason === 'subscription_cycle'").
 *
 * There is no expiry to extend (see file header) — this exists to
 * self-heal `plan`/`stripeSubscriptionId` on the user's row in case a
 * previous webhook was missed or arrived out of order, and to detect a
 * stale/superseded event, not to compute a new access window.
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  if (invoice.billing_reason !== 'subscription_cycle') {
    logger.info({
      invoiceId: invoice.id,
      billingReason: invoice.billing_reason,
      action: 'stripe_invoice_not_a_renewal_cycle',
    })
    return
  }

  const subscriptionId = subscriptionIdFromInvoice(invoice)
  if (!subscriptionId) {
    logger.error({ invoiceId: invoice.id, action: 'stripe_renewal_invoice_missing_subscription' })
    return
  }

  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId)
  } catch (err) {
    logger.error({ err, invoiceId: invoice.id, subscriptionId, action: 'stripe_renewal_subscription_retrieve_failed' })
    return
  }

  const userId = userIdFromSubscriptionMetadata(subscription, 'invoice.payment_succeeded')
  if (!userId) return

  const user = await getBillingUser(userId)
  if (!user) {
    logger.error({ userId, subscriptionId, action: 'stripe_renewal_user_not_found' })
    return
  }

  // Stale-event guard: if this user's row already points at a DIFFERENT
  // subscription (they cancelled and re-subscribed, replacing this one),
  // a redelivered/late renewal invoice for the OLD subscription must not
  // stomp the current one back onto the row.
  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscriptionId) {
    logger.error({
      userId,
      eventSubscriptionId: subscriptionId,
      storedSubscriptionId: user.stripeSubscriptionId,
      action: 'stripe_stale_renewal_for_replaced_subscription',
    })
    return
  }

  const plan = (subscription.metadata?.plan as Plan | undefined) ?? (user.plan as Plan)

  await withUserContext(userId, (tx) =>
    tx.update(users).set({ plan, stripeSubscriptionId: subscriptionId }).where(eq(users.id, userId))
  )

  logger.info({ userId, subscriptionId, plan, action: 'stripe_subscription_renewed' })
}

/**
 * Subscription is gone — whether the user cancelled it themselves (see
 * app/billing/actions.ts's cancelSubscription()), or Stripe gave up after
 * repeated payment failures. Reverts `plan` to 'free'.
 *
 * No "done"/terminal-status equivalent exists in Meminno's schema — see
 * this ticket's report for why that piece of Propinno's design (the
 * "found a place" pattern) was deliberately not ported.
 *
 * Guarded against a stale event the same way as the renewal handler: a
 * subscription-deleted event for an OLD, already-replaced subscription
 * must not revert a user who has since re-subscribed.
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const userId = userIdFromSubscriptionMetadata(subscription, 'customer.subscription.deleted')
  if (!userId) return

  const user = await getBillingUser(userId)
  if (!user) {
    logger.error({ userId, subscriptionId: subscription.id, action: 'stripe_deleted_sub_user_not_found' })
    return
  }

  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
    logger.error({
      userId,
      eventSubscriptionId: subscription.id,
      storedSubscriptionId: user.stripeSubscriptionId,
      action: 'stripe_deleted_sub_superseded_ignored',
    })
    return
  }

  await withUserContext(userId, (tx) =>
    tx.update(users).set({ plan: 'free', stripeSubscriptionId: null }).where(eq(users.id, userId))
  )

  logger.info({ userId, subscriptionId: subscription.id, action: 'stripe_subscription_deleted' })
}

/**
 * Webhook fan-out. Meminno's live Stripe webhook endpoint
 * (https://meminno.vercel.app/api/webhooks/stripe) is confirmed — via a
 * real, read-only `stripe.webhookEndpoints.list()` call against the live
 * account during this ticket's verification, see the PR description — to
 * be subscribed to exactly these three event types, nothing else.
 *
 * `invoice.paid` is deliberately NOT also handled: same reasoning as
 * Propinno, it fires for the same renewal as `invoice.payment_succeeded`.
 */
export async function handleStripeWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
      return
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice)
      return
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription)
      return
    default:
      logger.info({ eventType: event.type, action: 'stripe_webhook_event_ignored' })
  }
}

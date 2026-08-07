import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { logger } from '@/lib/logger'
import { handleStripeWebhookEvent } from '@/lib/billing'
import { limitRequest } from '@/lib/ratelimit'

// MEM-011. Mirrors Propinno's app/api/webhooks/stripe/route.ts closely
// (verify signature -> fan out to lib/billing.ts -> 200/400/500), with two
// deliberate differences: no Sentry call (this repo has no SENTRY_DSN
// configured yet — see CLAUDE.md's credential-reuse map and every other
// lib/ module's existing "logger only" convention), and the rate-limit key
// is `meminno-`-prefixed (this Upstash Redis instance is shared with
// Propinno — see CLAUDE.md's "Every Redis key this app writes MUST be
// prefixed meminno-").
//
// This is the exact URL (https://meminno.vercel.app/api/webhooks/stripe)
// the live Stripe webhook endpoint already points at (created directly via
// the API before this ticket started, per the dispatch) — confirmed live
// during this ticket's verification via a read-only
// stripe.webhookEndpoints.list() call, see lib/billing.ts's header comment
// and the PR description.
export async function POST(req: Request) {
  const { success } = await limitRequest('meminno-stripe-webhook')
  if (!success) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const body = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Missing signature or secret' }, { status: 400 })
  }

  let event: Stripe.Event

  try {
    const { stripe } = await import('@/lib/stripe')
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err: unknown) {
    const error = err as Error
    logger.error({ action: 'stripe_webhook_verification_failed', error: error.message })
    return NextResponse.json({ error: `Webhook Error: ${error.message}` }, { status: 400 })
  }

  try {
    // Subscription lifecycle (activate / renew / expire) lives in
    // lib/billing.ts so app/billing/actions.ts's cancelSubscription() can
    // share the same cancellation logic.
    await handleStripeWebhookEvent(event)
    return NextResponse.json({ received: true })
  } catch (error) {
    logger.error({ err: error, action: 'stripe_webhook_processing_failed', eventType: event.type })
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

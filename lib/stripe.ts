import Stripe from 'stripe'

// MEM-011: this file existed as a MEM-001 scaffold stub but had no real
// consumer anywhere in the codebase until this ticket wired up billing —
// so its original "throw at module scope if the key is unset" behavior had
// never actually been exercised by a real build until now. It broke the
// Vercel Preview build the moment app/api/webhooks/stripe/route.ts became
// the first route to reach it: Preview has zero non-public env vars
// configured for this repo (a known, pre-existing, documented gap — see
// every prior ticket's "Preview environment note" in this same file, e.g.
// MEM-004/005/006/007's entries), and Next's "Collecting page data" build
// step evaluates a route's module graph — including a dynamically-imported
// module like this one — even though app/api/webhooks/stripe/route.ts
// itself only ever calls `await import('@/lib/stripe')` inside the request
// handler, specifically to try to defer this exact problem (mirroring
// Propinno's own webhook route's identical dynamic-import pattern).
//
// Fixed the same way lib/db/index.ts already solves the identical class of
// problem (DATABASE_URL absent in an environment that still needs the
// module graph to import cleanly): a lazy Proxy. Importing `stripe` never
// throws; only touching a real property on it (`stripe.checkout`,
// `stripe.webhooks`, ...) does, and only if the key is genuinely still
// unset AT THAT POINT — so a real request in an environment with no
// STRIPE_SECRET_KEY still fails closed with this exact clear error, it
// just does so at request time instead of crashing every build that merely
// imports this module.
let cachedClient: Stripe | undefined

function getStripeClient(): Stripe {
  if (cachedClient) return cachedClient
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is not set')
  cachedClient = new Stripe(key, {
    apiVersion: '2026-07-29.dahlia',
    typescript: true,
  })
  return cachedClient
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    return Reflect.get(getStripeClient(), prop, receiver)
  },
})

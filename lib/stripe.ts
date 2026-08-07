import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is not set')

export const stripe = new Stripe(key, {
  apiVersion: '2026-07-29.dahlia',
  typescript: true,
})

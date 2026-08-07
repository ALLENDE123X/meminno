import pino from 'pino'

// pino-axiom uses worker_threads which is not supported in all Vercel serverless runtimes.
// Use standard JSON stdout in production — Axiom can ingest via log drains instead.
// pino-pretty is used in local dev only.

const isProduction = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

export const logger = pino({
  level: isProduction ? 'info' : (isTest ? 'silent' : 'debug'),
  transport: (!isProduction && !isTest)
    ? { target: 'pino-pretty' }
    : undefined, // Standard JSON stdout in production (Vercel captures this)
})

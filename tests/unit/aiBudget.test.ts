import { describe, it, expect, beforeEach, vi } from 'vitest'

// No UPSTASH_REDIS_REST_URL/TOKEN set in the test environment, so
// claimDailyBudget must fail OPEN (return true) rather than throwing or
// blocking — this is the safety behavior carried over from Propinno's
// lib/pollerBudget.ts, and it's the one thing a future refactor of this
// module must never break.
describe('claimDailyBudget', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  })

  it('fails open (returns true) when Redis is not configured', async () => {
    const { claimDailyBudget } = await import('@/lib/aiBudget')
    const result = await claimDailyBudget('notes-generation', 100)
    expect(result).toBe(true)
  })
})

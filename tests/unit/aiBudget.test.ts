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

describe('claimWeeklyBudget', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  })

  it('fails open (returns true) when Redis is not configured, exactly like the daily one', async () => {
    const { claimWeeklyBudget } = await import('@/lib/aiBudget')
    const result = await claimWeeklyBudget('podcast-generation:user:user-1', 1)
    expect(result).toBe(true)
  })
})

// isoWeekKey is what actually decides when a weekly cap resets (issue #87's
// free podcast tier), so it is pinned directly rather than only through the
// claim path. The failure mode it guards against is subtle and once-a-year:
// a naive week number would hand a free user two allowances in one week, or
// none, at a year boundary.
describe('isoWeekKey', () => {
  const key = async (iso: string) => {
    const { isoWeekKey } = await import('@/lib/aiBudget')
    return isoWeekKey(new Date(iso))
  }

  it('is stable across every day of one ISO week, Monday through Sunday', async () => {
    // 2026-08-10 is a Monday.
    const days = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16']
    const keys = await Promise.all(days.map((d) => key(`${d}T12:00:00.000Z`)))
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('2026-W33')
  })

  it('rolls over at Monday 00:00 UTC, not Sunday and not mid-week', async () => {
    expect(await key('2026-08-16T23:59:59.999Z')).toBe('2026-W33') // Sunday, last moment
    expect(await key('2026-08-17T00:00:00.000Z')).toBe('2026-W34') // Monday, first moment
  })

  it('handles the ISO year boundary (a week can belong to the neighbouring year)', async () => {
    // 2027-01-01 is a Friday, so its ISO week (Mon 2026-12-28 .. Sun 2027-01-03)
    // is 2026-W53 — the whole point of the Thursday rule.
    expect(await key('2026-12-28T00:00:00.000Z')).toBe('2026-W53')
    expect(await key('2027-01-01T12:00:00.000Z')).toBe('2026-W53')
    expect(await key('2027-01-03T23:00:00.000Z')).toBe('2026-W53')
    expect(await key('2027-01-04T00:00:00.000Z')).toBe('2027-W01')
  })

  it('zero-pads the week number so keys sort and read consistently', async () => {
    expect(await key('2026-01-05T00:00:00.000Z')).toBe('2026-W02')
  })

  it('never collides with a daily key for the same operation', async () => {
    // Both windows live in the same `meminno-ai-budget:<op>:<window>` namespace
    // and, for podcasts, under the same operation name — the differing window
    // string is the only thing keeping the free (weekly) and paid (daily)
    // counters apart.
    const weekly = await key('2026-08-12T00:00:00.000Z')
    const daily = new Date('2026-08-12T00:00:00.000Z').toISOString().slice(0, 10)
    expect(weekly).not.toBe(daily)
  })
})

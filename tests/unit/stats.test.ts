import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  computeStreakDays,
  computeScoreTrend,
  formatWeekRangeLabel,
  buildStatCardImageUrl,
  buildStatCardShareUrl,
  buildStatCardParams,
  parseStatCardImageParams,
  verifyStatCardSignature,
  type WeeklyStats,
} from '@/lib/stats'

// Signing (see lib/stats.ts's header comment, design choice #3) requires
// STAT_CARD_SIGNING_SECRET at runtime - stub a fixed value for this whole
// file so buildStatCardImageUrl()/verifyStatCardSignature() work the same
// way in CI as they do against a real secret.
beforeAll(() => {
  vi.stubEnv('STAT_CARD_SIGNING_SECRET', 'test-only-signing-secret-do-not-use-in-prod')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('computeStreakDays', () => {
  const now = new Date('2026-08-06T18:00:00Z')

  it('is 0 with no activity at all', () => {
    expect(computeStreakDays([], now)).toBe(0)
  })

  it('is 1 with activity only today', () => {
    expect(computeStreakDays([new Date('2026-08-06T02:00:00Z')], now)).toBe(1)
  })

  it('counts consecutive days ending today', () => {
    const dates = [
      new Date('2026-08-06T02:00:00Z'),
      new Date('2026-08-05T20:00:00Z'),
      new Date('2026-08-04T09:00:00Z'),
    ]
    expect(computeStreakDays(dates, now)).toBe(3)
  })

  it('forgives "today" not having happened yet if yesterday was active', () => {
    const dates = [new Date('2026-08-05T20:00:00Z'), new Date('2026-08-04T09:00:00Z')]
    expect(computeStreakDays(dates, now)).toBe(2)
  })

  it('breaks to 0 when both today and yesterday are missing', () => {
    const dates = [new Date('2026-08-03T09:00:00Z')]
    expect(computeStreakDays(dates, now)).toBe(0)
  })

  it('stops counting at the first gap', () => {
    const dates = [
      new Date('2026-08-06T02:00:00Z'),
      new Date('2026-08-05T02:00:00Z'),
      // gap on Aug 4
      new Date('2026-08-03T02:00:00Z'),
    ]
    expect(computeStreakDays(dates, now)).toBe(2)
  })

  it('multiple timestamps on the same day only count once', () => {
    const dates = [
      new Date('2026-08-06T01:00:00Z'),
      new Date('2026-08-06T02:00:00Z'),
      new Date('2026-08-06T23:00:00Z'),
    ]
    expect(computeStreakDays(dates, now)).toBe(1)
  })
})

describe('computeScoreTrend', () => {
  it('is null when either week has no data', () => {
    expect(computeScoreTrend(null, 80)).toBeNull()
    expect(computeScoreTrend(80, null)).toBeNull()
    expect(computeScoreTrend(null, null)).toBeNull()
  })

  it('is up when this week is meaningfully higher', () => {
    expect(computeScoreTrend(90, 80)).toBe('up')
  })

  it('is down when this week is meaningfully lower', () => {
    expect(computeScoreTrend(70, 80)).toBe('down')
  })

  it('is flat for a sub-1-point difference either direction', () => {
    expect(computeScoreTrend(80.5, 80)).toBe('flat')
    expect(computeScoreTrend(79.2, 80)).toBe('flat')
    expect(computeScoreTrend(80, 80)).toBe('flat')
  })
})

describe('formatWeekRangeLabel', () => {
  it('formats a same-year range with one trailing year', () => {
    const label = formatWeekRangeLabel(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-07T00:00:00Z'))
    expect(label).toBe('Aug 1 - Aug 7, 2026')
  })

  it('includes both years across a year boundary', () => {
    const label = formatWeekRangeLabel(new Date('2025-12-29T00:00:00Z'), new Date('2026-01-04T00:00:00Z'))
    expect(label).toBe('Dec 29, 2025 - Jan 4, 2026')
  })
})

describe('buildStatCardImageUrl / parseStatCardImageParams round-trip', () => {
  function makeStats(overrides: Partial<WeeklyStats> = {}): WeeklyStats {
    return {
      userId: '00000000-0000-0000-0000-000000000000',
      periodStart: new Date('2026-08-01T00:00:00Z'),
      periodEnd: new Date('2026-08-08T00:00:00Z'),
      documentsAdded: 3,
      flashcardsGenerated: 12,
      quizQuestionsGenerated: 8,
      quizzesTaken: 2,
      averageScore: 84.6,
      scoreTrend: 'up',
      streakDays: 4,
      everActive: true,
      isEmpty: false,
      ...overrides,
    }
  }

  it('round-trips a populated week', () => {
    const stats = makeStats()
    const url = buildStatCardImageUrl(stats)
    expect(url.startsWith('/api/stat-card?')).toBe(true)

    const parsed = parseStatCardImageParams(new URL(url, 'https://example.com').searchParams)
    expect(parsed.documentsAdded).toBe(3)
    expect(parsed.flashcardsGenerated).toBe(12)
    expect(parsed.quizQuestionsGenerated).toBe(8)
    expect(parsed.quizzesTaken).toBe(2)
    expect(parsed.averageScore).toBe(85) // rounded
    expect(parsed.scoreTrend).toBe('up')
    expect(parsed.streakDays).toBe(4)
    expect(parsed.isEmpty).toBe(false)
    expect(parsed.everActive).toBe(true)
    expect(parsed.periodLabel).toBe('Aug 1 - Aug 8, 2026')
  })

  it('round-trips the empty-state case with a null score/trend', () => {
    const stats = makeStats({
      documentsAdded: 0,
      flashcardsGenerated: 0,
      quizQuestionsGenerated: 0,
      quizzesTaken: 0,
      averageScore: null,
      scoreTrend: null,
      streakDays: 0,
      everActive: false,
      isEmpty: true,
    })
    const url = buildStatCardImageUrl(stats)
    const parsed = parseStatCardImageParams(new URL(url, 'https://example.com').searchParams)
    expect(parsed.isEmpty).toBe(true)
    expect(parsed.everActive).toBe(false)
    expect(parsed.averageScore).toBeNull()
    expect(parsed.scoreTrend).toBeNull()
  })

  it('parseStatCardImageParams defends against malformed/out-of-range input', () => {
    const params = new URLSearchParams({
      documents: 'not-a-number',
      flashcards: '-5',
      questions: '999999999',
      quizzes: '3',
      score: '250',
      trend: 'sideways',
      streak: '999999',
      empty: 'yes',
    })
    const parsed = parseStatCardImageParams(params)
    expect(parsed.documentsAdded).toBe(0)
    expect(parsed.flashcardsGenerated).toBe(0)
    expect(parsed.quizQuestionsGenerated).toBe(99999) // clamped to max
    expect(parsed.quizzesTaken).toBe(3)
    expect(parsed.averageScore).toBe(100) // clamped to max
    expect(parsed.scoreTrend).toBeNull() // invalid enum value rejected
    expect(parsed.streakDays).toBe(3650) // clamped to max
    expect(parsed.isEmpty).toBe(false) // quizzesTaken=3 is genuinely non-zero
  })

  it('isEmpty is derived from real zero counts even without an explicit empty=1 flag', () => {
    // Regression test: a bare/hand-crafted request with all-zero counts and
    // no `empty` param used to render as a "populated" card full of zeros
    // instead of the honest empty state.
    const params = new URLSearchParams({ documents: '0', flashcards: '0', questions: '0', quizzes: '0' })
    expect(parseStatCardImageParams(params).isEmpty).toBe(true)
  })
})

describe('stat card share URL signing', () => {
  function makeStats(overrides: Partial<WeeklyStats> = {}): WeeklyStats {
    return {
      userId: '00000000-0000-0000-0000-000000000000',
      periodStart: new Date('2026-08-01T00:00:00Z'),
      periodEnd: new Date('2026-08-08T00:00:00Z'),
      documentsAdded: 3,
      flashcardsGenerated: 12,
      quizQuestionsGenerated: 8,
      quizzesTaken: 2,
      averageScore: 84.6,
      scoreTrend: 'up',
      streakDays: 4,
      everActive: true,
      isEmpty: false,
      ...overrides,
    }
  }

  it('buildStatCardImageUrl() produces a URL whose signature verifies', () => {
    const url = buildStatCardImageUrl(makeStats())
    const params = new URL(url, 'https://example.com').searchParams
    expect(params.get('sig')).toBeTruthy()
    expect(verifyStatCardSignature(params)).toBe(true)
  })

  it('buildStatCardShareUrl() points at /share/stat-card with the same signed params', () => {
    const url = buildStatCardShareUrl(makeStats())
    expect(url.startsWith('/share/stat-card?')).toBe(true)
    const params = new URL(url, 'https://example.com').searchParams
    expect(verifyStatCardSignature(params)).toBe(true)
  })

  it('rejects a request with no signature at all', () => {
    const params = new URLSearchParams({ documents: '3', flashcards: '12', questions: '8', quizzes: '2' })
    expect(verifyStatCardSignature(params)).toBe(false)
  })

  it('rejects a tampered numeric value even with the original signature still attached', () => {
    const params = buildStatCardParams(makeStats())
    // Forgery attempt: bump the headline numbers after signing, keep the old sig.
    params.set('documents', '9999')
    params.set('streak', '3650')
    params.set('score', '100')
    expect(verifyStatCardSignature(params)).toBe(false)
  })

  it('rejects injected/arbitrary text in a field that was not part of the signed set', () => {
    const params = buildStatCardParams(makeStats())
    params.set('period', 'Meminno confirms: this user cheated on every exam, 2026')
    expect(verifyStatCardSignature(params)).toBe(false)
  })

  it('rejects a signature copied onto a completely different param set', () => {
    const sig = buildStatCardParams(makeStats()).get('sig')!
    const forged = new URLSearchParams({ documents: '9999', flashcards: '9999', questions: '99999', quizzes: '9999' })
    forged.set('sig', sig)
    expect(verifyStatCardSignature(forged)).toBe(false)
  })

  it('is order-independent — reordering the same params still verifies', () => {
    const original = buildStatCardParams(makeStats())
    const reordered = new URLSearchParams()
    for (const key of [...original.keys()].reverse()) reordered.set(key, original.get(key)!)
    expect(verifyStatCardSignature(reordered)).toBe(true)
  })
})

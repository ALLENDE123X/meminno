import { describe, it, expect, vi, beforeEach } from 'vitest'
import { limitRequest } from '@/lib/ratelimit'
import { claimDailyBudget } from '@/lib/aiBudget'
import {
  checkFlashcardsBurstLimit,
  claimFlashcardsBudget,
  FREE_TIER_DAILY_FLASHCARDS_CAP,
  PAID_TIER_DAILY_FLASHCARDS_CAP,
  PLATFORM_DAILY_FLASHCARDS_CAP,
} from '@/lib/flashcardsLimits'

// Mirrors tests/unit/notesLimits.test.ts exactly (per this ticket's dispatch
// instructions to mirror MEM-005's convention) — exercises the actual
// branching logic in lib/flashcardsLimits.ts (order of checks, which cap
// applies per plan, the exact reason strings, and the distinct
// `flashcards-generation` operation names) against mocked
// lib/ratelimit / lib/aiBudget calls.
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/aiBudget', () => ({
  claimDailyBudget: vi.fn(),
}))

const mockLimitRequest = vi.mocked(limitRequest)
const mockClaimDailyBudget = vi.mocked(claimDailyBudget)

describe('checkFlashcardsBurstLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows the request when under the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkFlashcardsBurstLimit('user-1')

    expect(result).toEqual({ ok: true })
  })

  it('blocks and never touches claimDailyBudget when over the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkFlashcardsBurstLimit('user-1')

    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('slow down') })
    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
  })

  it('keys the burst check per user, namespaced meminno-, and distinct from notes-burst', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    await checkFlashcardsBurstLimit('user-42')

    expect(mockLimitRequest).toHaveBeenCalledWith('meminno-flashcards-burst:user-42')
  })
})

describe('claimFlashcardsBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaimDailyBudget.mockResolvedValue(true)
  })

  it('allows the request when both the per-user and platform budgets pass', async () => {
    const result = await claimFlashcardsBudget('user-1', 'free')
    expect(result).toEqual({ ok: true })
  })

  it('applies the free-tier per-user daily cap for plan="free"', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'flashcards-generation:user:user-1')

    const result = await claimFlashcardsBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('flashcards-generation:user:user-1', FREE_TIER_DAILY_FLASHCARDS_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Free plan') })
  })

  it('applies the higher paid-tier per-user daily cap for a non-free plan', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'flashcards-generation:user:user-1')

    const result = await claimFlashcardsBudget('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('flashcards-generation:user:user-1', PAID_TIER_DAILY_FLASHCARDS_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Daily flashcards-generation limit reached') })
  })

  it('checks the platform-wide ceiling after the per-user cap passes, using a distinct operation name from notes-generation', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'flashcards-generation')

    const result = await claimFlashcardsBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(1, 'flashcards-generation:user:user-1', FREE_TIER_DAILY_FLASHCARDS_CAP)
    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(2, 'flashcards-generation', PLATFORM_DAILY_FLASHCARDS_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })
  })
})

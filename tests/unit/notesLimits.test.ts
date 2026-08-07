import { describe, it, expect, vi, beforeEach } from 'vitest'
import { limitRequest } from '@/lib/ratelimit'
import { claimDailyBudget } from '@/lib/aiBudget'
import {
  checkNotesBurstLimit,
  claimNotesBudget,
  FREE_TIER_DAILY_NOTES_CAP,
  PAID_TIER_DAILY_NOTES_CAP,
  PLATFORM_DAILY_NOTES_CAP,
} from '@/lib/notesLimits'

// Mirrors tests/unit/uploadLimits.test.ts exactly (per this ticket's
// dispatch instructions to reuse that established convention) — exercises
// the actual branching logic in lib/notesLimits.ts (order of checks, which
// cap applies per plan, the exact reason strings) against mocked
// lib/ratelimit / lib/aiBudget calls. lib/aiBudget.test.ts already
// separately covers claimDailyBudget's own Redis-unconfigured fail-open
// behavior, so that isn't re-tested here.
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/aiBudget', () => ({
  claimDailyBudget: vi.fn(),
}))

const mockLimitRequest = vi.mocked(limitRequest)
const mockClaimDailyBudget = vi.mocked(claimDailyBudget)

describe('checkNotesBurstLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows the request when under the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkNotesBurstLimit('user-1')

    expect(result).toEqual({ ok: true })
  })

  it('blocks and never touches claimDailyBudget when over the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkNotesBurstLimit('user-1')

    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('slow down') })
    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
  })

  it('keys the burst check per user, namespaced meminno-', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    await checkNotesBurstLimit('user-42')

    expect(mockLimitRequest).toHaveBeenCalledWith('meminno-notes-burst:user-42')
  })
})

describe('claimNotesBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaimDailyBudget.mockResolvedValue(true)
  })

  it('allows the request when both the per-user and platform budgets pass', async () => {
    const result = await claimNotesBudget('user-1', 'free')
    expect(result).toEqual({ ok: true })
  })

  it('applies the free-tier per-user daily cap for plan="free"', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'notes-generation:user:user-1')

    const result = await claimNotesBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('notes-generation:user:user-1', FREE_TIER_DAILY_NOTES_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Free plan') })
  })

  it('applies the higher paid-tier per-user daily cap for a non-free plan', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'notes-generation:user:user-1')

    const result = await claimNotesBudget('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('notes-generation:user:user-1', PAID_TIER_DAILY_NOTES_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Daily notes-generation limit reached') })
  })

  it('checks the platform-wide ceiling after the per-user cap passes', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'notes-generation')

    const result = await claimNotesBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(1, 'notes-generation:user:user-1', FREE_TIER_DAILY_NOTES_CAP)
    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(2, 'notes-generation', PLATFORM_DAILY_NOTES_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })
  })
})

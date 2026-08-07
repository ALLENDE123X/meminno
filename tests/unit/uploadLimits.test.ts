import { describe, it, expect, vi, beforeEach } from 'vitest'
import { limitRequest } from '@/lib/ratelimit'
import { claimDailyBudget } from '@/lib/aiBudget'
import {
  enforceUploadLimits,
  FREE_TIER_DAILY_UPLOAD_CAP,
  PAID_TIER_DAILY_UPLOAD_CAP,
  PLATFORM_DAILY_UPLOAD_CAP,
} from '@/lib/uploadLimits'

// Real MEM-004 review-flagged risk: budget-cap enforcement paths shipping
// with zero real test coverage. These tests exercise the actual branching
// logic in lib/uploadLimits.ts (order of checks, which cap applies per
// plan, the exact reason strings) against mocked lib/ratelimit /
// lib/aiBudget calls — lib/aiBudget.test.ts already separately covers
// claimDailyBudget's own Redis-unconfigured fail-open behavior, so that
// isn't re-tested here.
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/aiBudget', () => ({
  claimDailyBudget: vi.fn(),
}))

const mockLimitRequest = vi.mocked(limitRequest)
const mockClaimDailyBudget = vi.mocked(claimDailyBudget)

describe('enforceUploadLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: every layer passes, individual tests override one layer at a time.
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)
    mockClaimDailyBudget.mockResolvedValue(true)
  })

  it('allows the request when all three layers pass', async () => {
    const result = await enforceUploadLimits('user-1', 'free')
    expect(result).toEqual({ ok: true })
  })

  it('blocks on burst rate limiting before ever touching the daily-budget layers', async () => {
    mockLimitRequest.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await enforceUploadLimits('user-1', 'free')

    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('slow down') })
    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
  })

  it('keys the burst check per user, namespaced meminno-', async () => {
    await enforceUploadLimits('user-42', 'free')
    expect(mockLimitRequest).toHaveBeenCalledWith('meminno-upload-burst:user-42')
  })

  it('applies the free-tier per-user daily cap for plan="free"', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'document-upload:user:user-1')

    const result = await enforceUploadLimits('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('document-upload:user:user-1', FREE_TIER_DAILY_UPLOAD_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Free plan') })
  })

  it('applies the higher paid-tier per-user daily cap for a non-free plan', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'document-upload:user:user-1')

    const result = await enforceUploadLimits('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('document-upload:user:user-1', PAID_TIER_DAILY_UPLOAD_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Daily upload limit reached') })
  })

  it('checks the platform-wide ceiling after the per-user cap passes', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'document-upload')

    const result = await enforceUploadLimits('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(1, 'document-upload:user:user-1', FREE_TIER_DAILY_UPLOAD_CAP)
    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(2, 'document-upload', PLATFORM_DAILY_UPLOAD_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })
  })
})

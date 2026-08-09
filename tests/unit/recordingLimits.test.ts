import { describe, it, expect, vi, beforeEach } from 'vitest'
import { limitRequest } from '@/lib/ratelimit'
import { claimDailyBudget } from '@/lib/aiBudget'
import {
  checkRecordingBurstLimit,
  claimChunkTranscriptionBudget,
  FREE_TIER_DAILY_CHUNK_CAP,
  PAID_TIER_DAILY_CHUNK_CAP,
  PLATFORM_DAILY_CHUNK_CAP,
} from '@/lib/recordingLimits'

// Mirrors tests/unit/notesLimits.test.ts's shape exactly.
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/aiBudget', () => ({
  claimDailyBudget: vi.fn(),
}))

const mockLimitRequest = vi.mocked(limitRequest)
const mockClaimDailyBudget = vi.mocked(claimDailyBudget)

describe('checkRecordingBurstLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows the request when under the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkRecordingBurstLimit('user-1')

    expect(result).toEqual({ ok: true })
  })

  it('blocks and never touches claimDailyBudget when over the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkRecordingBurstLimit('user-1')

    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('slow down') })
    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
  })

  it('keys the burst check per user, namespaced meminno-', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    await checkRecordingBurstLimit('user-42')

    expect(mockLimitRequest).toHaveBeenCalledWith('meminno-recording-burst:user-42')
  })
})

describe('claimChunkTranscriptionBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaimDailyBudget.mockResolvedValue(true)
  })

  it('allows the request when both the per-user and platform budgets pass', async () => {
    const result = await claimChunkTranscriptionBudget('user-1', 'free')
    expect(result).toEqual({ ok: true })
  })

  it('applies the free-tier per-user daily chunk cap for plan="free"', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'recording-transcription:user:user-1')

    const result = await claimChunkTranscriptionBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('recording-transcription:user:user-1', FREE_TIER_DAILY_CHUNK_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Free plan') })
  })

  it('applies the higher paid-tier per-user daily chunk cap for a non-free plan', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'recording-transcription:user:user-1')

    const result = await claimChunkTranscriptionBudget('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('recording-transcription:user:user-1', PAID_TIER_DAILY_CHUNK_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Daily recording-transcription limit reached') })
  })

  it('checks the platform-wide ceiling after the per-user cap passes', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'recording-transcription')

    const result = await claimChunkTranscriptionBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(1, 'recording-transcription:user:user-1', FREE_TIER_DAILY_CHUNK_CAP)
    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(2, 'recording-transcription', PLATFORM_DAILY_CHUNK_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })
  })
})

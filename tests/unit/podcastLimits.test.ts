import { describe, it, expect, vi, beforeEach } from 'vitest'
import { limitRequest } from '@/lib/ratelimit'
import { claimDailyBudget } from '@/lib/aiBudget'
import {
  checkPodcastBurstLimit,
  claimPodcastBudget,
  FREE_TIER_DAILY_PODCAST_CAP,
  PAID_TIER_DAILY_PODCAST_CAP,
  PLATFORM_DAILY_PODCAST_CAP,
} from '@/lib/podcastLimits'

// Mirrors tests/unit/notesLimits.test.ts / tests/unit/recordingLimits.test.ts.
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/aiBudget', () => ({
  claimDailyBudget: vi.fn(),
}))

const mockLimitRequest = vi.mocked(limitRequest)
const mockClaimDailyBudget = vi.mocked(claimDailyBudget)

describe('checkPodcastBurstLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows the request when under the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    expect(await checkPodcastBurstLimit('user-1')).toEqual({ ok: true })
  })

  it('blocks and never touches claimDailyBudget when over the burst limit', async () => {
    mockLimitRequest.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof limitRequest>>)

    const result = await checkPodcastBurstLimit('user-1')

    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('slow down') })
    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
  })

  it('keys the burst check per user, namespaced meminno-', async () => {
    mockLimitRequest.mockResolvedValue({ success: true } as Awaited<ReturnType<typeof limitRequest>>)

    await checkPodcastBurstLimit('user-42')

    expect(mockLimitRequest).toHaveBeenCalledWith('meminno-podcast-burst:user-42')
  })
})

describe('claimPodcastBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaimDailyBudget.mockResolvedValue(true)
  })

  it('allows the request when both the per-user and platform budgets pass', async () => {
    expect(await claimPodcastBudget('user-1', 'free')).toEqual({ ok: true })
  })

  it('applies the free-tier per-user daily cap for plan="free"', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'podcast-generation:user:user-1')

    const result = await claimPodcastBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('podcast-generation:user:user-1', FREE_TIER_DAILY_PODCAST_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Free plan') })
  })

  it('applies the higher paid-tier per-user daily cap for a non-free plan', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'podcast-generation:user:user-1')

    const result = await claimPodcastBudget('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('podcast-generation:user:user-1', PAID_TIER_DAILY_PODCAST_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Daily podcast limit reached') })
  })

  it('checks the platform-wide ceiling after the per-user cap passes', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'podcast-generation')

    const result = await claimPodcastBudget('user-1', 'free')

    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(1, 'podcast-generation:user:user-1', FREE_TIER_DAILY_PODCAST_CAP)
    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(2, 'podcast-generation', PLATFORM_DAILY_PODCAST_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })
  })

  it('uses its own Redis namespace, never the notes/flashcards/quiz/recording ones', async () => {
    await claimPodcastBudget('user-1', 'free')

    for (const [operationName] of mockClaimDailyBudget.mock.calls) {
      expect(operationName).toMatch(/^podcast-generation/)
    }
  })

  it('pins the caps that were sized against real measured Gemini TTS cost', async () => {
    // ~$0.10 of vendor spend per podcast (measured live during MEM-014), so
    // these are deliberately far below the 5/50/300 the text-generation
    // features use. The paid cap in particular is set so a subscriber who
    // maxes it every day still costs less than they pay.
    expect(FREE_TIER_DAILY_PODCAST_CAP).toBe(2)
    expect(PAID_TIER_DAILY_PODCAST_CAP).toBe(5)
    expect(PLATFORM_DAILY_PODCAST_CAP).toBe(50)
  })
})

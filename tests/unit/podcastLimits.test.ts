import { describe, it, expect, vi, beforeEach } from 'vitest'
import { limitRequest } from '@/lib/ratelimit'
import { claimDailyBudget, claimWeeklyBudget } from '@/lib/aiBudget'
import {
  checkPodcastBurstLimit,
  claimPodcastBudget,
  FREE_TIER_WEEKLY_PODCAST_CAP,
  PAID_TIER_DAILY_PODCAST_CAP,
  PLATFORM_DAILY_PODCAST_CAP,
} from '@/lib/podcastLimits'

// Mirrors tests/unit/notesLimits.test.ts / tests/unit/recordingLimits.test.ts.
vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))
vi.mock('@/lib/aiBudget', () => ({
  claimDailyBudget: vi.fn(),
  claimWeeklyBudget: vi.fn(),
}))

const mockLimitRequest = vi.mocked(limitRequest)
const mockClaimDailyBudget = vi.mocked(claimDailyBudget)
const mockClaimWeeklyBudget = vi.mocked(claimWeeklyBudget)

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
    expect(mockClaimWeeklyBudget).not.toHaveBeenCalled()
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
    mockClaimWeeklyBudget.mockResolvedValue(true)
  })

  it('allows the request when both the per-user and platform budgets pass', async () => {
    expect(await claimPodcastBudget('user-1', 'free')).toEqual({ ok: true })
  })

  it('applies the free-tier per-user WEEKLY cap for plan="free" (issue #87)', async () => {
    mockClaimWeeklyBudget.mockResolvedValue(false)

    const result = await claimPodcastBudget('user-1', 'free')

    expect(mockClaimWeeklyBudget).toHaveBeenCalledWith('podcast-generation:user:user-1', FREE_TIER_WEEKLY_PODCAST_CAP)
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Free plan') })
  })

  it('never puts a free user on the DAILY per-user counter', async () => {
    // The whole point of issue #87: a free user must not get a fresh
    // allowance every morning. If this ever regresses to claimDailyBudget the
    // numeric cap would still read 1, but it would be 1/day, not 1/week.
    await claimPodcastBudget('user-1', 'free')

    expect(mockClaimDailyBudget).not.toHaveBeenCalledWith(
      'podcast-generation:user:user-1',
      expect.anything()
    )
  })

  it('tells the free user the limit is weekly, not daily', async () => {
    mockClaimWeeklyBudget.mockResolvedValue(false)

    const result = await claimPodcastBudget('user-1', 'free')

    expect(result).toEqual({
      ok: false,
      status: 429,
      reason: 'Free plan is limited to 1 podcast per week. Upgrade for more.',
    })
  })

  it('applies the higher paid-tier per-user DAILY cap for a non-free plan', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'podcast-generation:user:user-1')

    const result = await claimPodcastBudget('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenCalledWith('podcast-generation:user:user-1', PAID_TIER_DAILY_PODCAST_CAP)
    expect(mockClaimWeeklyBudget).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, status: 429, reason: expect.stringContaining('Daily podcast limit reached') })
  })

  it('checks the platform-wide DAILY ceiling after the per-user cap passes, on both plans', async () => {
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'podcast-generation')

    const free = await claimPodcastBudget('user-1', 'free')

    expect(mockClaimWeeklyBudget).toHaveBeenCalledWith('podcast-generation:user:user-1', FREE_TIER_WEEKLY_PODCAST_CAP)
    expect(mockClaimDailyBudget).toHaveBeenCalledWith('podcast-generation', PLATFORM_DAILY_PODCAST_CAP)
    expect(free).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })

    vi.clearAllMocks()
    mockClaimDailyBudget.mockImplementation(async (op) => op !== 'podcast-generation')

    const paid = await claimPodcastBudget('user-1', 'monthly')

    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(1, 'podcast-generation:user:user-1', PAID_TIER_DAILY_PODCAST_CAP)
    expect(mockClaimDailyBudget).toHaveBeenNthCalledWith(2, 'podcast-generation', PLATFORM_DAILY_PODCAST_CAP)
    expect(paid).toEqual({ ok: false, status: 429, reason: expect.stringContaining('high demand') })
  })

  it('never reaches the platform ceiling once the per-user cap has already blocked', async () => {
    mockClaimWeeklyBudget.mockResolvedValue(false)

    await claimPodcastBudget('user-1', 'free')

    expect(mockClaimDailyBudget).not.toHaveBeenCalled()
  })

  it('uses its own Redis namespace, never the notes/flashcards/quiz/recording ones', async () => {
    await claimPodcastBudget('user-1', 'free')
    await claimPodcastBudget('user-2', 'monthly')

    for (const [operationName] of [...mockClaimDailyBudget.mock.calls, ...mockClaimWeeklyBudget.mock.calls]) {
      expect(operationName).toMatch(/^podcast-generation/)
    }
  })

  it('pins the caps: free is 1/WEEK (issue #87), paid and platform stay daily', async () => {
    // Free was 2/day until issue #87 moved it to 1/week — a deliberate
    // conversion lever, not a cost change. Paid/platform are still sized off
    // MEM-014's measured ~$0.10 of vendor spend per podcast, which is why they
    // sit far below the 5/50/300 the text-generation features use.
    expect(FREE_TIER_WEEKLY_PODCAST_CAP).toBe(1)
    expect(PAID_TIER_DAILY_PODCAST_CAP).toBe(5)
    expect(PLATFORM_DAILY_PODCAST_CAP).toBe(50)
  })
})

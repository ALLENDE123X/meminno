import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cookies } from 'next/headers'
import { setReferralCookie } from '@/app/sign-in/actions'
import { REFERRAL_COOKIE_NAME } from '@/lib/referral'

// Mirrors tests/unit/billing-actions.test.ts's next/headers mocking
// approach for that module's own server actions.
vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}))

const mockCookies = vi.mocked(cookies)

function mockCookieStore() {
  const set = vi.fn()
  mockCookies.mockResolvedValue({ set } as never)
  return { set }
}

describe('app/sign-in/actions.ts: setReferralCookie (MEM-018, manual referral-code entry)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets the meminno_ref cookie to the trimmed code', async () => {
    const { set } = mockCookieStore()

    await setReferralCookie('  cynthia  ')

    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(
      REFERRAL_COOKIE_NAME,
      'cynthia',
      expect.objectContaining({ httpOnly: true, path: '/', sameSite: 'lax' })
    )
  })

  it('does nothing for an empty string', async () => {
    const { set } = mockCookieStore()

    await setReferralCookie('')

    expect(set).not.toHaveBeenCalled()
  })

  it('does nothing for a whitespace-only string', async () => {
    const { set } = mockCookieStore()

    await setReferralCookie('   ')

    expect(set).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { proxy } from '@/proxy'
import { REFERRAL_COOKIE_NAME } from '@/lib/referral'

// The Supabase session-refresh half of proxy.ts (its original, pre-MEM-018
// purpose) is a real network call - out of scope for a unit test, and
// already exercised implicitly by every other route's own live/E2E
// verification. Mocked here purely so proxy() can run at all; these tests
// are about the MEM-018 referral-cookie-capture addition specifically.
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(),
}))

const mockCreateServerClient = vi.mocked(createServerClient)

describe('proxy() — MEM-018 referral cookie capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateServerClient.mockReturnValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  })

  it('sets meminno_ref when the landing page ("/") is visited with a non-empty ?ref= param', async () => {
    const request = new NextRequest('http://localhost/?ref=cynthia')

    const response = await proxy(request)

    expect(response.cookies.get(REFERRAL_COOKIE_NAME)?.value).toBe('cynthia')
  })

  it('does NOT set/touch meminno_ref on a visit to "/" with no ?ref= param', async () => {
    const request = new NextRequest('http://localhost/')

    const response = await proxy(request)

    // No Set-Cookie for this name at all — critically different from
    // setting it to empty/undefined, since an absent Set-Cookie is what
    // leaves the browser's existing cookie (if any) untouched.
    expect(response.cookies.get(REFERRAL_COOKIE_NAME)).toBeUndefined()
  })

  it('does NOT set meminno_ref when ?ref= is present but blank/whitespace-only', async () => {
    const request = new NextRequest('http://localhost/?ref=%20%20')

    const response = await proxy(request)

    expect(response.cookies.get(REFERRAL_COOKIE_NAME)).toBeUndefined()
  })

  it('overwrites an existing meminno_ref cookie when a NEW explicit ?ref= arrives (re-attribution, not first-touch-locked)', async () => {
    const request = new NextRequest('http://localhost/?ref=new-creator', {
      headers: { cookie: `${REFERRAL_COOKIE_NAME}=old-creator` },
    })

    const response = await proxy(request)

    expect(response.cookies.get(REFERRAL_COOKIE_NAME)?.value).toBe('new-creator')
  })

  it('does not capture ?ref= on routes other than "/" (only the landing page is the capture surface)', async () => {
    const request = new NextRequest('http://localhost/dashboard?ref=cynthia')

    const response = await proxy(request)

    expect(response.cookies.get(REFERRAL_COOKIE_NAME)).toBeUndefined()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

// getSessionUser() talks to Supabase Auth (network) and the DB
// (withUserContext, itself a real Postgres transaction) - neither belongs
// in a unit test. Both are mocked here; tests/integration/rls.test.ts and
// this ticket's live-project verification (see PR description) are what
// prove the real network/DB paths actually work.
const getUserMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: getUserMock },
  })),
}))

const withUserContextMock = vi.fn(async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
  // Mimics lib/db/index.ts's real shape closely enough for
  // ensureUserRow's `tx.insert(users).values(...).onConflictDoNothing()`
  // chain to resolve without touching a real database.
  const fakeTx = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => Promise.resolve(),
      }),
    }),
  }
  return fn(fakeTx)
})
vi.mock('@/lib/db', () => ({
  withUserContext: withUserContextMock,
}))

describe('getSessionUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when Supabase Auth returns an error', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: new Error('invalid token') })
    const { getSessionUser } = await import('@/lib/session')

    const result = await getSessionUser()
    expect(result).toEqual({ ok: false, status: 401 })
  })

  it('returns 401 when there is no session at all', async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null })
    const { getSessionUser } = await import('@/lib/session')

    const result = await getSessionUser()
    expect(result).toEqual({ ok: false, status: 401 })
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 401 for a session whose user has no email (should be unreachable via magic link, fails closed anyway)', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1', email: null } }, error: null })
    const { getSessionUser } = await import('@/lib/session')

    const result = await getSessionUser()
    expect(result).toEqual({ ok: false, status: 401 })
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns ok:true with the Supabase Auth user id, and ensures a matching public.users row via withUserContext', async () => {
    const userId = '11111111-1111-1111-1111-111111111111'
    getUserMock.mockResolvedValue({ data: { user: { id: userId, email: 'student@school.edu' } }, error: null })
    const { getSessionUser } = await import('@/lib/session')

    const result = await getSessionUser()
    expect(result).toEqual({ ok: true, userId })
    // Identity used to scope the row-creation transaction must be the same
    // id being inserted, or the RLS withCheck (meminno_current_user_id() =
    // id) would reject it - see lib/db/schema.ts's users policy.
    expect(withUserContextMock).toHaveBeenCalledWith(userId, expect.any(Function))
  })
})

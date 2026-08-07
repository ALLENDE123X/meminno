import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSessionUserMock = vi.fn()
vi.mock('@/lib/session', () => ({
  getSessionUser: getSessionUserMock,
}))

const selectRow = { id: 'user-1', email: 'student@school.edu', plan: 'free' }
const withUserContextMock = vi.fn(async (_userId: string, fn: (tx: unknown) => Promise<unknown>) => {
  const fakeTx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([selectRow]),
      }),
    }),
  }
  return fn(fakeTx)
})
vi.mock('@/lib/db', () => ({
  withUserContext: withUserContextMock,
}))

const signOutMock = vi.fn(async () => ({ error: null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { signOut: signOutMock },
  })),
}))

// This route is the concrete "protected route" this ticket's verification
// requires proving a 401 against (see CLAUDE.md HARD STOP 7's neighboring
// requirement: real end-to-end verification, not mocked, is done
// separately against the live project - this file only pins the route's
// own branching logic).
describe('GET /api/me', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when there is no valid session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })
    const { GET } = await import('@/app/api/me/route')

    const res = await GET()
    expect(res.status).toBe(401)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns the session user\'s own row, scoped through withUserContext', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1' })
    const { GET } = await import('@/app/api/me/route')

    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ user: selectRow })
    expect(withUserContextMock).toHaveBeenCalledWith('user-1', expect.any(Function))
  })
})

describe('DELETE /api/me (sign out)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when there is no valid session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })
    const { DELETE } = await import('@/app/api/me/route')

    const res = await DELETE()
    expect(res.status).toBe(401)
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('signs out an authenticated session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1' })
    const { DELETE } = await import('@/app/api/me/route')

    const res = await DELETE()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(signOutMock).toHaveBeenCalled()
  })
})

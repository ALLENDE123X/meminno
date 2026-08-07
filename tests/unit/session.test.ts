import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { createClient as createServerSupabaseClient } from '@/lib/supabase/server'
import { withUserContext } from '@/lib/db'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  withUserContext: vi.fn(),
}))

const mockCreateServerClient = vi.mocked(createServerSupabaseClient)
const mockWithUserContext = vi.mocked(withUserContext)

/** Builds a chainable mock tx: tx.insert(...).values(...).onConflictDoUpdate(...).returning() -> rows */
function mockTx(rows: Array<{ plan: string }>) {
  const returning = vi.fn().mockResolvedValue(rows)
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning })
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate })
  const insert = vi.fn().mockReturnValue({ values })
  return { insert, values, onConflictDoUpdate, returning }
}

describe('getSessionUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when Supabase Auth rejects the token/cookie', async () => {
    mockCreateServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const result = await getSessionUser(new Request('http://localhost/api/documents', { method: 'POST' }))

    expect(result).toEqual({ ok: false, status: 401 })
    expect(mockWithUserContext).not.toHaveBeenCalled()
  })

  it('passes a Bearer token through to supabase.auth.getUser()', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u-1', email: 'a@example.com' } }, error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServerClient.mockResolvedValue({ auth: { getUser } } as any)
    const tx = mockTx([{ plan: 'free' }])
    mockWithUserContext.mockImplementation(async (_userId, fn) => fn(tx as never))

    const req = new Request('http://localhost/api/documents', {
      method: 'POST',
      headers: { authorization: 'Bearer real-jwt-token' },
    })
    await getSessionUser(req)

    expect(getUser).toHaveBeenCalledWith('real-jwt-token')
  })

  it('on a verified user, upserts the profile row scoped to that user and returns {ok:true,userId,plan}', async () => {
    const getUser = vi
      .fn()
      .mockResolvedValue({ data: { user: { id: 'u-2', email: 'student@example.com' } }, error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServerClient.mockResolvedValue({ auth: { getUser } } as any)
    const tx = mockTx([{ plan: 'monthly' }])
    mockWithUserContext.mockImplementation(async (userId, fn) => {
      expect(userId).toBe('u-2') // withUserContext must be called with the CALLER's own id
      return fn(tx as never)
    })

    const result = await getSessionUser(new Request('http://localhost/api/documents', { method: 'POST' }))

    expect(result).toEqual({ ok: true, userId: 'u-2', plan: 'monthly' })
    expect(tx.insert).toHaveBeenCalled()
    expect(tx.values).toHaveBeenCalledWith({ id: 'u-2', email: 'student@example.com' })
  })

  it('defaults plan to "free" if the upsert somehow returns no row', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u-3', email: 'x@example.com' } }, error: null })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateServerClient.mockResolvedValue({ auth: { getUser } } as any)
    const tx = mockTx([])
    mockWithUserContext.mockImplementation(async (_userId, fn) => fn(tx as never))

    const result = await getSessionUser(new Request('http://localhost/api/documents', { method: 'POST' }))

    expect(result).toEqual({ ok: true, userId: 'u-3', plan: 'free' })
  })
})

describe('sessionErrorResponse', () => {
  it('maps 401 to Unauthorized', () => {
    expect(sessionErrorResponse(401)).toEqual({ error: 'Unauthorized', status: 401 })
  })

  it('maps 403 to a forbidden message', () => {
    expect(sessionErrorResponse(403)).toEqual({ error: 'Access forbidden', status: 403 })
  })
})

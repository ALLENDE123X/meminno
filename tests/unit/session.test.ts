import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { createClient as createServerSupabaseClient } from '@/lib/supabase/server'
import { withUserContext } from '@/lib/db'

// getSessionUser() talks to Supabase Auth (network) and the DB
// (withUserContext, itself a real Postgres transaction) - neither belongs
// in a unit test. Both are mocked here; tests/integration/rls.test.ts and
// MEM-003's/MEM-004's live-project verification (see their PR descriptions)
// are what prove the real network/DB paths actually work.
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

function mockAuth(getUser: ReturnType<typeof vi.fn>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCreateServerClient.mockResolvedValue({ auth: { getUser } } as any)
}

describe('getSessionUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when Supabase Auth returns an error', async () => {
    mockAuth(vi.fn().mockResolvedValue({ data: { user: null }, error: new Error('invalid token') }))

    const result = await getSessionUser()

    expect(result).toEqual({ ok: false, status: 401 })
    expect(mockWithUserContext).not.toHaveBeenCalled()
  })

  it('returns 401 when there is no session at all (no error, no user)', async () => {
    mockAuth(vi.fn().mockResolvedValue({ data: { user: null }, error: null }))

    const result = await getSessionUser()

    expect(result).toEqual({ ok: false, status: 401 })
    expect(mockWithUserContext).not.toHaveBeenCalled()
  })

  it('returns 401 for a session whose user has no email (should be unreachable via magic link, fails closed anyway)', async () => {
    mockAuth(vi.fn().mockResolvedValue({ data: { user: { id: 'user-1', email: null } }, error: null }))

    const result = await getSessionUser()

    expect(result).toEqual({ ok: false, status: 401 })
    expect(mockWithUserContext).not.toHaveBeenCalled()
  })

  it('defaults to the cookie-based session when no Request is passed (existing call sites like app/api/me)', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u-cookie', email: 'a@example.com' } }, error: null })
    mockAuth(getUser)
    const tx = mockTx([{ plan: 'free' }])
    mockWithUserContext.mockImplementation(async (_userId, fn) => fn(tx as never))

    await getSessionUser()

    expect(getUser).toHaveBeenCalledWith(undefined)
  })

  it('passes a Bearer token through to supabase.auth.getUser() when a Request is provided', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u-1', email: 'a@example.com' } }, error: null })
    mockAuth(getUser)
    const tx = mockTx([{ plan: 'free' }])
    mockWithUserContext.mockImplementation(async (_userId, fn) => fn(tx as never))

    const req = new Request('http://localhost/api/documents', {
      method: 'POST',
      headers: { authorization: 'Bearer real-jwt-token' },
    })
    await getSessionUser(req)

    expect(getUser).toHaveBeenCalledWith('real-jwt-token')
  })

  it('on a verified user, upserts (onConflictDoUpdate, keeping email in sync) the profile row scoped to that user and returns {ok:true,userId,plan}', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u-2', email: 'student@example.com' } }, error: null })
    mockAuth(getUser)
    const tx = mockTx([{ plan: 'monthly' }])
    mockWithUserContext.mockImplementation(async (userId, fn) => {
      expect(userId).toBe('u-2') // withUserContext must be called with the CALLER's own id
      return fn(tx as never)
    })

    const result = await getSessionUser(new Request('http://localhost/api/documents', { method: 'POST' }))

    expect(result).toEqual({ ok: true, userId: 'u-2', plan: 'monthly' })
    expect(tx.insert).toHaveBeenCalled()
    expect(tx.values).toHaveBeenCalledWith({ id: 'u-2', email: 'student@example.com' })
    // onConflictDoUpdate (not onConflictDoNothing) is load-bearing: it's what
    // keeps `email` synced with Supabase Auth on every later call.
    expect(tx.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({ set: { email: 'student@example.com' } }))
  })

  it('defaults plan to "free" if the upsert somehow returns no row', async () => {
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'u-3', email: 'x@example.com' } }, error: null })
    mockAuth(getUser)
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

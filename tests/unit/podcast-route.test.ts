import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { checkPodcastBurstLimit, claimPodcastBudget } from '@/lib/podcastLimits'
import { generatePodcastScriptFromText } from '@/lib/podcastScript'
import { generatePodcastAudio } from '@/lib/podcastAudio'
import { uploadPodcastAudio, createPodcastSignedUrl } from '@/lib/podcastStorage'
import { withUserContext } from '@/lib/db'
import { podcasts } from '@/lib/db/schema'

// Mock factories return only inline vi.fn()s with no outer-scope references —
// vi.mock is hoisted above this file's own declarations, so referencing a
// const from inside a factory trips Vitest's hoisting-safety check. Typed
// handles come from vi.mocked() afterwards, matching tests/unit/notes-route.test.ts.
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }),
}))
vi.mock('@/lib/podcastLimits', () => ({
  checkPodcastBurstLimit: vi.fn(),
  claimPodcastBudget: vi.fn(),
}))
vi.mock('@/lib/podcastScript', () => ({ generatePodcastScriptFromText: vi.fn() }))
vi.mock('@/lib/podcastAudio', () => ({ generatePodcastAudio: vi.fn() }))
vi.mock('@/lib/podcastStorage', () => ({
  uploadPodcastAudio: vi.fn(),
  createPodcastSignedUrl: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ withUserContext: vi.fn() }))

const getSessionUserMock = vi.mocked(getSessionUser)
const checkPodcastBurstLimitMock = vi.mocked(checkPodcastBurstLimit)
const claimPodcastBudgetMock = vi.mocked(claimPodcastBudget)
const generateScriptMock = vi.mocked(generatePodcastScriptFromText)
const generateAudioMock = vi.mocked(generatePodcastAudio)
const uploadMock = vi.mocked(uploadPodcastAudio)
const signMock = vi.mocked(createPodcastSignedUrl)
const withUserContextMock = vi.mocked(withUserContext)

// This file pins the route's own branching/ordering logic (auth -> burst ->
// ownership lookup -> existing-podcast handling -> text check -> budget ->
// script -> audio -> upload -> persist) against mocked collaborators. The
// no-mocks proof that the three underlying modules really work end to end
// (real TTS -> real WAV -> real private-bucket upload -> real signed fetch)
// already lives in tests/integration/podcast.test.ts from MEM-014, gated
// opt-in because it spends real money.
import { GET, POST, maxDuration } from '@/app/api/documents/[id]/podcast/route'

const DOC_ID = '11111111-1111-1111-1111-111111111111'
const USER_ID = '22222222-2222-2222-2222-222222222222'
const PODCAST_ID = '33333333-3333-3333-3333-333333333333'

let documentRows: unknown[] = []
let podcastRows: unknown[] = []
let insertRows: unknown[] = []
let updateRows: unknown[] = []
let updateSets: Record<string, unknown>[] = []

/** A Promise that also carries the extra chain methods drizzle exposes. */
function chain(rows: unknown[], extras: Record<string, unknown> = {}) {
  const p = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
  Object.assign(p, extras)
  return p
}

const READY_ROW = {
  id: PODCAST_ID,
  documentId: DOC_ID,
  userId: USER_ID,
  status: 'ready',
  storagePath: `${USER_ID}/${PODCAST_ID}.wav`,
  durationSeconds: 277,
  errorMessage: null,
  createdAt: new Date('2026-08-11T00:00:00Z'),
}

const SCRIPT_TURNS = [
  { speaker: 'A' as const, text: 'So this chapter is about entropy.' },
  { speaker: 'B' as const, text: 'Wait, why does that matter?' },
]

function makeRequest(method = 'POST') {
  return new Request(`http://localhost/api/documents/${DOC_ID}/podcast`, { method })
}

function makeContext(id: string = DOC_ID) {
  return { params: Promise.resolve({ id }) }
}

/** Arms the whole happy path; individual tests override one step. */
function armHappyPath() {
  getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
  documentRows = [{ id: DOC_ID, userId: USER_ID, rawText: 'real lecture text' }]
  podcastRows = []
  insertRows = [{ ...READY_ROW, status: 'generating', storagePath: null, durationSeconds: null }]
  updateRows = [READY_ROW]
  generateScriptMock.mockResolvedValue({ success: true, data: { turns: SCRIPT_TURNS } })
  generateAudioMock.mockResolvedValue({
    success: true,
    audio: Buffer.from('RIFF'),
    mimeType: 'audio/wav',
    durationSeconds: 277,
  })
  uploadMock.mockResolvedValue({ success: true, storagePath: READY_ROW.storagePath })
  signMock.mockResolvedValue({ success: true, url: 'https://signed.example/podcast.wav', expiresInSeconds: 3600 })
}

beforeEach(() => {
  vi.clearAllMocks()
  documentRows = []
  podcastRows = []
  insertRows = []
  updateRows = []
  updateSets = []
  checkPodcastBurstLimitMock.mockResolvedValue({ ok: true })
  claimPodcastBudgetMock.mockResolvedValue({ ok: true })
  withUserContextMock.mockImplementation(async (_userId, fn) => {
    const fakeTx = {
      // `from(table)` is what distinguishes the document lookup from the
      // podcast lookup, rather than call order — the route does both.
      select: () => ({
        from: (table: unknown) => {
          const rows = table === podcasts ? podcastRows : documentRows
          return { where: () => chain(rows, { orderBy: () => ({ limit: () => chain(rows) }) }) }
        },
      }),
      insert: () => ({ values: () => ({ returning: () => chain(insertRows) }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updateSets.push(values)
          return { where: () => chain([], { returning: () => chain(updateRows) }) }
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    return fn(fakeTx)
  })
})

describe('POST /api/documents/[id]/podcast', () => {
  it('declares a maxDuration sized for two sequential external calls', () => {
    // Regression pin: 300 is both the worst-case requirement (see the route's
    // header math) and Vercel's Hobby Fluid Compute ceiling. Dropping it back
    // to the 60/120 the other AI routes use would kill a real generation
    // mid-TTS; raising it past 300 fails the deploy outright.
    expect(maxDuration).toBe(300)
  })

  it('returns 400 for a malformed document id, without touching the session', async () => {
    const res = await POST(makeRequest(), makeContext('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  it('returns 401 when there is no valid session, before any rate-limit work', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(401)
    expect(checkPodcastBurstLimitMock).not.toHaveBeenCalled()
  })

  it('returns 429 when burst-limited, before looking anything up', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    checkPodcastBurstLimitMock.mockResolvedValue({ ok: false, status: 429, reason: 'slow down' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(withUserContextMock).not.toHaveBeenCalled()
    expect(claimPodcastBudgetMock).not.toHaveBeenCalled()
  })

  it('returns 404 for a document that does not exist or is not owned, spending nothing', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    documentRows = []

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    expect(claimPodcastBudgetMock).not.toHaveBeenCalled()
    expect(generateScriptMock).not.toHaveBeenCalled()
  })

  it('returns 422 without claiming budget when the document has no text', async () => {
    // The ordering convention this repo established in MEM-004's review:
    // burst -> validate the request -> only then claim budget, because a
    // claim increments a counter whatever happens next.
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    documentRows = [{ id: DOC_ID, userId: USER_ID, rawText: '   ' }]

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
    expect(claimPodcastBudgetMock).not.toHaveBeenCalled()
    expect(generateScriptMock).not.toHaveBeenCalled()
  })

  it('returns 429 when the daily podcast budget is exhausted, without calling any vendor', async () => {
    armHappyPath()
    claimPodcastBudgetMock.mockResolvedValue({ ok: false, status: 429, reason: 'daily limit reached' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(generateScriptMock).not.toHaveBeenCalled()
    expect(generateAudioMock).not.toHaveBeenCalled()
  })

  it('returns the existing ready podcast with a fresh signed URL instead of regenerating', async () => {
    armHappyPath()
    podcastRows = [READY_ROW]

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.existing).toBe(true)
    expect(body.podcast.id).toBe(PODCAST_ID)
    expect(body.audioUrl).toBe('https://signed.example/podcast.wav')
    // The whole point: no quota spent, no vendor call, nothing regenerated.
    expect(claimPodcastBudgetMock).not.toHaveBeenCalled()
    expect(generateScriptMock).not.toHaveBeenCalled()
    expect(signMock).toHaveBeenCalledWith(READY_ROW.storagePath)
  })

  it('rejects a duplicate request while a generation is already in flight', async () => {
    armHappyPath()
    podcastRows = [{ ...READY_ROW, status: 'generating', storagePath: null, durationSeconds: null }]

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error).toMatch(/already being generated/i)
    expect(claimPodcastBudgetMock).not.toHaveBeenCalled()
    expect(generateScriptMock).not.toHaveBeenCalled()
  })

  it('regenerates after a previous failure rather than blocking on the failed row', async () => {
    armHappyPath()
    podcastRows = [{ ...READY_ROW, status: 'failed', storagePath: null, durationSeconds: null, errorMessage: 'api_error' }]

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(201)
    expect(claimPodcastBudgetMock).toHaveBeenCalledTimes(1)
    expect(generateScriptMock).toHaveBeenCalledTimes(1)
  })

  it('claims the budget exactly once for the whole two-call pipeline', async () => {
    armHappyPath()

    await POST(makeRequest(), makeContext())
    expect(claimPodcastBudgetMock).toHaveBeenCalledTimes(1)
    expect(claimPodcastBudgetMock).toHaveBeenCalledWith(USER_ID, 'free')
    expect(generateScriptMock).toHaveBeenCalledTimes(1)
    expect(generateAudioMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['not_configured', 503],
    ['empty_input', 422],
    ['invalid_response', 422],
    ['api_error', 502],
  ] as const)('maps a %s script failure to %i and marks the row failed', async (reason, status) => {
    armHappyPath()
    generateScriptMock.mockResolvedValue({ success: false, reason, message: 'nope' })

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(status)
    expect(body.reason).toBe(reason)
    expect(body.podcastId).toBe(PODCAST_ID)
    expect(updateSets).toEqual([{ status: 'failed', errorMessage: reason }])
    expect(generateAudioMock).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid_script', 422],
    ['script_too_long', 422],
    ['api_error', 502],
    ['not_configured', 503],
  ] as const)('maps a %s audio failure to %i and marks the row failed', async (reason, status) => {
    armHappyPath()
    generateAudioMock.mockResolvedValue({ success: false, reason, message: 'nope' })

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(status)
    expect(body.reason).toBe(reason)
    expect(updateSets).toEqual([{ status: 'failed', errorMessage: reason }])
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('maps an upload failure to 502 and marks the row failed', async () => {
    armHappyPath()
    uploadMock.mockResolvedValue({ success: false, reason: 'upload_failed', message: 'nope' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(502)
    expect(updateSets).toEqual([{ status: 'failed', errorMessage: 'upload_failed' }])
    expect(signMock).not.toHaveBeenCalled()
  })

  it('still returns the user-facing error when marking the row failed itself throws', async () => {
    armHappyPath()
    generateScriptMock.mockResolvedValue({ success: false, reason: 'api_error', message: 'nope' })
    // First call (document lookup) and second (existing-podcast lookup) and
    // third (insert) succeed; the failure-marking update blows up.
    let call = 0
    withUserContextMock.mockImplementation(async (_userId, fn) => {
      call += 1
      if (call === 4) throw new Error('db is down')
      const fakeTx = {
        select: () => ({
          from: (table: unknown) => {
            const rows = table === podcasts ? podcastRows : documentRows
            return { where: () => chain(rows, { orderBy: () => ({ limit: () => chain(rows) }) }) }
          },
        }),
        insert: () => ({ values: () => ({ returning: () => chain(insertRows) }) }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      return fn(fakeTx)
    })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(502)
  })

  it('persists a ready podcast and returns 201 with a fresh signed URL', async () => {
    armHappyPath()

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.podcast.id).toBe(PODCAST_ID)
    expect(body.podcast.status).toBe('ready')
    expect(body.podcast.durationSeconds).toBe(277)
    expect(body.audioUrl).toBe('https://signed.example/podcast.wav')
    expect(body.expiresInSeconds).toBe(3600)
    expect(updateSets).toEqual([
      { status: 'ready', storagePath: READY_ROW.storagePath, durationSeconds: 277 },
    ])
    expect(uploadMock).toHaveBeenCalledWith(USER_ID, PODCAST_ID, expect.any(Buffer))
    expect(generateAudioMock).toHaveBeenCalledWith(SCRIPT_TURNS)
  })

  it('never exposes the raw storage path to a caller', async () => {
    armHappyPath()

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()
    expect(body.podcast.storagePath).toBeUndefined()
  })

  it('still returns 201 with a null audioUrl if signing the fresh URL fails', async () => {
    armHappyPath()
    signMock.mockResolvedValue({ success: false, reason: 'sign_failed', message: 'nope' })

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    // The podcast really is generated, stored, and paid for — failing the
    // whole request over a signing hiccup would be dishonest. The client can
    // re-ask via GET.
    expect(res.status).toBe(201)
    expect(body.podcast.status).toBe('ready')
    expect(body.audioUrl).toBeNull()
  })
})

describe('GET /api/documents/[id]/podcast', () => {
  it('returns 400 for a malformed document id', async () => {
    const res = await GET(makeRequest('GET'), makeContext('nope'))
    expect(res.status).toBe(400)
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  it('returns 401 when there is no valid session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })

    const res = await GET(makeRequest('GET'), makeContext())
    expect(res.status).toBe(401)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 404 when this document has no podcast (or is not the callers)', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    podcastRows = []

    const res = await GET(makeRequest('GET'), makeContext())
    expect(res.status).toBe(404)
    expect(signMock).not.toHaveBeenCalled()
  })

  it('returns a ready podcast with a freshly minted signed URL', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    podcastRows = [READY_ROW]
    signMock.mockResolvedValue({ success: true, url: 'https://signed.example/fresh.wav', expiresInSeconds: 3600 })

    const res = await GET(makeRequest('GET'), makeContext())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.podcast.id).toBe(PODCAST_ID)
    expect(body.podcast.storagePath).toBeUndefined()
    expect(body.audioUrl).toBe('https://signed.example/fresh.wav')
    expect(signMock).toHaveBeenCalledTimes(1)
  })

  it('returns an in-progress podcast with no URL, and mints nothing', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    podcastRows = [{ ...READY_ROW, status: 'generating', storagePath: null, durationSeconds: null }]

    const res = await GET(makeRequest('GET'), makeContext())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.podcast.status).toBe('generating')
    expect(body.audioUrl).toBeNull()
    expect(signMock).not.toHaveBeenCalled()
  })

  it('surfaces a failed podcast with its recorded reason', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    podcastRows = [{ ...READY_ROW, status: 'failed', storagePath: null, errorMessage: 'api_error' }]

    const res = await GET(makeRequest('GET'), makeContext())
    const body = await res.json()

    expect(body.podcast.status).toBe('failed')
    expect(body.podcast.errorMessage).toBe('api_error')
    expect(body.audioUrl).toBeNull()
  })

  it('claims no budget and runs no rate-limit check (it makes no billed call)', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: USER_ID, plan: 'free' })
    podcastRows = [READY_ROW]
    signMock.mockResolvedValue({ success: true, url: 'https://signed.example/fresh.wav', expiresInSeconds: 3600 })

    await GET(makeRequest('GET'), makeContext())
    expect(checkPodcastBurstLimitMock).not.toHaveBeenCalled()
    expect(claimPodcastBudgetMock).not.toHaveBeenCalled()
  })
})

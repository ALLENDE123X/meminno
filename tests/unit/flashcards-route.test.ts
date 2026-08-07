import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { checkFlashcardsBurstLimit, claimFlashcardsBudget } from '@/lib/flashcardsLimits'
import { generateFlashcardsFromNotes } from '@/lib/flashcardsGeneration'
import { withUserContext } from '@/lib/db'

// Mock factories here deliberately return only inline vi.fn()/plain
// functions with no reference to an outer-scope variable - referencing an
// outer const directly from inside a vi.mock() factory hits Vitest's
// hoisting-safety check ("Cannot access '...' before initialization"),
// since vi.mock calls are hoisted above the file's own top-level
// declarations. Typed references are obtained afterward via vi.mocked(),
// matching this repo's tests/unit/notes-route.test.ts convention (itself
// documented there as the fix for a real gotcha hit during MEM-005).
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }),
}))
vi.mock('@/lib/flashcardsLimits', () => ({
  checkFlashcardsBurstLimit: vi.fn(),
  claimFlashcardsBudget: vi.fn(),
}))
vi.mock('@/lib/flashcardsGeneration', () => ({
  generateFlashcardsFromNotes: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  withUserContext: vi.fn(),
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const checkFlashcardsBurstLimitMock = vi.mocked(checkFlashcardsBurstLimit)
const claimFlashcardsBudgetMock = vi.mocked(claimFlashcardsBudget)
const generateFlashcardsFromNotesMock = vi.mocked(generateFlashcardsFromNotes)
const withUserContextMock = vi.mocked(withUserContext)

// This route is MEM-006's concrete "protected, rate-limited, quota-checked
// AI-generation endpoint" — this file pins its own branching/ordering logic
// (auth -> burst -> lookup -> content check -> budget -> generation ->
// persist) against mocked collaborators, mirroring
// tests/unit/notes-route.test.ts. Real end-to-end verification (real
// session, real notes row, real RLS isolation, and the real
// fail-closed-on-missing-key path) is done separately against the live
// Supabase project — see this ticket's PR description.
import { POST } from '@/app/api/notes/[id]/flashcards/route'

const VALID_NOTE_ID = '11111111-1111-1111-1111-111111111111'

let selectResult: unknown[] = []
let insertResult: unknown[] = []

function makeRequest() {
  return new Request(`http://localhost/api/notes/${VALID_NOTE_ID}/flashcards`, { method: 'POST' })
}

function makeContext(id: string = VALID_NOTE_ID) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/notes/[id]/flashcards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectResult = []
    insertResult = []
    checkFlashcardsBurstLimitMock.mockResolvedValue({ ok: true })
    claimFlashcardsBudgetMock.mockResolvedValue({ ok: true })
    // vi.clearAllMocks() above resets any implementation from the previous
    // test, so it's (re-)armed here every test.
    withUserContextMock.mockImplementation(async (_userId, fn) => {
      const fakeTx = {
        select: () => ({ from: () => ({ where: () => Promise.resolve(selectResult) }) }),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve(insertResult) }) }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      return fn(fakeTx)
    })
  })

  it('returns 400 for a malformed note id, without touching the session', async () => {
    const res = await POST(makeRequest(), makeContext('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  it('returns 401 when there is no valid session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(401)
    expect(checkFlashcardsBurstLimitMock).not.toHaveBeenCalled()
  })

  it('returns 429 when burst-limited, before looking up the note', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    checkFlashcardsBurstLimitMock.mockResolvedValue({ ok: false, status: 429, reason: 'slow down' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the note does not exist or is not owned by the caller', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [] // RLS + the explicit userId filter both collapse "not found" and "not mine" to this

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    expect(claimFlashcardsBudgetMock).not.toHaveBeenCalled()
    expect(generateFlashcardsFromNotesMock).not.toHaveBeenCalled()
  })

  it('returns 422 without claiming budget when the note has no content', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: '   ' }]

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
    expect(claimFlashcardsBudgetMock).not.toHaveBeenCalled()
  })

  it('returns 429 when the daily flashcards budget is exhausted, without calling OpenAI', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    claimFlashcardsBudgetMock.mockResolvedValue({ ok: false, status: 429, reason: 'high demand' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(generateFlashcardsFromNotesMock).not.toHaveBeenCalled()
  })

  it('maps a not_configured generation failure to 503, without inserting flashcards rows', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    generateFlashcardsFromNotesMock.mockResolvedValue({ success: false, reason: 'not_configured', message: 'unavailable' })

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.reason).toBe('not_configured')
  })

  it('maps an invalid_response generation failure to 422', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    generateFlashcardsFromNotesMock.mockResolvedValue({ success: false, reason: 'invalid_response', message: 'bad output' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
  })

  it('maps an api_error generation failure to 502', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    generateFlashcardsFromNotesMock.mockResolvedValue({ success: false, reason: 'api_error', message: 'boom' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(502)
  })

  it('persists flashcards rows and returns 201 on success', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    const cards = [
      { front: 'What is the powerhouse of the cell?', back: 'The mitochondria.' },
      { front: 'What pigment absorbs light for photosynthesis?', back: 'Chlorophyll.' },
    ]
    generateFlashcardsFromNotesMock.mockResolvedValue({ success: true, data: { cards } })
    insertResult = cards.map((c, i) => ({
      id: `card-${i}`,
      noteId: VALID_NOTE_ID,
      userId: 'user-1',
      front: c.front,
      back: c.back,
    }))

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.flashcards).toHaveLength(2)
    expect(body.flashcards[0].front).toBe(cards[0].front)
    expect(withUserContextMock).toHaveBeenCalledTimes(2) // one lookup, one insert
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { checkNotesBurstLimit, claimNotesBudget } from '@/lib/notesLimits'
import { generateNotesFromText } from '@/lib/notesGeneration'
import { withUserContext } from '@/lib/db'

// Mock factories here deliberately return only inline vi.fn()/plain
// functions with no reference to an outer-scope variable - referencing an
// outer const directly from inside a vi.mock() factory hits Vitest's
// hoisting-safety check ("Cannot access '...' before initialization"),
// since vi.mock calls are hoisted above the file's own top-level
// declarations. Typed references are obtained afterward via vi.mocked(),
// matching this repo's own tests/unit/session.test.ts /
// tests/unit/uploadLimits.test.ts convention.
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }),
}))
vi.mock('@/lib/notesLimits', () => ({
  checkNotesBurstLimit: vi.fn(),
  claimNotesBudget: vi.fn(),
}))
vi.mock('@/lib/notesGeneration', () => ({
  generateNotesFromText: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  withUserContext: vi.fn(),
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const checkNotesBurstLimitMock = vi.mocked(checkNotesBurstLimit)
const claimNotesBudgetMock = vi.mocked(claimNotesBudget)
const generateNotesFromTextMock = vi.mocked(generateNotesFromText)
const withUserContextMock = vi.mocked(withUserContext)

// This route is MEM-005's concrete "protected, rate-limited, quota-checked
// AI-generation endpoint" — this file pins its own branching/ordering logic
// (auth -> burst -> lookup -> text check -> budget -> generation -> persist)
// against mocked collaborators. Real end-to-end verification (real session,
// real document, real RLS isolation, and the real fail-closed-on-missing-key
// path) is done separately against the live Supabase project — see this
// ticket's PR description, mirroring me-route.test.ts's own note about the
// same split.
import { POST } from '@/app/api/documents/[id]/notes/route'

const VALID_DOC_ID = '11111111-1111-1111-1111-111111111111'

let selectResult: unknown[] = []
let insertResult: unknown[] = []

function makeRequest() {
  return new Request(`http://localhost/api/documents/${VALID_DOC_ID}/notes`, { method: 'POST' })
}

function makeContext(id: string = VALID_DOC_ID) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/documents/[id]/notes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectResult = []
    insertResult = []
    checkNotesBurstLimitMock.mockResolvedValue({ ok: true })
    claimNotesBudgetMock.mockResolvedValue({ ok: true })
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

  it('returns 400 for a malformed document id, without touching the session', async () => {
    const res = await POST(makeRequest(), makeContext('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  it('returns 401 when there is no valid session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(401)
    expect(checkNotesBurstLimitMock).not.toHaveBeenCalled()
  })

  it('returns 429 when burst-limited, before looking up the document', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    checkNotesBurstLimitMock.mockResolvedValue({ ok: false, status: 429, reason: 'slow down' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the document does not exist or is not owned by the caller', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [] // RLS + the explicit userId filter both collapse "not found" and "not mine" to this

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    expect(claimNotesBudgetMock).not.toHaveBeenCalled()
    expect(generateNotesFromTextMock).not.toHaveBeenCalled()
  })

  it('returns 422 without claiming budget when the document has no text', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_DOC_ID, userId: 'user-1', rawText: '   ' }]

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
    expect(claimNotesBudgetMock).not.toHaveBeenCalled()
  })

  it('returns 429 when the daily notes budget is exhausted, without calling OpenAI', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_DOC_ID, userId: 'user-1', rawText: 'real text' }]
    claimNotesBudgetMock.mockResolvedValue({ ok: false, status: 429, reason: 'high demand' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(generateNotesFromTextMock).not.toHaveBeenCalled()
  })

  it('maps a not_configured generation failure to 503, without inserting a notes row', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_DOC_ID, userId: 'user-1', rawText: 'real text' }]
    generateNotesFromTextMock.mockResolvedValue({ success: false, reason: 'not_configured', message: 'unavailable' })

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.reason).toBe('not_configured')
  })

  it('maps an invalid_response generation failure to 422', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_DOC_ID, userId: 'user-1', rawText: 'real text' }]
    generateNotesFromTextMock.mockResolvedValue({ success: false, reason: 'invalid_response', message: 'bad output' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
  })

  it('maps an api_error generation failure to 502', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_DOC_ID, userId: 'user-1', rawText: 'real text' }]
    generateNotesFromTextMock.mockResolvedValue({ success: false, reason: 'api_error', message: 'boom' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(502)
  })

  it('persists a notes row and returns 201 with structured content on success', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_DOC_ID, userId: 'user-1', rawText: 'real text' }]
    const generated = { title: 'T', summary: 'S', sections: [{ heading: 'H', bullets: ['b'] }], keyConcepts: [] }
    generateNotesFromTextMock.mockResolvedValue({ success: true, data: generated })
    insertResult = [{ id: 'note-1', documentId: VALID_DOC_ID, userId: 'user-1', content: JSON.stringify(generated) }]

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.note.id).toBe('note-1')
    // Response content is the parsed structured object, not the raw
    // JSON-stringified DB column value.
    expect(body.note.content).toEqual(generated)
    expect(withUserContextMock).toHaveBeenCalledTimes(2) // one lookup, one insert
  })
})

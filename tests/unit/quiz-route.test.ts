import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { checkQuizBurstLimit, claimQuizBudget } from '@/lib/quizLimits'
import { generateQuizFromContent } from '@/lib/quizGeneration'
import { withUserContext } from '@/lib/db'

// Mock factories here deliberately return only inline vi.fn()/plain
// functions with no reference to an outer-scope variable - referencing an
// outer const directly from inside a vi.mock() factory hits Vitest's
// hoisting-safety check ("Cannot access '...' before initialization"),
// since vi.mock calls are hoisted above the file's own top-level
// declarations. Typed references are obtained afterward via vi.mocked(),
// matching this repo's tests/unit/notes-route.test.ts /
// tests/unit/flashcards-route.test.ts convention.
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }),
}))
vi.mock('@/lib/quizLimits', () => ({
  checkQuizBurstLimit: vi.fn(),
  claimQuizBudget: vi.fn(),
}))
vi.mock('@/lib/quizGeneration', () => ({
  generateQuizFromContent: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  withUserContext: vi.fn(),
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const checkQuizBurstLimitMock = vi.mocked(checkQuizBurstLimit)
const claimQuizBudgetMock = vi.mocked(claimQuizBudget)
const generateQuizFromContentMock = vi.mocked(generateQuizFromContent)
const withUserContextMock = vi.mocked(withUserContext)

// This route is MEM-007's concrete "protected, rate-limited, quota-checked
// AI-generation endpoint" — the third in the notes -> flashcards -> quiz
// core loop. This file pins its own branching/ordering logic (auth -> burst
// -> notes lookup -> content check -> flashcards lookup -> budget ->
// generation -> persist) against mocked collaborators, mirroring
// tests/unit/notes-route.test.ts / tests/unit/flashcards-route.test.ts. Real
// end-to-end verification (real session, real notes/flashcards rows, real
// RLS isolation, and the real fail-closed-on-missing-key path) is done
// separately against the live Supabase project — see this ticket's PR
// description.
import { POST } from '@/app/api/notes/[id]/quiz/route'

const VALID_NOTE_ID = '11111111-1111-1111-1111-111111111111'

// withUserContext is called up to 3 times in sequence in the route: (1) the
// notes lookup, (2) the flashcards lookup (only reached if the note exists
// with content), (3) the quiz insert. Each call gets its own fake
// transaction; a call counter picks which queued select-result array to
// return, since both (1) and (2) go through the same generic
// `select().from().where()` shape.
let noteSelectResult: unknown[] = []
let flashcardsSelectResult: unknown[] = []
let insertResult: unknown[] = []
let withUserContextCallCount = 0

function makeRequest() {
  return new Request(`http://localhost/api/notes/${VALID_NOTE_ID}/quiz`, { method: 'POST' })
}

function makeContext(id: string = VALID_NOTE_ID) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/notes/[id]/quiz', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    noteSelectResult = []
    flashcardsSelectResult = []
    insertResult = []
    withUserContextCallCount = 0
    checkQuizBurstLimitMock.mockResolvedValue({ ok: true })
    claimQuizBudgetMock.mockResolvedValue({ ok: true })
    // vi.clearAllMocks() above resets any implementation from the previous
    // test, so it's (re-)armed here every test.
    withUserContextMock.mockImplementation(async (_userId, fn) => {
      withUserContextCallCount += 1
      const callIndex = withUserContextCallCount
      const fakeTx = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(callIndex === 1 ? noteSelectResult : flashcardsSelectResult),
          }),
        }),
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
    expect(checkQuizBurstLimitMock).not.toHaveBeenCalled()
  })

  it('returns 429 when burst-limited, before looking up the note', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    checkQuizBurstLimitMock.mockResolvedValue({ ok: false, status: 429, reason: 'slow down' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the note does not exist or is not owned by the caller', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [] // RLS + the explicit userId filter both collapse "not found" and "not mine" to this

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(404)
    expect(claimQuizBudgetMock).not.toHaveBeenCalled()
    expect(generateQuizFromContentMock).not.toHaveBeenCalled()
    // Never reaches the flashcards lookup either.
    expect(withUserContextMock).toHaveBeenCalledTimes(1)
  })

  it('returns 422 without claiming budget or looking up flashcards when the note has no content', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: '   ' }]

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
    expect(claimQuizBudgetMock).not.toHaveBeenCalled()
    expect(withUserContextMock).toHaveBeenCalledTimes(1)
  })

  it('looks up the note\'s existing flashcards and passes them into generation', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    flashcardsSelectResult = [
      { front: 'Q1', back: 'A1' },
      { front: 'Q2', back: 'A2' },
    ]
    const questions = [
      { question: 'Q?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A' },
    ]
    generateQuizFromContentMock.mockResolvedValue({ success: true, data: { questions } })
    insertResult = [{ id: 'quiz-1', noteId: VALID_NOTE_ID, userId: 'user-1', questions }]

    await POST(makeRequest(), makeContext())

    expect(generateQuizFromContentMock).toHaveBeenCalledWith('real notes content', flashcardsSelectResult)
  })

  it('generates a quiz with an empty flashcards array when the note has none yet', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    flashcardsSelectResult = []
    generateQuizFromContentMock.mockResolvedValue({
      success: true,
      data: { questions: [{ question: 'Q?', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A' }] },
    })
    insertResult = [{ id: 'quiz-1' }]

    await POST(makeRequest(), makeContext())

    expect(generateQuizFromContentMock).toHaveBeenCalledWith('real notes content', [])
  })

  it('returns 429 when the daily quiz budget is exhausted, without calling OpenAI', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    claimQuizBudgetMock.mockResolvedValue({ ok: false, status: 429, reason: 'high demand' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(429)
    expect(generateQuizFromContentMock).not.toHaveBeenCalled()
  })

  it('maps a not_configured generation failure to 503, without inserting a quiz row', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    generateQuizFromContentMock.mockResolvedValue({ success: false, reason: 'not_configured', message: 'unavailable' })

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.reason).toBe('not_configured')
    // withUserContext called for the note lookup and flashcards lookup only
    // — never a 3rd time for an insert.
    expect(withUserContextMock).toHaveBeenCalledTimes(2)
  })

  it('maps an invalid_response generation failure to 422', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    generateQuizFromContentMock.mockResolvedValue({ success: false, reason: 'invalid_response', message: 'bad output' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(422)
  })

  it('maps an api_error generation failure to 502', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    generateQuizFromContentMock.mockResolvedValue({ success: false, reason: 'api_error', message: 'boom' })

    const res = await POST(makeRequest(), makeContext())
    expect(res.status).toBe(502)
  })

  it('persists a quiz row and returns 201 on success', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    noteSelectResult = [{ id: VALID_NOTE_ID, userId: 'user-1', content: 'real notes content' }]
    flashcardsSelectResult = []
    const questions = [
      { question: 'What absorbs light for photosynthesis?', options: ['Chlorophyll', 'Water', 'Oxygen', 'Glucose'], correctAnswer: 'Chlorophyll' },
    ]
    generateQuizFromContentMock.mockResolvedValue({ success: true, data: { questions } })
    insertResult = [{ id: 'quiz-1', noteId: VALID_NOTE_ID, userId: 'user-1', questions }]

    const res = await POST(makeRequest(), makeContext())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.quiz.id).toBe('quiz-1')
    expect(body.quiz.questions).toEqual(questions)
    // note lookup, flashcards lookup, insert
    expect(withUserContextMock).toHaveBeenCalledTimes(3)
  })
})

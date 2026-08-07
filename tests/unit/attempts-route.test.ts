import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { checkQuizAttemptBurstLimit } from '@/lib/quizAttempts'
import { withUserContext } from '@/lib/db'

// Mock factories here deliberately return only inline vi.fn()/plain
// functions with no reference to an outer-scope variable - referencing an
// outer const directly from inside a vi.mock() factory hits Vitest's
// hoisting-safety check ("Cannot access '...' before initialization"),
// since vi.mock calls are hoisted above the file's own top-level
// declarations. Typed references are obtained afterward via vi.mocked(),
// matching this repo's tests/unit/notes-route.test.ts /
// tests/unit/flashcards-route.test.ts / tests/unit/quiz-route.test.ts
// convention.
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }),
}))
vi.mock('@/lib/quizAttempts', async (importOriginal) => {
  // Unlike the sibling route test files, this one imports the REAL
  // scoreQuizAttempt/submitAnswersSchema/storedQuestionsSchema (only
  // checkQuizAttemptBurstLimit is mocked) — this route's scoring logic is
  // pure and worth exercising for real here rather than stubbing it out,
  // since a mocked scorer would defeat the point of testing "does this
  // route actually grade the submission correctly."
  const actual = await importOriginal<typeof import('@/lib/quizAttempts')>()
  return { ...actual, checkQuizAttemptBurstLimit: vi.fn() }
})
vi.mock('@/lib/db', () => ({
  withUserContext: vi.fn(),
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const checkQuizAttemptBurstLimitMock = vi.mocked(checkQuizAttemptBurstLimit)
const withUserContextMock = vi.mocked(withUserContext)

// This route is MEM-008's "take/score/persist" endpoint MEM-007 explicitly
// deferred (see app/api/notes/[id]/quiz/route.ts's own header comment).
// Pins its branching/ordering logic (auth -> burst -> body validation ->
// quiz lookup -> question-shape validation -> answer-count validation ->
// score -> persist) against mocked collaborators, mirroring
// tests/unit/quiz-route.test.ts. Real end-to-end verification (real
// session, a real manually-seeded quiz row, real RLS isolation, and a real
// cross-user forged-attempt rejection) is done separately against the live
// Supabase project — see this ticket's PR description.
import { POST } from '@/app/api/quizzes/[id]/attempts/route'

const VALID_QUIZ_ID = '22222222-2222-2222-2222-222222222222'

const QUESTIONS = [
  { question: 'What absorbs light for photosynthesis?', options: ['Chlorophyll', 'Water', 'Oxygen', 'Glucose'], correctAnswer: 'Chlorophyll' },
  { question: '2 + 2?', options: ['3', '4', '5', '6'], correctAnswer: '4' },
]

let selectResult: unknown[] = []
let insertResult: unknown[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let insertValuesCalls: any[] = []

function makeRequest(body: unknown) {
  return new Request(`http://localhost/api/quizzes/${VALID_QUIZ_ID}/attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function makeContext(id: string = VALID_QUIZ_ID) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/quizzes/[id]/attempts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectResult = []
    insertResult = []
    insertValuesCalls = []
    checkQuizAttemptBurstLimitMock.mockResolvedValue({ ok: true })
    withUserContextMock.mockImplementation(async (_userId, fn) => {
      const fakeTx = {
        select: () => ({ from: () => ({ where: () => Promise.resolve(selectResult) }) }),
        insert: () => ({
          values: (v: unknown) => {
            insertValuesCalls.push(v)
            return { returning: () => Promise.resolve(insertResult) }
          },
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
      return fn(fakeTx)
    })
  })

  it('returns 400 for a malformed quiz id, without touching the session', async () => {
    const res = await POST(makeRequest({ answers: [] }), makeContext('not-a-uuid'))
    expect(res.status).toBe(400)
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  it('returns 401 when there is no valid session', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })

    const res = await POST(makeRequest({ answers: [] }), makeContext())
    expect(res.status).toBe(401)
    expect(checkQuizAttemptBurstLimitMock).not.toHaveBeenCalled()
  })

  it('returns 429 when burst-limited, before parsing the body or looking up the quiz', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    checkQuizAttemptBurstLimitMock.mockResolvedValue({ ok: false, status: 429, reason: 'slow down' })

    const res = await POST(makeRequest({ answers: [] }), makeContext())
    expect(res.status).toBe(429)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-JSON body', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    const req = new Request(`http://localhost/api/quizzes/${VALID_QUIZ_ID}/attempts`, { method: 'POST', body: 'not json' })

    const res = await POST(req, makeContext())
    expect(res.status).toBe(400)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the body does not match { answers: string[] }', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })

    const res = await POST(makeRequest({ answers: [1, 2] }), makeContext())
    expect(res.status).toBe(400)
    expect(withUserContextMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the quiz does not exist or is not owned by the caller', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [] // RLS + the explicit userId filter both collapse "not found" and "not mine" to this

    const res = await POST(makeRequest({ answers: ['Chlorophyll', '4'] }), makeContext())
    expect(res.status).toBe(404)
    expect(withUserContextMock).toHaveBeenCalledTimes(1) // lookup only, no insert
  })

  it('returns 500 when the stored questions are malformed, without inserting an attempt', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_QUIZ_ID, userId: 'user-1', questions: [{ question: 'no options or answer' }] }]

    const res = await POST(makeRequest({ answers: ['x'] }), makeContext())
    expect(res.status).toBe(500)
    expect(withUserContextMock).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when the answer count does not match the question count', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_QUIZ_ID, userId: 'user-1', questions: QUESTIONS }]

    const res = await POST(makeRequest({ answers: ['Chlorophyll'] }), makeContext())
    expect(res.status).toBe(400)
    expect(withUserContextMock).toHaveBeenCalledTimes(1) // lookup only, no insert
  })

  it('scores the submission correctly, persists an attempt, and returns 201 with a per-question breakdown', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_QUIZ_ID, userId: 'user-1', questions: QUESTIONS }]
    insertResult = [{ id: 'attempt-1', quizId: VALID_QUIZ_ID, userId: 'user-1', score: 50, answers: ['Chlorophyll', '3'] }]

    const res = await POST(makeRequest({ answers: ['Chlorophyll', '3'] }), makeContext())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.attempt.id).toBe('attempt-1')
    expect(body.correctCount).toBe(1)
    expect(body.totalQuestions).toBe(2)
    expect(body.results).toHaveLength(2)
    expect(body.results[0].isCorrect).toBe(true)
    expect(body.results[1].isCorrect).toBe(false)
    expect(body.results[1].correctAnswer).toBe('4')
    // quiz lookup, then the insert
    expect(withUserContextMock).toHaveBeenCalledTimes(2)
    // The route itself must compute this score (1 of 2 correct = 50) and
    // pass it into the insert — not trust anything from the request body.
    expect(insertValuesCalls[0]).toEqual({ quizId: VALID_QUIZ_ID, userId: 'user-1', score: 50, answers: ['Chlorophyll', '3'] })
  })

  it('scores a fully-correct submission as 100', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    selectResult = [{ id: VALID_QUIZ_ID, userId: 'user-1', questions: QUESTIONS }]
    insertResult = [{ id: 'attempt-2', quizId: VALID_QUIZ_ID, userId: 'user-1', score: 100, answers: ['Chlorophyll', '4'] }]

    const res = await POST(makeRequest({ answers: ['Chlorophyll', '4'] }), makeContext())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.correctCount).toBe(2)
  })
})

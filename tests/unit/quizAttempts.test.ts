import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/ratelimit', () => ({
  limitRequest: vi.fn(),
}))

import { limitRequest } from '@/lib/ratelimit'
import {
  scoreQuizAttempt,
  submitAnswersSchema,
  storedQuestionsSchema,
  checkQuizAttemptBurstLimit,
  type StoredQuestion,
} from '@/lib/quizAttempts'

const limitRequestMock = vi.mocked(limitRequest)

const QUESTIONS: StoredQuestion[] = [
  { question: 'What absorbs light for photosynthesis?', options: ['Chlorophyll', 'Water', 'Oxygen', 'Glucose'], correctAnswer: 'Chlorophyll' },
  { question: '2 + 2?', options: ['3', '4', '5', '6'], correctAnswer: '4' },
  { question: 'Capital of France?', options: ['Berlin', 'Madrid', 'Paris', 'Rome'], correctAnswer: 'Paris' },
]

describe('scoreQuizAttempt', () => {
  it('scores 100% when every answer is correct', () => {
    const result = scoreQuizAttempt(QUESTIONS, ['Chlorophyll', '4', 'Paris'])
    expect(result.score).toBe(100)
    expect(result.correctCount).toBe(3)
    expect(result.totalQuestions).toBe(3)
    expect(result.results.every((r) => r.isCorrect)).toBe(true)
  })

  it('scores 0% when every answer is wrong', () => {
    const result = scoreQuizAttempt(QUESTIONS, ['Water', '3', 'Rome'])
    expect(result.score).toBe(0)
    expect(result.correctCount).toBe(0)
  })

  it('rounds a partial score to the nearest integer percentage', () => {
    // 1 of 3 correct = 33.33...% -> rounds to 33
    const result = scoreQuizAttempt(QUESTIONS, ['Chlorophyll', '3', 'Rome'])
    expect(result.score).toBe(33)
    expect(result.correctCount).toBe(1)
  })

  it('treats a missing answer (shorter answers array) as incorrect, not a crash', () => {
    const result = scoreQuizAttempt(QUESTIONS, ['Chlorophyll'])
    expect(result.correctCount).toBe(1)
    expect(result.results[1].userAnswer).toBe('')
    expect(result.results[1].isCorrect).toBe(false)
    expect(result.results[2].userAnswer).toBe('')
  })

  it('treats an empty-string answer as incorrect and reports it verbatim', () => {
    const result = scoreQuizAttempt(QUESTIONS, ['', '4', 'Paris'])
    expect(result.results[0].userAnswer).toBe('')
    expect(result.results[0].isCorrect).toBe(false)
    expect(result.correctCount).toBe(2)
  })

  it('returns a 0% score with no results for zero questions rather than dividing by zero', () => {
    const result = scoreQuizAttempt([], [])
    expect(result.score).toBe(0)
    expect(result.totalQuestions).toBe(0)
    expect(result.results).toHaveLength(0)
  })

  it('each result row carries the question, options, and correctAnswer for a results UI', () => {
    const result = scoreQuizAttempt(QUESTIONS, ['Water', '4', 'Paris'])
    expect(result.results[0]).toEqual({
      question: QUESTIONS[0].question,
      options: QUESTIONS[0].options,
      correctAnswer: 'Chlorophyll',
      userAnswer: 'Water',
      isCorrect: false,
    })
  })
})

describe('submitAnswersSchema', () => {
  it('accepts an array of strings', () => {
    expect(submitAnswersSchema.safeParse({ answers: ['a', 'b'] }).success).toBe(true)
  })

  it('accepts an empty array (all-blank submission)', () => {
    expect(submitAnswersSchema.safeParse({ answers: [] }).success).toBe(true)
  })

  it('rejects a missing answers field', () => {
    expect(submitAnswersSchema.safeParse({}).success).toBe(false)
  })

  it('rejects non-string entries', () => {
    expect(submitAnswersSchema.safeParse({ answers: [1, 2] }).success).toBe(false)
  })
})

describe('storedQuestionsSchema', () => {
  it('accepts a well-formed question array', () => {
    expect(storedQuestionsSchema.safeParse(QUESTIONS).success).toBe(true)
  })

  it('rejects an empty array', () => {
    expect(storedQuestionsSchema.safeParse([]).success).toBe(false)
  })

  it('rejects a question missing correctAnswer', () => {
    const malformed = [{ question: 'Q', options: ['A', 'B'] }]
    expect(storedQuestionsSchema.safeParse(malformed).success).toBe(false)
  })

  it('rejects non-array input (e.g. legacy/malformed jsonb)', () => {
    expect(storedQuestionsSchema.safeParse({ not: 'an array' }).success).toBe(false)
    expect(storedQuestionsSchema.safeParse(null).success).toBe(false)
  })
})

describe('checkQuizAttemptBurstLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows the request when the underlying limiter succeeds', async () => {
    limitRequestMock.mockResolvedValue({ success: true })
    const result = await checkQuizAttemptBurstLimit('user-1')
    expect(result).toEqual({ ok: true })
    expect(limitRequestMock).toHaveBeenCalledWith('meminno-quiz-attempt-burst:user-1')
  })

  it('rejects with 429 when the underlying limiter fails', async () => {
    limitRequestMock.mockResolvedValue({ success: false })
    const result = await checkQuizAttemptBurstLimit('user-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(429)
      expect(result.reason).toMatch(/slow down/i)
    }
  })

  it('uses a distinct key namespace from notes/flashcards/quiz-generation burst limiters', async () => {
    limitRequestMock.mockResolvedValue({ success: true })
    await checkQuizAttemptBurstLimit('user-42')
    const key = limitRequestMock.mock.calls[0][0]
    expect(key).toContain('quiz-attempt-burst')
    expect(key).not.toContain('quiz-burst')
  })
})

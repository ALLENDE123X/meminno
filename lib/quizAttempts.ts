// MEM-008: scoring + request-shape validation for POST
// /api/quizzes/[id]/attempts (this ticket's own endpoint — MEM-007 explicitly
// scoped quiz_attempts creation/scoring out of its own ticket; see that
// route's header comment and ARCHITECTURE.md's "AI quiz generation" entry).
import { z } from 'zod'
import { limitRequest } from '@/lib/ratelimit'

// quizzes.questions (lib/db/schema.ts) is untyped jsonb — this repo's
// existing convention (matching documents.rawText/amenities-style columns
// elsewhere) casts the shape explicitly at call sites rather than modeling
// it in the schema. lib/quizGeneration.ts's generatedQuizSchema already
// validates this exact shape before it's ever persisted, but this module
// re-declares its own copy rather than importing that one — same
// "don't tightly couple sibling generation modules" convention
// lib/flashcardsGeneration.ts/lib/quizGeneration.ts's own header comments
// document (a notes/quiz row saved by a future/older format should degrade
// to a clear "malformed" error here, not silently import assumptions from
// a generation module this route doesn't otherwise depend on). Re-validated
// on every read (not just trusted from the DB) because it's the input to a
// scoring computation whose result gets persisted right back into the same
// table — worth being defensive about.
const storedQuestionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).min(2),
  correctAnswer: z.string(),
})
export const storedQuestionsSchema = z.array(storedQuestionSchema).min(1)
export type StoredQuestion = z.infer<typeof storedQuestionSchema>

/** The request body POST /api/quizzes/[id]/attempts expects: one answer string per question, in question order. An empty string means "left blank". */
export const submitAnswersSchema = z.object({
  answers: z.array(z.string()),
})

export type QuestionResult = {
  question: string
  options: string[]
  correctAnswer: string
  userAnswer: string
  isCorrect: boolean
}

export type ScoredAttempt = {
  score: number
  correctCount: number
  totalQuestions: number
  results: QuestionResult[]
}

/**
 * Scores a submitted answer set against a quiz's stored questions.
 * `answers[i]` is graded against `questions[i]` — exact-string match against
 * `correctAnswer`, the same comparison lib/quizGeneration.ts's schema itself
 * uses to validate a question's correctAnswer is one of its own options.
 * `score` is a 0-100 integer percentage, matching quiz_attempts.score's
 * column comment (lib/db/schema.ts).
 */
export function scoreQuizAttempt(questions: StoredQuestion[], answers: string[]): ScoredAttempt {
  const results: QuestionResult[] = questions.map((q, i) => {
    // i is the array's own iteration index (Array.prototype.map), not
    // attacker-controlled input — not a real object-injection risk despite
    // the linter warning (matches components/ui/button.tsx's existing
    // disable for the same class of false positive).
    // eslint-disable-next-line security/detect-object-injection
    const userAnswer = answers[i] ?? ''
    return { question: q.question, options: q.options, correctAnswer: q.correctAnswer, userAnswer, isCorrect: userAnswer === q.correctAnswer }
  })
  const correctCount = results.filter((r) => r.isCorrect).length
  const score = questions.length > 0 ? Math.round((correctCount / questions.length) * 100) : 0
  return { score, correctCount, totalQuestions: questions.length, results }
}

export type AttemptLimitResult = { ok: true } | { ok: false; status: 429; reason: string }

/**
 * Burst protection only — deliberately NOT a two-layer lib/aiBudget.ts
 * daily-cap check like every AI-generation endpoint (HARD STOP 6). That
 * requirement exists specifically to bound real, billed OpenAI spend; this
 * route never calls OpenAI (it grades a quiz that was already generated and
 * persisted by MEM-007), so the risk this needs to bound is "someone
 * scripts a burst of forged-score requests," not runaway API cost. A cheap
 * per-user burst limit is a reasonable, proportionate defense for a write
 * endpoint either way.
 */
export async function checkQuizAttemptBurstLimit(userId: string): Promise<AttemptLimitResult> {
  const burst = await limitRequest(`meminno-quiz-attempt-burst:${userId}`)
  if (!burst.success) {
    return { ok: false, status: 429, reason: 'Too many quiz-attempt submissions, please slow down and try again shortly.' }
  }
  return { ok: true }
}

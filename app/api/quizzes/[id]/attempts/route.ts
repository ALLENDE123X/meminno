import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { checkQuizAttemptBurstLimit, submitAnswersSchema, storedQuestionsSchema, scoreQuizAttempt } from '@/lib/quizAttempts'
import { withUserContext } from '@/lib/db'
import { quizzes, quizAttempts } from '@/lib/db/schema'

// MEM-008: the take/score/persist step of the notes -> flashcards -> quiz
// core loop that MEM-007 explicitly deferred to this ticket (see that
// route's header comment — "actually building the take/score/results flow
// is left to MEM-008, not silently dropped"). Given a `quizzes` row the
// caller already owns, scores a submitted set of answers and persists a
// `quiz_attempts` row. No schema change needed — quiz_attempts and its
// quiz_attempts_own_rows RLS policy (with the matching authenticated /
// meminno_rls GRANTs and FORCE ROW LEVEL SECURITY) already exist from
// MEM-002/MEM-002-fix.
//
// Mirrors app/api/notes/[id]/quiz/route.ts's structure (same codebase
// convention every AI-generation route already follows), adapted for a
// route that scores existing data rather than calling OpenAI:
//   - Same URL shape convention: POST /api/<parent>/[id]/<child>.
//   - Same order of operations: validate id -> session -> burst -> lookup
//     (scoped to the caller) -> validate input -> persist.
//   - Same cross-user isolation shape: a nonexistent quiz id and another
//     user's quiz id are indistinguishable — both 404, via the explicit
//     userId filter below alongside the quizzes_own_rows RLS policy
//     (defense in depth, matching every other route in this codebase).
//
// Deliberately NOT gated by lib/aiBudget.ts's two-layer AI-generation rate
// limiting (HARD STOP 6) — this route never calls OpenAI, so there's no
// billed-API-spend surface to bound. See lib/quizAttempts.ts's
// checkQuizAttemptBurstLimit for the (burst-only) rate limiting this route
// does apply, and why.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: quizId } = await context.params
  if (!UUID_RE.test(quizId)) {
    return NextResponse.json({ error: 'Invalid quiz id' }, { status: 400 })
  }

  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId } = session

  const burst = await checkQuizAttemptBurstLimit(userId)
  if (!burst.ok) {
    logger.warn({ userId, quizId }, 'Quiz attempt submission burst-limited')
    return NextResponse.json({ error: burst.reason }, { status: burst.status })
  }

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body with an "answers" array' }, { status: 400 })
  }
  const parsedBody = submitAnswersSchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: 'Expected { answers: string[] }' }, { status: 400 })
  }

  // Explicit userId filter alongside the RLS policy (quiz_attempts_own_rows
  // covers the insert below; quizzes_own_rows covers this lookup) — defense
  // in depth, matching every other route in this codebase: a forgotten
  // WHERE clause here would still be caught by RLS returning zero rows for
  // another user's quiz, and vice versa. Also this ticket's cross-user
  // isolation proof: a caller can never receive, and can never submit an
  // attempt for, a quiz id that isn't theirs — it 404s exactly like a
  // nonexistent id.
  const [quiz] = await withUserContext(userId, (tx) =>
    tx.select().from(quizzes).where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId)))
  )
  if (!quiz) {
    return NextResponse.json({ error: 'Quiz not found' }, { status: 404 })
  }

  const parsedQuestions = storedQuestionsSchema.safeParse(quiz.questions)
  if (!parsedQuestions.success) {
    // Should be unreachable for anything MEM-007's generator produced (it
    // validates this exact shape before persisting) — a real 500, not an
    // assumption, same as app/api/me/route.ts's "should be unreachable"
    // convention for a similarly-impossible-in-practice state.
    logger.error({ userId, quizId }, 'Quiz row has malformed questions data')
    return NextResponse.json({ error: 'This quiz could not be scored — its questions are malformed' }, { status: 500 })
  }

  const { answers } = parsedBody.data
  if (answers.length !== parsedQuestions.data.length) {
    return NextResponse.json(
      { error: `Expected ${parsedQuestions.data.length} answers (one per question), got ${answers.length}` },
      { status: 400 }
    )
  }

  const scored = scoreQuizAttempt(parsedQuestions.data, answers)

  const [attempt] = await withUserContext(userId, (tx) =>
    tx
      .insert(quizAttempts)
      .values({ quizId, userId, score: scored.score, answers })
      .returning()
  )

  logger.info({ userId, quizId, attemptId: attempt.id, score: scored.score }, 'Quiz attempt scored and persisted')
  return NextResponse.json(
    { attempt, correctCount: scored.correctCount, totalQuestions: scored.totalQuestions, results: scored.results },
    { status: 201 }
  )
}

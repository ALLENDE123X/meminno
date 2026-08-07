import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { checkQuizBurstLimit, claimQuizBudget } from '@/lib/quizLimits'
import { generateQuizFromContent, type GenerateQuizResult } from '@/lib/quizGeneration'
import { withUserContext } from '@/lib/db'
import { notes, flashcards, quizzes } from '@/lib/db/schema'

// MEM-007: the third and final AI-generation endpoint of the notes ->
// flashcards -> quiz core loop (see CLAUDE.md's "Why this ticket matters
// more than usual" framing — this is the last step of the escalating reveal
// the launch marketing video is built around). Given a `notes` row the
// caller already owns, calls OpenAI (lib/quizGeneration.ts) to generate a
// multiple-choice quiz — reinforced by that note's existing `flashcards`
// rows when any exist, per this ticket's dispatch ("notes content as
// primary context, flashcard fronts/backs as reinforcement") — and persists
// it as a new `quizzes` row. `quizzes.note_id`/`quizzes.user_id`/
// `quizzes.questions` already existed from MEM-002; no schema change needed.
//
// Mirrors app/api/notes/[id]/flashcards/route.ts's structure closely (per
// this ticket's dispatch instructions), adapted from notes->flashcards to
// notes->quiz:
//   - Same URL shape convention: POST /api/<parent>/[id]/<child>.
//   - Same order of operations: validate id -> session -> burst -> lookup
//     notes row (scoped to the caller) -> content check -> fetch that note's
//     flashcards (best-effort, never blocking) -> budget -> generate ->
//     persist.
//   - Multiple generations per notes row are allowed (each POST creates a
//     fresh `quizzes` row) — no "regenerate" special case, same as
//     MEM-005/MEM-006's routes; a later ticket can add one if the product
//     needs it. Each generation still costs a day's quota (see
//     lib/quizLimits.ts).
//
// Scope decision (documented per this ticket's dispatch): quiz_attempts
// creation, scoring, and any submit-answer flow are NOT built here. The real
// GitHub issue (#7) scopes this ticket as "generate quiz from notes +
// flashcards, same structured-extraction pattern" with no mention of taking
// or scoring a quiz, and there is no quiz-taking UI yet for a submit-answer
// endpoint to serve (that's MEM-008, Core UI — the same ticket that owns the
// quiz-taking screen this would need to exist for). This mirrors MEM-006's
// own scope call on spaced-repetition fields: generating and persisting the
// quiz against the existing schema is "quiz_attempts-ready" in the sense
// that nothing here blocks adding that flow later (each quiz already has a
// stable `id`/`note_id`/`user_id` for a future `quiz_attempts` row to
// reference) — actually building it is left to MEM-008.
// Issue #24 (maxDuration audit, 2026-08-07): OPENAI_API_KEY is live and this
// route is the one most exposed to a platform-level timeout - not only does
// it make a real gpt-4o-mini call over notes + flashcards content, but
// MEM-007-fix (issue #26) added a bounded retry-on-invalid_response, so a
// single POST can now cost up to two real OpenAI calls. An undeclared
// maxDuration both depends implicitly on a platform default that can change
// and is far shorter than the openai SDK's own default per-call timeout
// budget (10 minutes, retried), which compounds badly with this module's own
// retry - see lib/quizGeneration.ts's OPENAI_TIMEOUT_MS/OPENAI_MAX_RETRIES
// comment for the full worst-case math (up to ~80s for both attempts
// combined). 120s covers that plus this route's own session/DB/Redis
// overhead (session lookup, burst check, notes lookup, flashcards lookup,
// budget claim, final insert) with real margin, while staying well under
// Vercel's Hobby-plan Fluid Compute ceiling (300s as of this writing) so a
// genuinely stuck function still gets killed well short of that.
export const maxDuration = 120

type QuizFailureReason = Exclude<GenerateQuizResult, { success: true }>['reason']

const REASON_STATUS: Record<QuizFailureReason, number> = {
  not_configured: 503,
  empty_input: 422,
  invalid_response: 422,
  api_error: 502,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: noteId } = await context.params
  if (!UUID_RE.test(noteId)) {
    return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
  }

  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId, plan } = session

  // Burst check runs before the notes lookup — cheap, note-independent, and
  // meant to catch rapid-fire requests (e.g. a mashed "generate quiz"
  // button) regardless of which notes row they target.
  const burst = await checkQuizBurstLimit(userId)
  if (!burst.ok) {
    logger.warn({ userId, plan, noteId }, 'Quiz generation burst-limited')
    return NextResponse.json({ error: burst.reason }, { status: burst.status })
  }

  // Explicit userId filter alongside the RLS policy (notes_own_rows) —
  // defense in depth, matching app/api/notes/[id]/flashcards/route.ts's
  // convention: a forgotten WHERE clause here would still be caught by RLS
  // returning zero rows for another user's notes row, and vice versa. Also
  // doubles as this ticket's real cross-user isolation proof: a caller can
  // never receive, and can never spend quota generating a quiz for, a notes
  // id that isn't theirs — it 404s exactly like a nonexistent id.
  const [note] = await withUserContext(userId, (tx) =>
    tx.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
  )
  if (!note) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 })
  }
  if (!note.content?.trim()) {
    // No quota claimed for this — a notes row with nothing to generate a
    // quiz from should never cost the caller part of their daily allowance,
    // same "don't claim budget before the request is known-valid" ordering
    // lib/uploadLimits.ts/lib/notesLimits.ts/lib/flashcardsLimits.ts
    // established.
    return NextResponse.json({ error: 'This note has no content to generate a quiz from' }, { status: 422 })
  }

  // Best-effort reinforcement input, not a requirement: a note with no
  // flashcards yet (a caller going straight from notes to quiz) still
  // produces a complete quiz from the notes alone — see
  // lib/quizGeneration.ts's buildPromptText for why this is deliberate.
  // Scoped by both noteId and userId for the same defense-in-depth reason as
  // the notes lookup above.
  const existingFlashcards = await withUserContext(userId, (tx) =>
    tx
      .select({ front: flashcards.front, back: flashcards.back })
      .from(flashcards)
      .where(and(eq(flashcards.noteId, noteId), eq(flashcards.userId, userId)))
  )

  const budget = await claimQuizBudget(userId, plan)
  if (!budget.ok) {
    logger.warn({ userId, plan, noteId }, 'Quiz generation budget limited')
    return NextResponse.json({ error: budget.reason }, { status: budget.status })
  }

  const result = await generateQuizFromContent(note.content, existingFlashcards)
  if (!result.success) {
    logger.warn({ userId, noteId, reason: result.reason }, 'Quiz generation failed')
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: REASON_STATUS[result.reason] })
  }

  const [quiz] = await withUserContext(userId, (tx) =>
    tx
      .insert(quizzes)
      .values({ noteId, userId, questions: result.data.questions })
      .returning()
  )

  logger.info(
    { userId, noteId, quizId: quiz.id, questionCount: result.data.questions.length, flashcardsUsed: existingFlashcards.length },
    'AI quiz generated'
  )
  return NextResponse.json({ quiz }, { status: 201 })
}

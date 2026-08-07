import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { checkFlashcardsBurstLimit, claimFlashcardsBudget } from '@/lib/flashcardsLimits'
import { generateFlashcardsFromNotes, type GenerateFlashcardsResult } from '@/lib/flashcardsGeneration'
import { withUserContext } from '@/lib/db'
import { notes, flashcards } from '@/lib/db/schema'

// MEM-006: given a `notes` row the caller already owns, calls OpenAI
// (lib/flashcardsGeneration.ts) to generate a set of flashcards and persists
// them as new `flashcards` rows — one row per card, per lib/db/schema.ts's
// existing shape (no schema change needed; `flashcards` already existed from
// MEM-002). Mirrors app/api/documents/[id]/notes/route.ts's structure
// closely (per this ticket's dispatch instructions), adapted from
// documents->notes to notes->flashcards:
//   - Same URL shape convention: POST /api/<parent>/[id]/<child>.
//   - Same order of operations: validate id -> session -> burst -> lookup
//     (scoped to the caller) -> content check -> budget -> generate ->
//     persist.
//   - Multiple generations per notes row are allowed (each POST creates a
//     fresh batch of flashcards rows) — no "regenerate" special case, same
//     as MEM-005's notes route; a later ticket can add one if the product
//     needs it. Each generation still costs a day's quota (see
//     lib/flashcardsLimits.ts).
// Issue #24 (maxDuration audit, 2026-08-07) — same reasoning as
// app/api/documents/[id]/notes/route.ts: OPENAI_API_KEY is live, this route
// makes a real gpt-4o-mini call, and an undeclared maxDuration both depends
// implicitly on a platform default that can change and is far shorter than
// the openai SDK's own default per-call timeout budget (10 minutes,
// retried) - see lib/flashcardsGeneration.ts's OPENAI_TIMEOUT_MS/
// OPENAI_MAX_RETRIES comment for the full worst-case math. 60s covers that
// module's ~40s worst case (a single generate call, no retry here) plus
// this route's own session/DB/Redis overhead with room to spare.
export const maxDuration = 60

type FlashcardsFailureReason = Exclude<GenerateFlashcardsResult, { success: true }>['reason']

const REASON_STATUS: Record<FlashcardsFailureReason, number> = {
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
  // meant to catch rapid-fire requests (e.g. a mashed "generate flashcards"
  // button) regardless of which notes row they target.
  const burst = await checkFlashcardsBurstLimit(userId)
  if (!burst.ok) {
    logger.warn({ userId, plan, noteId }, 'Flashcards generation burst-limited')
    return NextResponse.json({ error: burst.reason }, { status: burst.status })
  }

  // Explicit userId filter alongside the RLS policy (notes_own_rows) —
  // defense in depth, matching app/api/documents/[id]/notes/route.ts's
  // convention: a forgotten WHERE clause here would still be caught by RLS
  // returning zero rows for another user's notes row, and vice versa. Also
  // doubles as this ticket's real cross-user isolation proof: a caller can
  // never receive, and can never spend quota generating flashcards for, a
  // notes id that isn't theirs — it 404s exactly like a nonexistent id.
  const [note] = await withUserContext(userId, (tx) =>
    tx.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
  )
  if (!note) {
    return NextResponse.json({ error: 'Note not found' }, { status: 404 })
  }
  if (!note.content?.trim()) {
    // No quota claimed for this — a notes row with nothing to generate
    // flashcards from should never cost the caller part of their daily
    // allowance, same "don't claim budget before the request is
    // known-valid" ordering lib/uploadLimits.ts/lib/notesLimits.ts
    // established.
    return NextResponse.json({ error: 'This note has no content to generate flashcards from' }, { status: 422 })
  }

  const budget = await claimFlashcardsBudget(userId, plan)
  if (!budget.ok) {
    logger.warn({ userId, plan, noteId }, 'Flashcards generation budget limited')
    return NextResponse.json({ error: budget.reason }, { status: budget.status })
  }

  const result = await generateFlashcardsFromNotes(note.content)
  if (!result.success) {
    logger.warn({ userId, noteId, reason: result.reason }, 'Flashcards generation failed')
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: REASON_STATUS[result.reason] })
  }

  const inserted = await withUserContext(userId, (tx) =>
    tx
      .insert(flashcards)
      .values(result.data.cards.map((card) => ({ noteId, userId, front: card.front, back: card.back })))
      .returning()
  )

  logger.info({ userId, noteId, count: inserted.length }, 'AI flashcards generated')
  return NextResponse.json({ flashcards: inserted }, { status: 201 })
}

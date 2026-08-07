import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { checkNotesBurstLimit, claimNotesBudget } from '@/lib/notesLimits'
import { generateNotesFromText, type GenerateNotesResult } from '@/lib/notesGeneration'
import { withUserContext } from '@/lib/db'
import { documents, notes } from '@/lib/db/schema'

// MEM-005: the first real AI-generation endpoint in this codebase. Given a
// document the caller already owns, calls OpenAI (lib/notesGeneration.ts)
// to synthesize structured study notes and persists them as a new
// notes row. Multiple generations per document are allowed (each POST
// creates a new row) — there's no "regenerate" special case, a later ticket
// can add one if the product needs it, but nothing here stops a caller from
// requesting notes for the same document more than once (each still costs a
// day's quota — see lib/notesLimits.ts).
//
// notes.content is a plain `text` column (lib/db/schema.ts), not jsonb, so
// the structured GeneratedNotes object is JSON.stringify'd before it's
// persisted. The response below intentionally returns the parsed object
// back to the caller (nicer for an immediate consumer than a raw JSON
// string) — DB storage shape and API response shape are deliberately
// decoupled here.
// Issue #24 (maxDuration audit, 2026-08-07): OPENAI_API_KEY went live in
// production during MEM-008, so this route now makes real gpt-4o-mini calls
// over up to 60k characters of document text - with no maxDuration declared,
// this ran on whatever Vercel's account-level default was, which is fragile
// to depend on implicitly (it can change with plan/Fluid Compute settings)
// and, worse, is far shorter than the openai SDK's own default per-call
// timeout budget (10 minutes, retried) - see lib/notesGeneration.ts's
// OPENAI_TIMEOUT_MS/OPENAI_MAX_RETRIES comment for the full worst-case math.
// 60s covers that module's ~40s worst case (a single generate call, no
// retry here - only lib/quizGeneration.ts retries) plus this route's own
// session/DB/Redis overhead (session lookup, burst check, document lookup,
// budget claim, final insert) with room to spare.
export const maxDuration = 60

type NotesFailureReason = Exclude<GenerateNotesResult, { success: true }>['reason']

const REASON_STATUS: Record<NotesFailureReason, number> = {
  not_configured: 503,
  empty_input: 422,
  invalid_response: 422,
  api_error: 502,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: documentId } = await context.params
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json({ error: 'Invalid document id' }, { status: 400 })
  }

  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId, plan } = session

  // Burst check runs before the document lookup — cheap, document-independent,
  // and meant to catch rapid-fire requests (e.g. a mashed "generate" button)
  // regardless of which document they target.
  const burst = await checkNotesBurstLimit(userId)
  if (!burst.ok) {
    logger.warn({ userId, plan, documentId }, 'Notes generation burst-limited')
    return NextResponse.json({ error: burst.reason }, { status: burst.status })
  }

  // Explicit userId filter alongside the RLS policy (documents_own_rows) —
  // defense in depth, matching app/api/me/route.ts's convention: a forgotten
  // WHERE clause here would still be caught by RLS returning zero rows for
  // another user's document, and vice versa. Also doubles as this ticket's
  // real cross-user isolation proof: a caller can never receive, and can
  // never spend quota generating notes for, a document id that isn't theirs
  // — it 404s exactly like a nonexistent id.
  const [doc] = await withUserContext(userId, (tx) =>
    tx.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
  )
  if (!doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }
  if (!doc.rawText?.trim()) {
    // No quota claimed for this — a document with nothing to generate notes
    // from should never cost the caller part of their daily allowance, same
    // "don't claim budget before the request is known-valid" ordering
    // lib/uploadLimits.ts established for MEM-004.
    return NextResponse.json({ error: 'This document has no text to generate notes from' }, { status: 422 })
  }

  const budget = await claimNotesBudget(userId, plan)
  if (!budget.ok) {
    logger.warn({ userId, plan, documentId }, 'Notes generation budget limited')
    return NextResponse.json({ error: budget.reason }, { status: budget.status })
  }

  const result = await generateNotesFromText(doc.rawText)
  if (!result.success) {
    logger.warn({ userId, documentId, reason: result.reason }, 'Notes generation failed')
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: REASON_STATUS[result.reason] })
  }

  const [note] = await withUserContext(userId, (tx) =>
    tx
      .insert(notes)
      .values({ documentId, userId, content: JSON.stringify(result.data) })
      .returning()
  )

  logger.info({ userId, documentId, noteId: note.id }, 'AI notes generated')
  return NextResponse.json({ note: { ...note, content: result.data } }, { status: 201 })
}

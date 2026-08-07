// MEM-008: read-side data for the document library (app/dashboard/page.tsx)
// and per-document workspace (app/dashboard/documents/[id]/page.tsx).
// ARCHITECTURE.md's MEM-004 entry explicitly left "no GET/listing endpoint —
// reading a user's own documents belongs to whatever ticket builds the
// dashboard/library UI" as this ticket's job.
//
// Both server components below call these functions directly (no fetch to
// a same-origin API route) — matches app/dashboard/stats/page.tsx's own
// existing pattern (calling lib/stats.ts's getWeeklyStats() directly from a
// Server Component), not a new convention. Every query runs through
// withUserContext(userId, ...), same as every other read in this codebase —
// outside it, the RLS-scoped runtime role sees zero rows (lib/db/index.ts).
//
// notes -> flashcards / notes -> quizzes are both one-to-many, and a caller
// can generate more than once per parent (MEM-005/006/007 all deliberately
// have no "regenerate" special case — each POST creates a fresh row). The
// UI's model or "the active state of a document" is therefore: its most
// recently created notes row, that note's full set of flashcards, and its
// most recently created quiz. This mirrors how a real user would move
// through the product (generate once per stage, then act on the latest
// result) without hiding older rows from the database.
import { and, desc, eq, inArray } from 'drizzle-orm'
import { withUserContext } from '@/lib/db'
import { documents, notes, flashcards, quizzes, quizAttempts } from '@/lib/db/schema'
import { storedQuestionsSchema, type StoredQuestion } from '@/lib/quizAttempts'

export type DocumentStatus = {
  id: string
  title: string
  sourceType: string
  createdAt: Date
  hasNotes: boolean
  hasFlashcards: boolean
  hasQuiz: boolean
}

/** All of a user's documents, newest first, with coarse status flags for the library view. */
export async function getDocumentsWithStatus(userId: string): Promise<DocumentStatus[]> {
  return withUserContext(userId, async (tx) => {
    const docs = await tx
      .select()
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.createdAt))

    if (docs.length === 0) return []

    const docIds = docs.map((d) => d.id)
    const noteRows = await tx
      .select({ id: notes.id, documentId: notes.documentId })
      .from(notes)
      .where(inArray(notes.documentId, docIds))

    const noteIdsByDoc = new Map<string, string[]>()
    for (const n of noteRows) {
      const list = noteIdsByDoc.get(n.documentId) ?? []
      list.push(n.id)
      noteIdsByDoc.set(n.documentId, list)
    }
    const allNoteIds = noteRows.map((n) => n.id)

    const [flashcardNoteIds, quizNoteIds] = allNoteIds.length
      ? await Promise.all([
          tx.select({ noteId: flashcards.noteId }).from(flashcards).where(inArray(flashcards.noteId, allNoteIds)),
          tx.select({ noteId: quizzes.noteId }).from(quizzes).where(inArray(quizzes.noteId, allNoteIds)),
        ])
      : [[], []]
    const noteIdsWithFlashcards = new Set(flashcardNoteIds.map((r) => r.noteId))
    const noteIdsWithQuiz = new Set(quizNoteIds.map((r) => r.noteId))

    return docs.map((doc) => {
      const noteIds = noteIdsByDoc.get(doc.id) ?? []
      return {
        id: doc.id,
        title: doc.title,
        sourceType: doc.sourceType,
        createdAt: doc.createdAt,
        hasNotes: noteIds.length > 0,
        hasFlashcards: noteIds.some((id) => noteIdsWithFlashcards.has(id)),
        hasQuiz: noteIds.some((id) => noteIdsWithQuiz.has(id)),
      }
    })
  })
}

export type FlashcardRow = { id: string; front: string; back: string }
export type QuizSummary = { id: string; questionCount: number; createdAt: Date; lastAttemptScore: number | null }

export type DocumentDetail = {
  document: { id: string; title: string; sourceType: string; rawText: string | null; createdAt: Date }
  latestNote: { id: string; content: string; createdAt: Date } | null
  flashcards: FlashcardRow[]
  quizzes: QuizSummary[]
}

/**
 * Everything app/dashboard/documents/[id]/page.tsx needs for its initial
 * render: the document itself, its latest notes row (if any), that note's
 * flashcards, and every quiz generated for it (newest first), each
 * annotated with the caller's own most recent attempt score if they've
 * taken it. Returns null if the document doesn't exist or isn't owned by
 * this user — RLS plus the explicit userId filter below both collapse
 * "doesn't exist" and "not mine" to the same result, matching every other
 * route/page in this codebase's cross-user-isolation convention.
 */
export async function getDocumentDetail(userId: string, documentId: string): Promise<DocumentDetail | null> {
  return withUserContext(userId, async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
    if (!doc) return null

    const docNotes = await tx
      .select({ id: notes.id, content: notes.content, createdAt: notes.createdAt })
      .from(notes)
      .where(and(eq(notes.documentId, documentId), eq(notes.userId, userId)))
      .orderBy(desc(notes.createdAt))
    const latestNote = docNotes[0] ?? null

    let cards: FlashcardRow[] = []
    let quizList: QuizSummary[] = []
    if (latestNote) {
      cards = await tx
        .select({ id: flashcards.id, front: flashcards.front, back: flashcards.back })
        .from(flashcards)
        .where(and(eq(flashcards.noteId, latestNote.id), eq(flashcards.userId, userId)))

      const quizRows = await tx
        .select({ id: quizzes.id, questions: quizzes.questions, createdAt: quizzes.createdAt })
        .from(quizzes)
        .where(and(eq(quizzes.noteId, latestNote.id), eq(quizzes.userId, userId)))
        .orderBy(desc(quizzes.createdAt))

      const quizIds = quizRows.map((q) => q.id)
      const attempts = quizIds.length
        ? await tx
            .select({ quizId: quizAttempts.quizId, score: quizAttempts.score, createdAt: quizAttempts.createdAt })
            .from(quizAttempts)
            .where(and(inArray(quizAttempts.quizId, quizIds), eq(quizAttempts.userId, userId)))
            .orderBy(desc(quizAttempts.createdAt))
        : []
      const latestScoreByQuiz = new Map<string, number>()
      for (const a of attempts) {
        if (!latestScoreByQuiz.has(a.quizId)) latestScoreByQuiz.set(a.quizId, a.score)
      }

      quizList = quizRows.map((q) => ({
        id: q.id,
        // questions is jsonb/untyped in the schema (see lib/db/schema.ts's
        // comment on quizzes.questions) — this is a display-only count, not
        // something scored or trusted, so a defensive Array.isArray guard is
        // enough here rather than a full zod parse.
        questionCount: Array.isArray(q.questions) ? q.questions.length : 0,
        createdAt: q.createdAt,
        lastAttemptScore: latestScoreByQuiz.get(q.id) ?? null,
      }))
    }

    return {
      document: { id: doc.id, title: doc.title, sourceType: doc.sourceType, rawText: doc.rawText, createdAt: doc.createdAt },
      latestNote,
      flashcards: cards,
      quizzes: quizList,
    }
  })
}

export type QuizForTaking = { id: string; documentId: string; questions: StoredQuestion[] }

/**
 * Fetches a single quiz for the quiz-taking page
 * (app/dashboard/documents/[id]/quiz/[quizId]/page.tsx), scoped to the
 * caller and with its `questions` already validated into the shape
 * components/quiz-runner.tsx expects. Returns null for a nonexistent quiz,
 * another user's quiz (both filtered by the explicit userId check alongside
 * quizzes_own_rows RLS, same cross-user-isolation convention as every other
 * read/route in this codebase), or a quiz whose stored questions don't
 * match the expected shape (should be unreachable for anything MEM-007's
 * generator produced, but this page fails to a 404 rather than crashing on
 * malformed data either way).
 */
export async function getQuizForTaking(userId: string, quizId: string): Promise<QuizForTaking | null> {
  return withUserContext(userId, async (tx) => {
    const [quiz] = await tx.select().from(quizzes).where(and(eq(quizzes.id, quizId), eq(quizzes.userId, userId)))
    if (!quiz) return null

    const parsedQuestions = storedQuestionsSchema.safeParse(quiz.questions)
    if (!parsedQuestions.success) return null

    const [note] = await tx
      .select({ documentId: notes.documentId })
      .from(notes)
      .where(and(eq(notes.id, quiz.noteId), eq(notes.userId, userId)))
    if (!note) return null

    return { id: quiz.id, documentId: note.documentId, questions: parsedQuestions.data }
  })
}

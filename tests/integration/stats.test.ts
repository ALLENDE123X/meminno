import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { withUserContext } from '@/lib/db'
import { users, documents, notes, flashcards, quizzes, quizAttempts } from '@/lib/db/schema'
import { getWeeklyStats } from '@/lib/stats'

// Proves getWeeklyStats() computes real numbers from the real schema through
// the app's actual RLS-scoped connection (withUserContext(), same as
// tests/integration/rls.test.ts) - not a mock. Safe under CLAUDE.md HARD
// STOP 5: it only ever touches the one random UUID it creates, and RLS
// makes it structurally incapable of reading/writing anyone else's rows.
const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('getWeeklyStats against the real schema', () => {
  const userId = randomUUID()

  afterAll(async () => {
    // Cascades to documents/notes/flashcards/quizzes/quiz_attempts via the
    // ON DELETE CASCADE FKs in lib/db/schema.ts.
    await withUserContext(userId, (tx) => tx.delete(users).where(eq(users.id, userId))).catch(() => {})
  })

  it('is honestly empty for a user with zero rows', async () => {
    const stats = await getWeeklyStats(userId)
    expect(stats.isEmpty).toBe(true)
    expect(stats.everActive).toBe(false)
    expect(stats.documentsAdded).toBe(0)
    expect(stats.flashcardsGenerated).toBe(0)
    expect(stats.quizQuestionsGenerated).toBe(0)
    expect(stats.quizzesTaken).toBe(0)
    expect(stats.averageScore).toBeNull()
    expect(stats.streakDays).toBe(0)
  })

  it('computes real numbers from freshly-seeded rows', async () => {
    await withUserContext(userId, async (tx) => {
      await tx.insert(users).values({ id: userId, email: `stats-test-${userId}@example.com` })

      const [doc] = await tx
        .insert(documents)
        .values({ userId, title: 'Seeded doc', sourceType: 'text', rawText: 'hello world' })
        .returning({ id: documents.id })

      const [note] = await tx
        .insert(notes)
        .values({ documentId: doc.id, userId, content: 'Seeded note content' })
        .returning({ id: notes.id })

      await tx.insert(flashcards).values([
        { noteId: note.id, userId, front: 'Q1', back: 'A1' },
        { noteId: note.id, userId, front: 'Q2', back: 'A2' },
      ])

      const [quiz] = await tx
        .insert(quizzes)
        .values({ noteId: note.id, userId, questions: [{ q: '1' }, { q: '2' }, { q: '3' }] })
        .returning({ id: quizzes.id })

      await tx.insert(quizAttempts).values({ quizId: quiz.id, userId, score: 80, answers: [] })
    })

    const stats = await getWeeklyStats(userId)
    expect(stats.isEmpty).toBe(false)
    expect(stats.everActive).toBe(true)
    expect(stats.documentsAdded).toBe(1)
    expect(stats.flashcardsGenerated).toBe(2)
    expect(stats.quizQuestionsGenerated).toBe(3)
    expect(stats.quizzesTaken).toBe(1)
    expect(stats.averageScore).toBe(80)
    expect(stats.streakDays).toBe(1)
  })
})

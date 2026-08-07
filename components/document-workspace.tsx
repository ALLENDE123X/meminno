'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Flashcard } from '@/components/flashcard'
import { parseNotesContent } from '@/lib/notesFormat'

type NoteState = { id: string; content: string } | null
type FlashcardRow = { id: string; front: string; back: string }
type QuizSummary = { id: string; questionCount: number; createdAt: string; lastAttemptScore: number | null }
type Stage = 'idle' | 'loading' | 'error'

// MEM-008: the core loop this ticket exists to build a UI for — trigger
// notes generation, see the notes, trigger flashcards, see a real
// flip/reveal deck, trigger a quiz, and get a link into the actual
// quiz-taking screen (components/quiz-runner.tsx via
// app/dashboard/documents/[id]/quiz/[quizId]/page.tsx). One client
// component per document rather than three, since the three stages are
// gated on each other (no flashcards button until notes exist, etc.) and
// share one visual rhythm; the server page around this
// (app/dashboard/documents/[id]/page.tsx) only does the initial data fetch.
//
// Regenerating notes (MEM-005/006/007 all deliberately have no "regenerate"
// special case — every POST creates a fresh row) intentionally clears the
// locally-held flashcards/quizzes: a fresh notes row genuinely has neither
// yet, and continuing to show the previous note's flashcards/quiz next to
// brand-new notes would be actively misleading about what those cards were
// generated from.
export function DocumentWorkspace({
  documentId,
  initialNote,
  initialFlashcards,
  initialQuizzes,
}: {
  documentId: string
  initialNote: NoteState
  initialFlashcards: FlashcardRow[]
  initialQuizzes: QuizSummary[]
}) {
  const [note, setNote] = useState<NoteState>(initialNote)
  const [flashcards, setFlashcards] = useState<FlashcardRow[]>(initialFlashcards)
  const [quizzes, setQuizzes] = useState<QuizSummary[]>(initialQuizzes)

  const [notesStage, setNotesStage] = useState<Stage>('idle')
  const [notesError, setNotesError] = useState<string | null>(null)
  const [flashcardsStage, setFlashcardsStage] = useState<Stage>('idle')
  const [flashcardsError, setFlashcardsError] = useState<string | null>(null)
  const [quizStage, setQuizStage] = useState<Stage>('idle')
  const [quizError, setQuizError] = useState<string | null>(null)

  async function generateNotes() {
    setNotesStage('loading')
    setNotesError(null)
    try {
      const res = await fetch(`/api/documents/${documentId}/notes`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setNotesStage('error')
        setNotesError(body.error ?? `Something went wrong (${res.status}).`)
        return
      }
      // POST /api/documents/[id]/notes returns the *parsed* notes object
      // (not the JSON.stringify'd column value) — re-stringify so `note`
      // stays one consistent shape regardless of whether it came from the
      // initial server-side DB read or a fresh generation.
      setNote({ id: body.note.id, content: JSON.stringify(body.note.content) })
      setFlashcards([])
      setQuizzes([])
      setNotesStage('idle')
    } catch {
      setNotesStage('error')
      setNotesError('Network error, please try again.')
    }
  }

  async function generateFlashcards() {
    if (!note) return
    setFlashcardsStage('loading')
    setFlashcardsError(null)
    try {
      const res = await fetch(`/api/notes/${note.id}/flashcards`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setFlashcardsStage('error')
        setFlashcardsError(body.error ?? `Something went wrong (${res.status}).`)
        return
      }
      // Flashcards accumulate per note (MEM-006: every POST inserts a fresh
      // batch alongside any earlier ones for the same note), so append
      // rather than replace.
      setFlashcards((prev) => [...prev, ...body.flashcards])
      setFlashcardsStage('idle')
    } catch {
      setFlashcardsStage('error')
      setFlashcardsError('Network error, please try again.')
    }
  }

  async function generateQuiz() {
    if (!note) return
    setQuizStage('loading')
    setQuizError(null)
    try {
      const res = await fetch(`/api/notes/${note.id}/quiz`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setQuizStage('error')
        setQuizError(body.error ?? `Something went wrong (${res.status}).`)
        return
      }
      const questionCount = Array.isArray(body.quiz?.questions) ? body.quiz.questions.length : 0
      setQuizzes((prev) => [
        { id: body.quiz.id, questionCount, createdAt: body.quiz.createdAt, lastAttemptScore: null },
        ...prev,
      ])
      setQuizStage('idle')
    } catch {
      setQuizStage('error')
      setQuizError('Network error, please try again.')
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Notes</h2>
          <Button
            type="button"
            variant={note ? 'outline' : 'default'}
            size="sm"
            onClick={generateNotes}
            disabled={notesStage === 'loading'}
          >
            {notesStage === 'loading' ? 'Generating…' : note ? 'Regenerate notes' : 'Generate notes'}
          </Button>
        </div>
        {notesError ? <ErrorNote message={notesError} /> : null}
        {note ? <NotesView content={note.content} /> : notesStage !== 'loading' ? (
          <EmptyStage text="No notes yet. Generate study notes from this document's text." />
        ) : null}
      </section>

      {note ? (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Flashcards{flashcards.length > 0 ? ` (${flashcards.length})` : ''}</h2>
            <Button
              type="button"
              variant={flashcards.length > 0 ? 'outline' : 'default'}
              size="sm"
              onClick={generateFlashcards}
              disabled={flashcardsStage === 'loading'}
            >
              {flashcardsStage === 'loading' ? 'Generating…' : flashcards.length > 0 ? 'Generate more' : 'Generate flashcards'}
            </Button>
          </div>
          {flashcardsError ? <ErrorNote message={flashcardsError} /> : null}
          {flashcards.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {flashcards.map((card) => (
                <Flashcard key={card.id} front={card.front} back={card.back} />
              ))}
            </div>
          ) : flashcardsStage !== 'loading' ? (
            <EmptyStage text="No flashcards yet. Generate a deck from your notes." />
          ) : null}
        </section>
      ) : null}

      {note ? (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Quizzes</h2>
            <Button
              type="button"
              variant={quizzes.length > 0 ? 'outline' : 'default'}
              size="sm"
              onClick={generateQuiz}
              disabled={quizStage === 'loading'}
            >
              {quizStage === 'loading' ? 'Generating…' : quizzes.length > 0 ? 'Generate another quiz' : 'Generate quiz'}
            </Button>
          </div>
          {quizError ? <ErrorNote message={quizError} /> : null}
          {quizzes.length > 0 ? (
            <div className="flex flex-col gap-2">
              {quizzes.map((quiz) => (
                <Card key={quiz.id}>
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium text-card-foreground">{quiz.questionCount} questions</p>
                      <p className="text-sm text-muted-foreground">
                        {quiz.lastAttemptScore !== null ? `Last score: ${quiz.lastAttemptScore}%` : 'Not taken yet'}
                      </p>
                    </div>
                    <Link href={`/dashboard/documents/${documentId}/quiz/${quiz.id}`} className={buttonVariants({ size: 'sm' })}>
                      Take quiz
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : quizStage !== 'loading' ? (
            <EmptyStage text="No quiz yet. Generate one from your notes and flashcards." />
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function NotesView({ content }: { content: string }) {
  const parsed = parseNotesContent(content)
  if (!parsed) {
    return (
      <Card>
        <CardContent className="whitespace-pre-wrap p-5 text-sm text-card-foreground">{content}</CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{parsed.title}</CardTitle>
        <CardDescription>{parsed.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {parsed.sections.map((section, i) => (
          <div key={i}>
            {section.heading ? <h3 className="mb-2 font-medium text-card-foreground">{section.heading}</h3> : null}
            <ul className="list-disc space-y-1 pl-5 text-sm text-card-foreground">
              {section.bullets.map((bullet, j) => (
                <li key={j}>{bullet}</li>
              ))}
            </ul>
          </div>
        ))}
        {parsed.keyConcepts.length > 0 ? (
          <div>
            <h3 className="mb-2 font-medium text-card-foreground">Key concepts</h3>
            <dl className="flex flex-col gap-2 text-sm">
              {parsed.keyConcepts.map((concept, i) => (
                <div key={i}>
                  <dt className="font-medium text-card-foreground">{concept.term}</dt>
                  <dd className="text-muted-foreground">{concept.definition}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{message}</p>
}

function EmptyStage({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">{text}</p>
}

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getSessionUser } from '@/lib/session'
import { getQuizForTaking } from '@/lib/documents'
import { buttonVariants } from '@/components/ui/button'
import { QuizRunner } from '@/components/quiz-runner'

export const metadata: Metadata = {
  title: 'Take quiz | Meminno',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// MEM-008: the actual quiz-taking screen — "the part no prior ticket
// built" per this ticket's brief. `params.id` (the document id) is only
// used for the "back to document" link; ownership/validity is entirely
// determined by `quizId`, scoped to the caller via
// lib/documents.ts's getQuizForTaking.
export default async function TakeQuizPage({ params }: { params: Promise<{ id: string; quizId: string }> }) {
  const { id: documentId, quizId } = await params
  if (!UUID_RE.test(documentId) || !UUID_RE.test(quizId)) notFound()

  const session = await getSessionUser()
  if (!session.ok) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">Sign in to take this quiz</h1>
        <Link href="/sign-in" className={buttonVariants()}>
          Sign in
        </Link>
      </main>
    )
  }

  const quiz = await getQuizForTaking(session.userId, quizId)
  if (!quiz || quiz.documentId !== documentId) notFound()

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <Link href={`/dashboard/documents/${documentId}`} className="text-sm text-muted-foreground hover:text-foreground">
        &larr; Back to document
      </Link>
      <QuizRunner quizId={quiz.id} questions={quiz.questions} documentId={documentId} />
    </main>
  )
}

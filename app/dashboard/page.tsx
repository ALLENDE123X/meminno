import Link from 'next/link'
import type { Metadata } from 'next'
import { getSessionUser } from '@/lib/session'
import { getDocumentsWithStatus } from '@/lib/documents'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

export const metadata: Metadata = {
  title: 'Your library | Meminno',
  description: 'Every document you\'ve uploaded to Meminno, and where it is in the notes → flashcards → quiz pipeline.',
}

// MEM-008: the document library — the "signed-in user's home base" this
// ticket's brief asks for, and the real landing page after sign-in
// (app/auth/callback/route.ts now redirects here). Lists every document a
// user has uploaded with a coarse status per stage (notes? flashcards?
// quiz?) and a link into that document's own workspace
// (app/dashboard/documents/[id]/page.tsx), which is where the actual
// generate/view flow for each stage lives.
export default async function DashboardPage() {
  const session = await getSessionUser()

  if (!session.ok) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">Sign in to see your library</h1>
        <p className="max-w-md text-muted-foreground">
          Upload a PDF or paste your notes, and Meminno turns it into study notes, flashcards, and a quiz.
        </p>
        <Link href="/sign-in" className={buttonVariants()}>
          Sign in
        </Link>
      </main>
    )
  }

  const documents = await getDocumentsWithStatus(session.userId)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Your library</h1>
          <p className="text-muted-foreground">Every document you&apos;ve uploaded, and how far it&apos;s come.</p>
        </div>
        <Link href="/upload" className={buttonVariants()}>
          Upload
        </Link>
      </div>

      {documents.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <CardTitle>Nothing here yet</CardTitle>
            <CardDescription>
              Upload your first PDF or paste some notes, and Meminno will start turning it into study material.
            </CardDescription>
            <Link href="/upload" className={buttonVariants({ className: 'mt-2' })}>
              Upload your first document
            </Link>
          </CardHeader>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {documents.map((doc) => (
            <li key={doc.id}>
              <Link
                href={`/dashboard/documents/${doc.id}`}
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 transition-colors hover:border-accent sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium text-card-foreground">{doc.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {doc.sourceType === 'pdf' ? 'PDF' : 'Pasted text'} · {formatDate(doc.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StageBadge label="Notes" done={doc.hasNotes} />
                  <StageBadge label="Flashcards" done={doc.hasFlashcards} />
                  <StageBadge label="Quiz" done={doc.hasQuiz} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

function StageBadge({ label, done }: { label: string; done: boolean }) {
  return (
    <span
      className={
        done
          ? 'rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent'
          : 'rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground'
      }
    >
      {done ? `${label} ✓` : label}
    </span>
  )
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

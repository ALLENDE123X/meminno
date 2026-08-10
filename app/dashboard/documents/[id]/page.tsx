import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getSessionUser } from '@/lib/session'
import { getDocumentDetail } from '@/lib/documents'
import { buttonVariants } from '@/components/ui/button'
import { DocumentWorkspace } from '@/components/document-workspace'

export const metadata: Metadata = {
  title: 'Document | Meminno',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// MEM-008: the per-document workspace — "after uploading, a user should be
// able to see their document, trigger notes generation, then see the
// generated notes, then trigger flashcards generation..." (this ticket's
// brief). The actual generate/view interaction lives in the client
// component below (components/document-workspace.tsx); this page's only
// job is the session check and the initial server-side data fetch
// (lib/documents.ts's getDocumentDetail — same "call the DB helper directly
// from a Server Component" pattern app/dashboard/stats/page.tsx already
// established for lib/stats.ts).
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()

  const session = await getSessionUser()
  if (!session.ok) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">Sign in to view this document</h1>
        <Link href="/sign-in" className={buttonVariants()}>
          Sign in
        </Link>
      </main>
    )
  }

  const detail = await getDocumentDetail(session.userId, id)
  // A nonexistent id and another user's id are indistinguishable by design
  // (getDocumentDetail's own comment) — both render the same 404, matching
  // every API route in this codebase's cross-user-isolation convention.
  if (!detail) notFound()

  const { document, latestNote, flashcards, quizzes } = detail

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          &larr; Library
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{document.title}</h1>
        <p className="text-muted-foreground">
          {document.sourceType === 'pdf' ? 'PDF' : document.sourceType === 'recording' ? 'Recorded lecture' : 'Pasted text'} ·{' '}
          {new Date(document.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      </div>

      <DocumentWorkspace
        documentId={document.id}
        initialNote={latestNote ? { id: latestNote.id, content: latestNote.content } : null}
        initialFlashcards={flashcards}
        initialQuizzes={quizzes.map((q) => ({ ...q, createdAt: q.createdAt.toISOString() }))}
      />
    </main>
  )
}

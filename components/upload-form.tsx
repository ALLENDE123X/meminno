'use client'

// MEM-004's upload form, restyled to the app's dark/coral theme (MEM-008)
// and given a real next step: on success it now links straight into the new
// per-document workspace (app/dashboard/documents/[id]/page.tsx) instead of
// just reporting a character count with nowhere to go — "after uploading, a
// user should be able to see their document, trigger notes generation..."
// per this ticket's brief. Split out of app/upload/page.tsx (which is now a
// thin Server Component wrapper rendering SiteHeader + this) because
// SiteHeader needs to be an async Server Component (it does a real session
// check) and can't be imported into a 'use client' file directly.
import { useState } from 'react'
import Link from 'next/link'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

type Mode = 'pdf' | 'text'
type Status = 'idle' | 'submitting' | 'success' | 'error'

export function UploadForm() {
  const [mode, setMode] = useState<Mode>('pdf')
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [documentId, setDocumentId] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('submitting')
    setMessage(null)
    setDocumentId(null)

    const formData = new FormData()
    if (title.trim()) formData.set('title', title.trim())
    if (mode === 'pdf' && file) {
      formData.set('file', file)
    } else if (mode === 'text' && text.trim()) {
      formData.set('text', text)
    } else {
      setStatus('error')
      setMessage(mode === 'pdf' ? 'Choose a PDF file first.' : 'Paste some text first.')
      return
    }

    try {
      const res = await fetch('/api/documents', { method: 'POST', body: formData })
      const body = await res.json()
      if (!res.ok) {
        setStatus('error')
        setMessage(body.error ?? `Upload failed (${res.status})`)
        return
      }
      setStatus('success')
      setMessage(`Saved "${body.document.title}" — ${body.document.rawText.length.toLocaleString()} characters.`)
      setDocumentId(body.document.id)
      setFile(null)
      setText('')
      setTitle('')
    } catch {
      setStatus('error')
      setMessage('Network error — please try again.')
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col justify-center px-6 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Upload your coursework</CardTitle>
          <CardDescription>PDF or pasted text — Meminno reads it and stores it as a document.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Button type="button" variant={mode === 'pdf' ? 'default' : 'outline'} size="sm" onClick={() => setMode('pdf')}>
              PDF
            </Button>
            <Button type="button" variant={mode === 'text' ? 'default' : 'outline'} size="sm" onClick={() => setMode('text')}>
              Paste text
            </Button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <input
              type="text"
              placeholder="Title (optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />

            {mode === 'pdf' ? (
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:text-foreground"
              />
            ) : (
              <textarea
                placeholder="Paste your notes here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}

            <Button type="submit" disabled={status === 'submitting'}>
              {status === 'submitting' ? 'Uploading…' : 'Upload'}
            </Button>
          </form>

          {message ? (
            <p className={`mt-4 text-sm ${status === 'error' ? 'text-destructive' : 'text-accent'}`}>{message}</p>
          ) : null}

          {status === 'success' && documentId ? (
            <Link href={`/dashboard/documents/${documentId}`} className={buttonVariants({ variant: 'outline', className: 'mt-4 w-full' })}>
              View document &rarr;
            </Link>
          ) : null}
        </CardContent>
      </Card>
    </main>
  )
}

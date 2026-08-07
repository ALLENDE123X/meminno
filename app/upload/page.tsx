'use client'

// Minimal upload UI for MEM-004 — deliberately small: there's no dashboard
// shell yet (a separate, unstarted ticket), so this page only has to prove
// the real POST /api/documents route end to end for a signed-in browser
// session. It relies on a Supabase Auth session cookie already existing —
// set by MEM-003's /sign-in flow, which now ships; with no session yet,
// submitting surfaces the same 401 the route itself returns, which is the
// correct behavior to inherit, not something to special-case here. A future
// dashboard/library UI (listing documents, richer errors, upload progress)
// belongs to a later ticket, not this one.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

type Mode = 'pdf' | 'text'

export default function UploadPage() {
  const [mode, setMode] = useState<Mode>('pdf')
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('submitting')
    setMessage(null)

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
      setFile(null)
      setText('')
      setTitle('')
    } catch {
      setStatus('error')
      setMessage('Network error — please try again.')
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6 py-16">
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
              className="rounded-md border border-gray-200 px-3 py-2 text-sm"
            />

            {mode === 'pdf' ? (
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm"
              />
            ) : (
              <textarea
                placeholder="Paste your notes here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                className="rounded-md border border-gray-200 px-3 py-2 text-sm"
              />
            )}

            <Button type="submit" disabled={status === 'submitting'}>
              {status === 'submitting' ? 'Uploading…' : 'Upload'}
            </Button>
          </form>

          {message ? (
            <p className={`mt-4 text-sm ${status === 'error' ? 'text-red-600' : 'text-green-700'}`}>{message}</p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  )
}

'use client'

import * as React from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'

type Status = 'idle' | 'loading' | 'sent' | 'error'

// Magic link (passwordless email OTP), not email/password: no password
// field means no "forgot password"/reset flow, no confirmation-email step
// separate from the sign-in step itself (clicking the link IS the
// confirmation), and no password storage/breach surface at all - the
// lowest-friction option for a college-student audience signing up on
// their phone between classes. Matches Propinno's own passwordless
// instinct (phone OTP there) adapted to email, per this ticket's brief:
// email/password or magic link, not phone/SMS OTP (Propinno's pattern, not
// this app's).
export default function SignInPage() {
  const [email, setEmail] = React.useState('')
  const [status, setStatus] = React.useState<Status>('idle')
  const [message, setMessage] = React.useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('loading')
    setMessage(null)

    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // app/auth/callback/route.ts exchanges the code this lands on the
        // link with for a real session. window.location.origin (not a
        // hardcoded domain) so this works identically on localhost, a
        // Vercel preview URL, and production.
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (error) {
      setStatus('error')
      setMessage(error.message || 'Something went wrong — try again.')
      return
    }

    setStatus('sent')
  }

  return (
    // MEM-008: dark/sky-blue theme now applies by default (app/globals.css)
    // — this page no longer needs to force its own light colors.
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <Link href="/" className="mb-8 text-lg font-semibold tracking-tight text-accent">
        Meminno
      </Link>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            {status === 'sent'
              ? `We sent a sign-in link to ${email}. Check your inbox (and spam folder).`
              : "No password needed — we'll email you a one-click sign-in link."}
          </CardDescription>
        </CardHeader>
        {status !== 'sent' && (
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@college.edu"
                aria-label="Email address"
                disabled={status === 'loading'}
                className="h-11 w-full rounded-md border border-border bg-muted px-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <Button type="submit" size="lg" disabled={status === 'loading'}>
                {status === 'loading' ? 'Sending…' : 'Send magic link'}
              </Button>
              {status === 'error' && message ? <p className="text-sm text-destructive">{message}</p> : null}
            </form>
          </CardContent>
        )}
      </Card>
    </main>
  )
}

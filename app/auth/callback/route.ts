import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/session'
import { logger } from '@/lib/logger'

// Where a magic-link email's `emailRedirectTo` points (app/sign-in/page.tsx
// sets it to `${origin}/auth/callback`). Supabase Auth's PKCE flow (the
// default for @supabase/ssr clients) sends the user here with a `?code=...`
// query param; exchangeCodeForSession() below trades it for a real session,
// using the PKCE code verifier that signInWithOtp() stored in a cookie on
// the browser that originally requested the link. That verifier cookie is
// why this only works in the same browser that asked for the link - it is
// not just a magic URL, and isn't meant to be.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // MEM-008: default landing spot after a real sign-in is now the document
  // library (app/dashboard/page.tsx), not the marketing page at "/" — a
  // signed-in visitor has no reason to land back on the pre-signup landing
  // page. `next` is still respected when explicitly passed.
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // Resolves the now-set session cookie and, as a side effect,
      // ensures the matching public.users row exists (see
      // lib/session.ts) - so whatever page `next` sends the user to can
      // immediately query their own data instead of racing a
      // not-yet-created row.
      const session = await getSessionUser()
      if (session.ok) {
        return NextResponse.redirect(`${origin}${next}`)
      }
      logger.error({ status: session.status }, 'Session established but getSessionUser() still failed')
    } else {
      logger.warn({ error: error.message }, 'Magic link code exchange failed')
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth`)
}

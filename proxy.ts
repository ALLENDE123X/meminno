import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Refreshes the Supabase Auth session cookie on every request.
//
// Server Components can read cookies but cannot write them (Next.js
// restriction), so if a request's access token expires mid-session and
// nothing else refreshes it, every Server Component render is stuck seeing
// a stale/expired session until the browser happens to hit something that
// can set cookies. This proxy (Next.js 16's renamed `middleware.ts`
// convention - see https://nextjs.org/docs/messages/middleware-to-proxy)
// runs before every matched request and can both read and write cookies,
// so it's the one place in the App Router where "call getUser(), let the
// SDK refresh the token if needed, persist the new cookies" can reliably
// happen. This is Supabase's own documented pattern for @supabase/ssr +
// Next.js middleware/proxy - see
// https://supabase.com/docs/guides/auth/server-side/nextjs.
//
// lib/supabase/server.ts's createClient() (used by route handlers/Server
// Components) does its own getAll/setAll cookie plumbing too, but its
// setAll is wrapped in a try/catch that silently no-ops when called from a
// context that can't set cookies (a Server Component) - the comment there
// says as much: "This can be ignored if you have middleware refreshing user
// sessions." This file is that proxy.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Write to both the outgoing request (so anything later in this
          // same middleware chain sees the refreshed cookie) and a fresh
          // response built from that request (so the browser actually
          // receives it).
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    }
  )

  // The call itself (not its return value) is the point: it validates the
  // current access token against Supabase Auth and, via the cookies
  // plumbing above, persists a refreshed token/cookie pair when the old one
  // is close to expiring. Route handlers and Server Components still call
  // their own getUser()/getSessionUser() for the actual auth decision -
  // this is purely a keep-alive.
  await supabase.auth.getUser()

  return response
}

export const config = {
  matcher: [
    // Every route except static assets and Next's own internals - an auth
    // cookie can legitimately need refreshing on API routes and pages
    // alike. Excluding common static file extensions avoids running a
    // Supabase Auth network call for every image/font/etc request.
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}

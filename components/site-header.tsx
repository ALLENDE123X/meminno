import Link from 'next/link'
import { getSessionUser } from '@/lib/session'
import { SignOutButton } from '@/components/sign-out-button'

// MEM-008: the nav shell that actually connects the loop this ticket exists
// to build — sign-in -> library -> upload -> per-document flow -> stats.
// A Server Component (not a client one) because it needs a real session
// check (getSessionUser(), the same session-gate helper every protected
// page/route in this app already uses) to decide what to show; nothing here
// needs interactivity except the sign-out button, which is its own small
// client component below.
//
// Used by app/dashboard/layout.tsx (wraps every /dashboard/* route) and
// directly by app/upload/page.tsx, which sits outside the /dashboard route
// tree but is very much part of the same logged-in flow.
export async function SiteHeader() {
  const session = await getSessionUser()

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
        <Link href={session.ok ? '/dashboard' : '/'} className="text-lg font-semibold tracking-tight text-accent">
          Meminno
        </Link>
        {session.ok ? (
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/dashboard" className="rounded-md px-3 py-2 text-foreground hover:bg-muted">
              Library
            </Link>
            <Link href="/upload" className="rounded-md px-3 py-2 text-foreground hover:bg-muted">
              Upload
            </Link>
            <Link href="/dashboard/stats" className="rounded-md px-3 py-2 text-foreground hover:bg-muted">
              Stats
            </Link>
            <Link href="/billing" className="rounded-md px-3 py-2 text-foreground hover:bg-muted">
              Billing
            </Link>
            <SignOutButton />
          </nav>
        ) : (
          <Link href="/sign-in" className="rounded-md px-3 py-2 text-sm text-foreground hover:bg-muted">
            Sign in
          </Link>
        )}
      </div>
    </header>
  )
}

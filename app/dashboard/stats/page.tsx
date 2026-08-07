import Link from 'next/link'
import type { Metadata } from 'next'
import { getSessionUser } from '@/lib/session'
import { getWeeklyStats, buildStatCardImageUrl, buildStatCardShareUrl } from '@/lib/stats'
import { StatCard } from '@/components/stat-card'
import { CopyShareLinkButton } from '@/components/copy-share-link-button'
import { buttonVariants } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'Your weekly stats — Meminno',
  description: 'A shareable weekly recap of your Meminno study activity.',
}

// MEM-009, now reached via the real dashboard nav (MEM-008's
// app/dashboard/layout.tsx wraps this route with SiteHeader) instead of
// only by direct URL.
//
// Session check goes through lib/session.ts's getSessionUser() (MEM-003's
// session-gate helper, merged after this ticket's first draft — reconciled
// to use it instead of this page's original hand-rolled
// createClient()/auth.getUser() call), for the same convention every other
// protected route in this app now follows (see app/api/me/route.ts). A
// signed-in user with a real public.users row but zero documents/quizzes
// still gets getWeeklyStats()'s real, honest empty state, never a
// fabricated placeholder card.
export default async function WeeklyStatsPage() {
  const session = await getSessionUser()

  if (!session.ok) {
    return (
      <main className="flex flex-col items-center justify-center gap-4 px-8 py-24 text-center">
        <h1 className="text-2xl font-semibold">Sign in to see your weekly stat card</h1>
        <p className="max-w-md text-muted-foreground">
          Meminno turns your study activity — documents, flashcards, quizzes — into a shareable weekly recap.
          Sign in to see yours.
        </p>
        <Link href="/sign-in" className={buttonVariants()}>
          Sign in
        </Link>
      </main>
    )
  }

  const stats = await getWeeklyStats(session.userId)
  // Two different URLs, deliberately: the download button wants the raw PNG
  // directly, while "copy share link" hands out the /share page instead —
  // pasting a bare image URL into iMessage/X/LinkedIn renders as a plain
  // link, not a rich preview, since there's no og:image/twitter:card meta
  // around it. See buildStatCardShareUrl()'s doc comment in lib/stats.ts.
  const imageUrl = buildStatCardImageUrl(stats)
  const shareUrl = buildStatCardShareUrl(stats)

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Your weekly stat card</h1>
        <p className="text-muted-foreground">A snapshot of the last 7 days, ready to share.</p>
      </div>

      <StatCard stats={stats} />

      <div className="flex flex-wrap items-center gap-3">
        <a href={imageUrl} download="meminno-weekly-stats.png" className={buttonVariants()}>
          Download image
        </a>
        <CopyShareLinkButton path={shareUrl} />
      </div>
    </main>
  )
}

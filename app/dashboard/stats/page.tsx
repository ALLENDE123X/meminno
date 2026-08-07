import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { getWeeklyStats, buildStatCardImageUrl } from '@/lib/stats'
import { StatCard } from '@/components/stat-card'
import { CopyShareLinkButton } from '@/components/copy-share-link-button'
import { buttonVariants } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'Your weekly stats — Meminno',
  description: 'A shareable weekly recap of your Meminno study activity.',
}

// MEM-009. No dashboard shell/nav exists yet (that's MEM-003 scope, not
// shipped) - this is reached directly by URL for now, which is all this
// ticket needs ("this ticket doesn't need to build the full dashboard, just
// this card/feature and a sensible route to view it").
//
// MEM-003 (Supabase Auth sign-up flow) also hasn't shipped, so most visitors
// here won't have a session yet - that's handled explicitly below rather
// than assuming a signed-in user, and a signed-in user with a `public.users`
// row but zero documents/quizzes gets getWeeklyStats()'s real, honest empty
// state (not a fabricated placeholder card).
export default async function WeeklyStatsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">Sign in to see your weekly stat card</h1>
        <p className="max-w-md text-zinc-500">
          Meminno turns your study activity — documents, flashcards, quizzes — into a shareable weekly recap.
          Sign in to see yours.
        </p>
        <Link href="/" className={buttonVariants()}>
          Back home
        </Link>
      </main>
    )
  }

  const stats = await getWeeklyStats(user.id)
  const imageUrl = buildStatCardImageUrl(stats)

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Your weekly stat card</h1>
        <p className="text-zinc-500">A snapshot of the last 7 days, ready to share.</p>
      </div>

      <StatCard stats={stats} />

      <div className="flex flex-wrap items-center gap-3">
        <a href={imageUrl} download="meminno-weekly-stats.png" className={buttonVariants()}>
          Download image
        </a>
        <CopyShareLinkButton path={imageUrl} />
      </div>
    </main>
  )
}

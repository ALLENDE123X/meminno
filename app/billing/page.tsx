import Link from 'next/link'
import type { Metadata } from 'next'
import { getSessionUser } from '@/lib/session'
import { getBillingStatus } from '@/app/billing/actions'
import { BillingPlans } from '@/components/billing-plans'
import { buttonVariants } from '@/components/ui/button'

export const metadata: Metadata = {
  title: 'Billing — Meminno',
  description: 'Subscribe to Meminno or manage your existing subscription.',
}

// MEM-011. Server Component: real session check (getSessionUser(), same
// convention as every other /dashboard/* and app/dashboard/stats/page.tsx
// route) plus the caller's own current plan/subscription state
// (getBillingStatus()), handed to the interactive client half
// (components/billing-plans.tsx) as its initial value.
export default async function BillingPage() {
  const session = await getSessionUser()

  if (!session.ok) {
    return (
      <main className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">Sign in to manage billing</h1>
        <p className="max-w-md text-muted-foreground">
          Subscribe to Meminno for higher daily limits on notes, flashcards, and quizzes.
        </p>
        <Link href="/sign-in" className={buttonVariants()}>
          Sign in
        </Link>
      </main>
    )
  }

  const status = await getBillingStatus()

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-muted-foreground">Subscribe for higher daily limits, or manage your current plan.</p>
      </div>

      <BillingPlans initialStatus={status ?? { plan: 'free', hasSubscription: false }} />
    </main>
  )
}

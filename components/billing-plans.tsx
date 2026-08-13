'use client'

// MEM-011. The interactive half of /billing: subscribe buttons for a free
// user, plan/status + a cancel button for a paid one, plus a lightweight
// success/canceled banner read from the Stripe redirect's query params.
// Client component (needs useState/useSearchParams) split out of
// app/billing/page.tsx the same way components/upload-form.tsx was split
// out of app/upload/page.tsx — the page itself is a Server Component doing
// a real session check via getSessionUser().
//
// Deliberately simpler than Propinno's app/checkout/page.tsx: no
// auto-polling loop waiting for the webhook to land (per this ticket's
// "minimal UI... doesn't need to be elaborate" brief) — the success banner
// just tells the user their payment was received and to refresh if the
// plan shown below doesn't update within a few seconds, with a manual
// refresh button. This repo also has no `sonner` toast dependency (unlike
// Propinno), so status/errors render as inline text, matching
// components/upload-form.tsx's existing convention.
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { createCheckoutSession, cancelSubscription, type BillingStatus } from '@/app/billing/actions'
import type { Plan } from '@/lib/billing'

// MEM-039 (issue #89): 'semester' withdrawn from sale, 'weekly' added. Every
// read of this map falls back to the raw `plan` string (`PLAN_LABEL[plan] ??
// plan`), so a row on any historical tier still renders its own plan name
// rather than blanking out.
const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  weekly: 'Weekly',
  monthly: 'Monthly',
}

function PlanCard({
  plan,
  title,
  price,
  period,
  description,
  loading,
  onSubscribe,
}: {
  plan: Plan
  title: string
  price: string
  period: string
  description: string
  loading: boolean
  onSubscribe: (plan: Plan) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-3xl font-bold text-card-foreground">
          {price}
          <span className="text-base font-normal text-muted-foreground">{period}</span>
        </p>
        <Button className="w-full" disabled={loading} onClick={() => onSubscribe(plan)}>
          {loading ? 'Redirecting…' : `Subscribe`}
        </Button>
      </CardContent>
    </Card>
  )
}

function formatPeriodEnd(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function CurrentPlanCard({ status, onCancel, loading }: { status: BillingStatus; onCancel: () => void; loading: boolean }) {
  if (status.cancelAtPeriodEnd) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{PLAN_LABEL[status.plan] ?? status.plan} plan — cancellation scheduled</CardTitle>
          <CardDescription>
            {status.currentPeriodEnd
              ? `You won't be charged again. You'll keep your ${PLAN_LABEL[status.plan] ?? status.plan} access through ${formatPeriodEnd(status.currentPeriodEnd)}, then your plan will end.`
              : "You won't be charged again. Your access continues until the end of the current billing period, then your plan will end."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{PLAN_LABEL[status.plan] ?? status.plan} plan</CardTitle>
        <CardDescription>
          Renews automatically until you cancel. Cancelling stops future billing, but you keep your paid access through the end of the
          current billing period — no refund for the remaining time, and no charge after that.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" disabled={loading} onClick={onCancel}>
          {loading ? 'Cancelling…' : 'Cancel subscription'}
        </Button>
      </CardContent>
    </Card>
  )
}

function BillingContent({ initialStatus }: { initialStatus: BillingStatus }) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus)
  const [loading, setLoading] = useState<string | null>(null)
  // Captured once via lazy initializers (not derived in an effect + setState,
  // which React's react-hooks/set-state-in-effect rule flags as a
  // cascading-render risk) — mirrors Propinno's own
  // `const [initialSuccess] = useState(() => searchParams.get("success"))`
  // pattern in app/checkout/page.tsx for the exact same reason: read the
  // redirect param once on mount, independent of whatever the URL becomes
  // after router.replace() below clears it.
  const [initialSuccess] = useState(() => searchParams.get('success'))
  const [initialCanceled] = useState(() => searchParams.get('canceled'))
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(() => {
    if (initialSuccess) {
      return { text: 'Payment received — confirming your subscription. If your plan below doesn\'t update in a few seconds, refresh the page.' }
    }
    if (initialCanceled) {
      return { text: 'Checkout canceled — you have not been charged.', error: true }
    }
    return null
  })

  useEffect(() => {
    // Side-effect only (no setState here) — clears the ?success=/?canceled=
    // query string once, so a page refresh doesn't re-show a stale banner.
    if (initialSuccess || initialCanceled) {
      router.replace('/billing')
    }
    // Intentionally run-once: this only ever reacts to the redirect that
    // brought the user here, not to subsequent state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCheckout(plan: Plan) {
    setLoading(plan)
    setMessage(null)
    try {
      const res = await createCheckoutSession(plan)
      if (res.url) {
        window.location.href = res.url
        return
      }
      setMessage({ text: 'Stripe did not return a checkout URL. Please try again.', error: true })
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Something went wrong.', error: true })
    } finally {
      setLoading(null)
    }
  }

  async function handleCancel() {
    setLoading('cancel')
    setMessage(null)
    try {
      const res = await cancelSubscription()
      // Access continues until the period actually ends (see
      // app/billing/actions.ts's cancelSubscription() header comment) — the
      // plan itself is unchanged here, only the cancellation schedule is.
      setStatus((prev) => ({ ...prev, cancelAtPeriodEnd: true, currentPeriodEnd: res.currentPeriodEnd }))
      setMessage({
        text: res.currentPeriodEnd
          ? `Cancellation scheduled. You won't be charged again, and you'll keep access through ${formatPeriodEnd(res.currentPeriodEnd)}.`
          : "Cancellation scheduled — you won't be charged again.",
      })
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Something went wrong.', error: true })
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {message ? (
        <p className={`text-sm ${message.error ? 'text-destructive' : 'text-accent'}`}>{message.text}</p>
      ) : null}

      {status.plan !== 'free' ? (
        <CurrentPlanCard status={status} onCancel={handleCancel} loading={loading === 'cancel'} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* MEM-039 (issue #89): Weekly replaces Semester. This grid renders
              only the PURCHASABLE plans — Free needs no checkout and is
              already what `status.plan` is for anyone seeing this branch, so
              the landing page's three-card lineup (Free/Weekly/Monthly) shows
              as two cards here. Keep copy in sync with app/page.tsx by hand. */}
          <PlanCard
            plan="weekly"
            title="Weekly"
            price="$4.99"
            period="/wk"
            description="Higher daily limits for notes, flashcards, and quizzes, billed every week."
            loading={loading === 'weekly'}
            onSubscribe={handleCheckout}
          />
          <PlanCard
            plan="monthly"
            title="Monthly"
            price="$17.99"
            period="/mo"
            description="The same higher limits as Weekly, billed every month at the better per-week price."
            loading={loading === 'monthly'}
            onSubscribe={handleCheckout}
          />
        </div>
      )}
    </div>
  )
}

export function BillingPlans({ initialStatus }: { initialStatus: BillingStatus }) {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
      <BillingContent initialStatus={initialStatus} />
    </Suspense>
  )
}

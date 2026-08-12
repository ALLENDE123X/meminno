'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

// MEM-016 (issue #51): the frontend for MEM-015's
// POST/GET /api/documents/[id]/podcast. Deliberately its own component
// (not folded into components/document-workspace.tsx alongside
// notes/flashcards/quiz) because its state machine is genuinely different
// from theirs — every other generation button here is a single
// request/response; this one is a single request that can itself run for
// up to route.ts's `maxDuration = 300`, can come back 409 "already in
// flight" if a previous request (this tab, another tab, or a stranded one
// from before a page reload) is still working, and needs to resume tracking
// that in-flight state via polling on a fresh page load rather than only
// right after a click. Keeping that machine in its own file/tests instead
// of interleaving it with document-workspace.tsx's simpler one-shot flows
// keeps both readable.
//
// Podcasts don't depend on notes existing (route.ts generates straight from
// `documents.raw_text`, same source app/api/documents/[id]/notes/route.ts
// reads), so this section is unconditional — unlike flashcards/quizzes,
// which document-workspace.tsx only shows once a note exists.

type PodcastStatus = 'pending' | 'generating' | 'ready' | 'failed'

type PodcastRow = {
  id: string
  documentId: string
  userId: string
  status: PodcastStatus
  durationSeconds: number | null
  errorMessage: string | null
  createdAt: string
}

// Poll GET, not POST — POST is the mutating, budget-touching endpoint (see
// route.ts's own GET header comment for why it built GET specifically for
// this). 4s: within the 3-5s range a route with real per-poll DB + Storage
// work should use — fast enough to feel responsive once generation finishes,
// slow enough not to hammer the route.
const POLL_INTERVAL_MS = 4000

// route.ts pins `maxDuration = 300` to the Vercel Fluid Compute Hobby
// ceiling (see that file's header comment) — no live request can still be
// working past 300s, the platform will have killed it. 30s of margin on top
// covers this poll's own network latency plus the time between the POST
// that started generation and this component's first poll tick, so a
// generation that finishes right at the server's own deadline isn't cut off
// by a client timeout that's actually tighter than the server's.
const POLL_MAX_MS = 330_000

// GET only ever returns the short internal `errorMessage` reason code
// (route.ts's `publicPodcast` allow-list — see REASON_STATUS there for the
// canonical list this mirrors), not the human-readable `message` the POST
// failure path returns inline. This is the client-side equivalent so a
// podcast discovered already-failed (page load, or a poll that lands on a
// terminal 'failed' row) still reads as a specific, honest reason instead of
// a bare code or a generic "something went wrong".
const REASON_MESSAGES: Record<string, string> = {
  not_configured: "Podcast generation isn't available right now. Please try again in a moment.",
  empty_input: 'This document has no text to generate a podcast from.',
  invalid_response: "Couldn't generate a valid podcast from this document. Please try again in a moment.",
  invalid_script: "Couldn't generate a valid podcast script from this document. Please try again in a moment.",
  script_too_long: 'This document is too long to turn into a podcast right now.',
  api_error: 'Something went wrong generating this podcast. Please try again in a moment.',
  upload_failed: "Couldn't save this podcast. Please try again in a moment.",
  timed_out: 'Podcast generation was interrupted. Please try again.',
}
const DEFAULT_FAILURE_MESSAGE = 'Something went wrong generating this podcast. Please try again.'

function friendlyFailureMessage(reason: string | null): string {
  if (reason && Object.prototype.hasOwnProperty.call(REASON_MESSAGES, reason)) {
    // eslint-disable-next-line security/detect-object-injection -- reason is guarded by hasOwnProperty immediately above, not raw user input reaching an unchecked index
    return REASON_MESSAGES[reason]
  }
  return DEFAULT_FAILURE_MESSAGE
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

type State =
  | { phase: 'checking' }
  | { phase: 'none' }
  | { phase: 'submitting' }
  | { phase: 'polling' }
  | { phase: 'ready'; audioUrl: string | null; durationSeconds: number | null }
  | { phase: 'failed'; message: string }
  | { phase: 'timeout' }

type StatusResult =
  | { kind: 'ready'; audioUrl: string | null; durationSeconds: number | null }
  | { kind: 'in_progress' }
  | { kind: 'failed'; message: string }
  | { kind: 'none' }
  | { kind: 'error' }

async function fetchPodcastStatus(documentId: string): Promise<StatusResult> {
  try {
    const res = await fetch(`/api/documents/${documentId}/podcast`)
    if (res.status === 404) return { kind: 'none' }
    if (!res.ok) return { kind: 'error' }
    const body = await res.json()
    const podcast = body.podcast as PodcastRow | undefined
    if (!podcast) return { kind: 'error' }
    if (podcast.status === 'ready') {
      return { kind: 'ready', audioUrl: body.audioUrl ?? null, durationSeconds: podcast.durationSeconds ?? null }
    }
    if (podcast.status === 'failed') {
      return { kind: 'failed', message: friendlyFailureMessage(podcast.errorMessage) }
    }
    return { kind: 'in_progress' }
  } catch {
    return { kind: 'error' }
  }
}

export function PodcastSection({ documentId }: { documentId: string }) {
  const [state, setState] = useState<State>({ phase: 'checking' })

  // Guards the actual double-click race this component exists to close (see
  // MEM-015's own header comment on the ~100-300ms window between checking
  // for an in-flight row and that row actually landing): checked and set
  // synchronously at the top of handleGenerate, before the disabling
  // setState below has had a chance to re-render, so two click events fired
  // in the same tick can't both pass it.
  const submittingRef = useRef(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadlineRef = useRef(0)
  const mountedRef = useRef(true)

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const applyResult = useCallback(
    (result: StatusResult, onInProgress: () => void) => {
      if (!mountedRef.current) return
      if (result.kind === 'ready') {
        stopPolling()
        setState({ phase: 'ready', audioUrl: result.audioUrl, durationSeconds: result.durationSeconds })
      } else if (result.kind === 'failed') {
        stopPolling()
        setState({ phase: 'failed', message: result.message })
      } else if (result.kind === 'none') {
        stopPolling()
        setState({ phase: 'none' })
      } else {
        // 'in_progress' or a transient 'error' (network blip, momentary 5xx)
        // both mean "not resolved yet" — keep polling either way rather than
        // treating a single failed poll as terminal.
        onInProgress()
      }
    },
    [stopPolling]
  )

  const poll = useCallback(async () => {
    if (Date.now() > deadlineRef.current) {
      stopPolling()
      if (mountedRef.current) setState({ phase: 'timeout' })
      return
    }
    const result = await fetchPodcastStatus(documentId)
    applyResult(result, () => {})
  }, [documentId, applyResult, stopPolling])

  const startPolling = useCallback(() => {
    stopPolling()
    deadlineRef.current = Date.now() + POLL_MAX_MS
    intervalRef.current = setInterval(() => {
      void poll()
    }, POLL_INTERVAL_MS)
  }, [poll, stopPolling])

  // Mount check (item 4 of MEM-016's brief): a podcast generated in a
  // previous visit, or one still 'generating' from a request this page
  // wasn't open for (another tab, or a reload mid-generation), must be
  // picked up here rather than making the user click "Generate" again.
  useEffect(() => {
    mountedRef.current = true
    ;(async () => {
      const result = await fetchPodcastStatus(documentId)
      if (!mountedRef.current) return
      if (result.kind === 'ready') {
        setState({ phase: 'ready', audioUrl: result.audioUrl, durationSeconds: result.durationSeconds })
      } else if (result.kind === 'failed') {
        setState({ phase: 'failed', message: result.message })
      } else if (result.kind === 'in_progress') {
        setState({ phase: 'polling' })
        startPolling()
      } else {
        // 'none', or a transient 'error' on this initial check — fall back
        // to the same idle state either way. A genuine in-flight generation
        // this check failed to see (a momentary network blip) is still
        // caught: the very next click on "Generate podcast" hits route.ts's
        // own 409 in-flight check and transitions to polling from there.
        setState({ phase: 'none' })
      }
    })()
    return () => {
      mountedRef.current = false
      stopPolling()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only; documentId is stable per page
  }, [])

  const handleGenerate = useCallback(async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setState({ phase: 'submitting' })
    try {
      const res = await fetch(`/api/documents/${documentId}/podcast`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        const podcast = body.podcast as PodcastRow | undefined
        setState({ phase: 'ready', audioUrl: body.audioUrl ?? null, durationSeconds: podcast?.durationSeconds ?? null })
        return
      }
      if (res.status === 409) {
        const inFlightPodcast = body.podcast as PodcastRow | undefined
        if (inFlightPodcast) {
          // The "already in flight" 409 (route.ts's existing-podcast check):
          // another request (this session's own retry, another tab, or a
          // request this page wasn't open for) is already generating —
          // start/resume the same polling loop the mount check uses.
          setState({ phase: 'polling' })
          startPolling()
        } else {
          // route.ts's *other* 409 shape, from later in the pipeline: the
          // document was changed or removed while a previous generation was
          // mid-flight (`podcasts.document_id` is `ON DELETE CASCADE`), so
          // its final UPDATE matched no row. No `podcast` comes back with
          // this one — there is nothing in flight to poll for, so this is a
          // genuine, honest failure rather than "still generating".
          setState({ phase: 'failed', message: typeof body.error === 'string' ? body.error : DEFAULT_FAILURE_MESSAGE })
        }
        return
      }
      // 422/429/502/503 — route.ts always sends a specific, human-readable
      // `error` for each (see its REASON_STATUS table and
      // lib/podcastLimits.ts's own reason strings), so use it verbatim
      // rather than a generic message.
      setState({ phase: 'failed', message: typeof body.error === 'string' ? body.error : DEFAULT_FAILURE_MESSAGE })
    } catch {
      setState({ phase: 'failed', message: 'Network error, please try again.' })
    } finally {
      submittingRef.current = false
    }
  }, [documentId, startPolling])

  // Reached only from the `timeout` state, i.e. only after POLL_MAX_MS has
  // already elapsed — which is provably past the point route.ts's own
  // STALE_GENERATING_MS recovery treats a 'generating' row as dead (see that
  // constant's comment there: maxDuration=300 is a hard, confirmed platform
  // ceiling, so no live request can still be working on a row past it).
  // route.ts only performs that recovery — mark the row failed, allow a
  // fresh generation — inside its POST handler; GET never mutates anything.
  // So a bare GET recheck here can, in the genuinely-stranded case, only
  // ever re-report 'generating' forever: the row is provably dead, but
  // nothing about a GET can ever say so. Check first anyway (cheap, and it
  // catches the podcast having actually finished right around our own
  // deadline), but if it's still not resolved, escalate to a real POST —
  // which either 409s harmlessly (the row turned out to still be within its
  // 10-minute grace window server-side) and resumes polling from there, or
  // triggers the real recovery and regenerates. Without this fallthrough,
  // "Check status" on a truly stranded row is a closed loop that can never
  // POST, so the document stays permanently un-podcastable and the spent
  // daily budget unit is never reclaimed.
  const handleCheckAgain = useCallback(async () => {
    setState({ phase: 'polling' })
    const result = await fetchPodcastStatus(documentId)
    applyResult(result, () => void handleGenerate())
  }, [documentId, applyResult, handleGenerate])

  const handleReloadPlayer = useCallback(async () => {
    const result = await fetchPodcastStatus(documentId)
    applyResult(result, () => startPolling())
  }, [documentId, applyResult, startPolling])

  const busy = state.phase === 'checking' || state.phase === 'submitting' || state.phase === 'polling'
  const showHeaderButton = state.phase !== 'ready'
  const headerLabel =
    state.phase === 'checking'
      ? 'Checking…'
      : state.phase === 'submitting' || state.phase === 'polling'
        ? 'Generating…'
        : state.phase === 'failed'
          ? 'Try again'
          : state.phase === 'timeout'
            ? 'Check status'
            : 'Generate podcast'
  const headerAction =
    state.phase === 'failed' ? () => void handleGenerate() : state.phase === 'timeout' ? () => void handleCheckAgain() : () => void handleGenerate()

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Podcast</h2>
        {showHeaderButton ? (
          <Button type="button" variant="default" size="sm" onClick={headerAction} disabled={busy}>
            {headerLabel}
          </Button>
        ) : null}
      </div>

      {state.phase === 'none' ? (
        <EmptyNote text="No podcast yet. Generate a 2-speaker Audio Overview of this document." />
      ) : null}

      {state.phase === 'submitting' ? (
        <EmptyNote text="Generating your podcast — this can take a few minutes. You can leave this page; it'll be here when you check back." />
      ) : null}

      {state.phase === 'polling' ? <EmptyNote text="Still generating — checking for updates every few seconds." /> : null}

      {state.phase === 'timeout' ? (
        <EmptyNote text="This is taking longer than expected. Generation may still finish in the background — try checking again in a few minutes." />
      ) : null}

      {state.phase === 'failed' ? <ErrorNote message={state.message} /> : null}

      {state.phase === 'ready' ? (
        state.audioUrl ? (
          <Card>
            <CardContent className="flex flex-col gap-2 p-5">
              {/* Plain <audio>, no custom player chrome — matches this repo's
                  established "keep it simple" convention for media (see
                  components/document-workspace.tsx's lack of any image
                  wrapper, and CLAUDE.md's listing-image convention on the
                  sibling Propinno project this pattern was inherited from). */}
              <audio controls src={state.audioUrl} className="w-full" data-testid="podcast-audio">
                Your browser does not support the audio element.
              </audio>
              {formatDuration(state.durationSeconds) ? (
                <p className="text-xs text-muted-foreground">{formatDuration(state.durationSeconds)}</p>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            <ErrorNote message="Your podcast is ready, but the player link couldn't be loaded." />
            <Button type="button" variant="outline" size="sm" onClick={() => void handleReloadPlayer()} className="self-start">
              Reload player
            </Button>
          </div>
        )
      ) : null}
    </section>
  )
}

function ErrorNote({ message }: { message: string }) {
  return <p className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{message}</p>
}

function EmptyNote({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">{text}</p>
}

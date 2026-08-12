import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PodcastSection } from '@/components/podcast-section'

// MEM-016 (issue #51): covers the state machine components/podcast-section.tsx
// implements around MEM-015's POST/GET /api/documents/[id]/podcast — the
// mount-time existing-podcast check, every response-status handling path,
// the disable-on-submit double-click guard (route.ts's own header comment
// flags the ~100-300ms window this closes), the polling loop reaching a
// terminal state, and the poll-timeout ceiling. No existing component test
// file to mirror in this repo yet (see this ticket's dispatch) — conventions
// below (fetch mocked per-call via a queue, fake timers for polling,
// `screen`/`fireEvent`/`waitFor` from @testing-library/react, which was
// already a devDependency but unused until this ticket) are new for this
// repo's test suite but standard for the library.

const DOCUMENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function readyPodcast(overrides: Partial<{ durationSeconds: number | null; audioUrl: string | null }> = {}) {
  return {
    podcast: {
      id: 'podcast-1',
      documentId: DOCUMENT_ID,
      userId: 'user-1',
      status: 'ready',
      durationSeconds: overrides.durationSeconds ?? 278,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    },
    audioUrl: overrides.audioUrl === undefined ? 'https://storage.example/signed/podcast-1.wav' : overrides.audioUrl,
    expiresInSeconds: 3600,
  }
}

function generatingPodcast() {
  return {
    podcast: {
      id: 'podcast-1',
      documentId: DOCUMENT_ID,
      userId: 'user-1',
      status: 'generating',
      durationSeconds: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    },
    audioUrl: null,
    expiresInSeconds: null,
  }
}

function failedPodcast(reason: string) {
  return {
    podcast: {
      id: 'podcast-1',
      documentId: DOCUMENT_ID,
      userId: 'user-1',
      status: 'failed',
      durationSeconds: null,
      errorMessage: reason,
      createdAt: new Date().toISOString(),
    },
    audioUrl: null,
    expiresInSeconds: null,
  }
}

/** A promise this test controls the resolution of, to inspect state mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Advances vitest's fake timers AND flushes the resulting React state
 * updates/microtasks through `act`. Needed for every fake-timer test below:
 * @testing-library/react's own `findBy*`/`waitFor` poll via `setTimeout`
 * internally, which hangs forever once fake timers replace the global timer
 * functions — so those fake-timer tests use plain synchronous `getBy*`
 * queries after an explicit `flush()` instead of `findBy*`.
 */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('PodcastSection — mount check (item 4: existing podcast on page load)', () => {
  it('shows the Generate button when no podcast exists yet (404)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'No podcast found for this document' }))
    render(<PodcastSection documentId={DOCUMENT_ID} />)

    expect(await screen.findByRole('button', { name: 'Generate podcast' })).toBeEnabled()
    expect(screen.getByText(/No podcast yet/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(`/api/documents/${DOCUMENT_ID}/podcast`)
  })

  it('renders the player directly for an already-ready podcast, with no Generate button', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, readyPodcast({ audioUrl: 'https://storage.example/signed/a.wav' })))
    render(<PodcastSection documentId={DOCUMENT_ID} />)

    const audio = await screen.findByTestId('podcast-audio')
    expect(audio).toHaveAttribute('src', 'https://storage.example/signed/a.wav')
    expect(screen.queryByRole('button', { name: /Generate podcast/ })).not.toBeInTheDocument()
  })

  it('shows a failed state with a friendly reason and a retry button for an already-failed podcast', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, failedPodcast('api_error')))
    render(<PodcastSection documentId={DOCUMENT_ID} />)

    expect(await screen.findByText(/Something went wrong generating this podcast/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('maps every known failure reason to its own specific message, not a generic one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, failedPodcast('empty_input')))
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    expect(await screen.findByText('This document has no text to generate a podcast from.')).toBeInTheDocument()
  })

  it('starts polling for a podcast still generating from a previous visit/tab', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, generatingPodcast())) // mount check
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    await flush()

    expect(screen.getByText(/Still generating/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled()

    fetchMock.mockResolvedValueOnce(jsonResponse(200, readyPodcast())) // first poll tick
    await flush(4000)

    expect(screen.getByTestId('podcast-audio')).toBeInTheDocument()
  })
})

describe('PodcastSection — generate-click flow', () => {
  it('disables the button immediately on click, before the POST resolves', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {})) // mount check
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    const button = await screen.findByRole('button', { name: 'Generate podcast' })

    const post = deferred<Response>()
    fetchMock.mockReturnValueOnce(post.promise)

    fireEvent.click(button)

    // Assert synchronously right after the click — before the deferred POST
    // resolves — that the button is already disabled. This is the exact
    // client-side mitigation MEM-015's route.ts flags as required: a
    // double-click must not be able to file two POSTs.
    expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled()

    post.resolve(jsonResponse(201, readyPodcast()))
    expect(await screen.findByTestId('podcast-audio')).toBeInTheDocument()
  })

  it('a second click while a request is in flight does not fire a second POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {})) // mount check
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    const button = await screen.findByRole('button', { name: 'Generate podcast' })

    const post = deferred<Response>()
    fetchMock.mockReturnValueOnce(post.promise)

    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Generating…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Generating…' }))

    // One call for the mount GET, exactly one for the POST — the extra
    // clicks were absorbed by submittingRef's synchronous guard.
    expect(fetchMock).toHaveBeenCalledTimes(2)

    post.resolve(jsonResponse(201, readyPodcast()))
    await screen.findByTestId('podcast-audio')
  })

  it('201 fresh generation renders the player', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    const button = await screen.findByRole('button', { name: 'Generate podcast' })

    fetchMock.mockResolvedValueOnce(jsonResponse(201, readyPodcast({ durationSeconds: 300 })))
    fireEvent.click(button)

    expect(await screen.findByTestId('podcast-audio')).toBeInTheDocument()
    expect(screen.getByText('5:00')).toBeInTheDocument()
  })

  it('200 existing:true (already-ready podcast) also renders the player', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    const button = await screen.findByRole('button', { name: 'Generate podcast' })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...readyPodcast(), existing: true }))
    fireEvent.click(button)

    expect(await screen.findByTestId('podcast-audio')).toBeInTheDocument()
  })

  it('409 in-flight starts polling and resolves once the other request finishes', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {})) // mount check
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    await flush()
    const button = screen.getByRole('button', { name: 'Generate podcast' })

    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: 'A podcast for this document is already being generated. Check back in a few minutes.',
        podcast: generatingPodcast().podcast,
      })
    )
    fireEvent.click(button)
    await flush()
    expect(screen.getByText(/Still generating/)).toBeInTheDocument()

    fetchMock.mockResolvedValueOnce(jsonResponse(200, readyPodcast()))
    await flush(4000)

    expect(screen.getByTestId('podcast-audio')).toBeInTheDocument()
  })

  it.each([
    [422, 'This document has no text to generate a podcast from'],
    [429, 'Free plan is limited to 2 podcasts per day. Upgrade for a higher daily limit.'],
    [502, "Couldn't turn this script into audio. Please try again in a moment."],
    [503, "AI podcast generation isn't available right now. Please try again in a moment."],
  ])('%i shows the exact honest error message from the route, not a generic one', async (status, message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    const button = await screen.findByRole('button', { name: 'Generate podcast' })

    fetchMock.mockResolvedValueOnce(jsonResponse(status, { error: message, reason: 'api_error', podcastId: 'podcast-1' }))
    fireEvent.click(button)

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('a network error (fetch throws) is shown as a clear, non-generic-looking network message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    const button = await screen.findByRole('button', { name: 'Generate podcast' })

    fetchMock.mockRejectedValueOnce(new Error('fetch failed'))
    fireEvent.click(button)

    expect(await screen.findByText('Network error, please try again.')).toBeInTheDocument()
  })
})

describe('PodcastSection — failed-state retry', () => {
  it('clicking "Try again" after a failure re-POSTs and can succeed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, failedPodcast('upload_failed')))
    render(<PodcastSection documentId={DOCUMENT_ID} />)

    const retry = await screen.findByRole('button', { name: 'Try again' })
    fetchMock.mockResolvedValueOnce(jsonResponse(201, readyPodcast()))
    fireEvent.click(retry)

    expect(await screen.findByTestId('podcast-audio')).toBeInTheDocument()
  })
})

describe('PodcastSection — polling ceiling', () => {
  it('gives up with a timeout state after exceeding the poll window without a terminal status', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, generatingPodcast())) // mount check
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    await flush()
    expect(screen.getByText(/Still generating/)).toBeInTheDocument()

    // Every subsequent poll (mount check already consumed the first mock)
    // keeps reporting 'generating' — never resolves.
    fetchMock.mockResolvedValue(jsonResponse(200, generatingPodcast()))

    // Past POLL_MAX_MS (330s): the poller should stop on its own rather than
    // spin past the point route.ts's own maxDuration=300 ceiling makes
    // generation possible at all.
    await flush(335_000)

    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check status' })).toBeEnabled()
  })

  it('"Check status" after a timeout can resolve to ready', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, generatingPodcast()))
    render(<PodcastSection documentId={DOCUMENT_ID} />)
    await flush()
    expect(screen.getByText(/Still generating/)).toBeInTheDocument()

    fetchMock.mockResolvedValue(jsonResponse(200, generatingPodcast()))
    await flush(335_000)
    const checkAgain = screen.getByRole('button', { name: 'Check status' })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, readyPodcast()))
    fireEvent.click(checkAgain)
    await flush()

    expect(screen.getByTestId('podcast-audio')).toBeInTheDocument()
  })
})

describe('PodcastSection — ready without a signed URL', () => {
  it('offers a Reload player action when the podcast is ready but audioUrl is null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, readyPodcast({ audioUrl: null })))
    render(<PodcastSection documentId={DOCUMENT_ID} />)

    expect(await screen.findByText(/couldn't be loaded/)).toBeInTheDocument()
    const reload = screen.getByRole('button', { name: 'Reload player' })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, readyPodcast({ audioUrl: 'https://storage.example/signed/b.wav' })))
    fireEvent.click(reload)

    const audio = await screen.findByTestId('podcast-audio')
    expect(audio).toHaveAttribute('src', 'https://storage.example/signed/b.wav')
  })
})

describe('PodcastSection — unmount safety', () => {
  it('does not throw or warn when unmounted while a poll is in flight', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(jsonResponse(200, generatingPodcast()))
    const { unmount } = render(<PodcastSection documentId={DOCUMENT_ID} />)
    await flush()
    expect(screen.getByText(/Still generating/)).toBeInTheDocument()

    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    await flush(4000)

    unmount()
    // Resolving after unmount must not touch state on an unmounted component
    // — mountedRef guards every setState in podcast-section.tsx, so this
    // should neither throw nor warn ("state update on an unmounted
    // component"). Advancing fake timers again would also confirm the
    // interval was actually cleared on unmount, but act()'s own React
    // warnings are the more direct signal here.
    pending.resolve(jsonResponse(200, readyPodcast()))
    await flush()
  })
})

'use client'

// Issue #42: record a live lecture in the browser and turn it into a real
// document, the same way a PDF upload or pasted text does — this was the
// original Turbo AI core use case this product fast-follows, and the
// landing page has said "on the roadmap" since MEM-010.
//
// WHY CHUNKED, NOT ONE LONG RECORDING: Vercel Functions cap request bodies
// at 4.5MB platform-wide, unconfigurable (see app/api/documents/route.ts's
// MAX_PDF_BYTES comment) — far smaller than a real 50-90 minute lecture at
// any usable audio quality. So this records in ~8-minute segments,
// uploading and transcribing each as it completes (POST
// /api/documents/record-chunk), then assembles the full transcript
// client-side and saves it as one document only once the user stops.
//
// WHY STOP/RESTART, NOT MediaRecorder's `timeslice` PARAMETER: passing a
// timeslice to `.start()` makes `ondataavailable` fire periodically, but
// for a single continuous recording session those periodic blobs are NOT
// independently decodable audio files — only the FIRST one has the
// container header. Genuinely independent, safely-transcribable segments
// require actually stopping one MediaRecorder instance (which finalizes
// its blob with a real header) and starting a fresh one on the same
// underlying stream — this file does that on an ~8-minute cycle. There is
// a small (tens of ms) gap in the recording at each cycle boundary as a
// result; a real, disclosed limitation, not a bug.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

const SEGMENT_DURATION_MS = 8 * 60 * 1000
// Covers any realistic lecture/seminar length with margin. Auto-stops and
// saves rather than silently truncating.
const MAX_TOTAL_DURATION_MS = 90 * 60 * 1000

// A segment carrying NO audio frames at all still produces a valid, tiny
// WebM container header. Measured for real in Chrome during this ticket's
// browser verification: 8 seconds of pure digital silence encodes to 110
// bytes, while 8 seconds of real speech at the same settings encodes to
// 32,492 bytes (~295x larger, matching the 32kbps target). OpenAI rejects
// the former outright with `400 Audio file might be corrupted or
// unsupported` rather than returning empty text -- correctly, since there
// is genuinely no audio in it. Uploading one anyway would burn a unit of
// lib/recordingLimits.ts budget and a real API call to learn nothing, and
// would splice a "[transcription failed for this segment]" marker into the
// user's actual lecture notes for a stretch where simply nothing was said.
// So skip it client-side instead. 1KB is a deliberately conservative
// threshold: at 32kbps even a quarter-second of real audio clears it, and
// any real microphone's ambient noise floor produces real frames.
const MIN_SEGMENT_BYTES = 1024

// Preference order: opus-in-webm is the best-supported, smallest-for-quality
// option in Chrome/Firefox/Edge. audio/mp4 covers Safari, which has
// historically not supported webm recording at all. Both are in OpenAI's
// documented supported-format list (flac, mp3, mp4, mpeg, mpga, m4a, ogg,
// wav, webm).
const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

function pickSupportedMimeType(): string | null {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return null
  if (typeof MediaRecorder.isTypeSupported !== 'function') return CANDIDATE_MIME_TYPES[0]
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null
}

// OpenAI's transcription endpoint infers the audio format from the uploaded
// FILENAME's extension, not from the multipart part's content type — so a
// Safari-recorded audio/mp4 segment sent as "segment-0.webm" is rejected as
// a corrupt webm rather than read as the valid mp4 it is. Derive the
// extension from the blob's real type instead of hardcoding one.
function extensionForMimeType(mimeType: string): string {
  // Strip any codecs parameter: "audio/webm;codecs=opus" -> "audio/webm".
  const base = mimeType.split(';')[0].trim()
  if (base === 'audio/mp4') return 'mp4'
  if (base === 'audio/ogg') return 'ogg'
  return 'webm'
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

type SegmentStatus = 'uploading' | 'done' | 'failed'
type Segment = { index: number; status: SegmentStatus }
type Phase = 'idle' | 'recording' | 'saving' | 'error'

type Props = {
  title: string
  onSaved: (documentId: string, title: string, charCount: number) => void
}

export function LectureRecorder({ title, onSaved }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [segments, setSegments] = useState<Segment[]>([])
  const [transcriptPreview, setTranscriptPreview] = useState('')
  // Post-review fix (PR #43): the full transcript is otherwise unrecoverable
  // if the final save fails — a real, reachable case, since the per-user
  // recording-chunk budget (40/day free) is generously higher than the
  // per-user upload budget the save itself claims (5/day free), so a free
  // user can legitimately finish transcribing a whole 90-minute lecture and
  // then have the save itself 429. Kept in state (not just a local var) so
  // the error view below can offer "Retry save" without re-recording, and
  // so the transcript itself stays visible to copy manually if preferred.
  const [pendingSaveText, setPendingSaveText] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  // Indirection for the segment cycle's self-restart. startNewRecorderCycle()
  // has to schedule the *next* cycle from inside its own recorder's onstop
  // handler, which is a direct self-reference — illegal to write literally
  // inside its own useCallback body (`react-hooks/immutability` errors on
  // accessing the const before it's declared, and it would capture a stale
  // binding). Routing the restart through a ref assigned in an effect below
  // keeps the cycle going without either problem.
  const startCycleRef = useRef<(() => void) | null>(null)
  const mimeTypeRef = useRef<string | null>(null)
  const transcriptRef = useRef<string[]>([])
  const uploadPromisesRef = useRef<Promise<void>[]>([])
  const segmentIndexRef = useRef(0)
  const startedAtRef = useRef(0)
  const cycleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // True once "Stop & Save" fires, so the in-flight recorder's onstop
  // handler knows to release the mic instead of starting the next cycle.
  const stoppingRef = useRef(false)

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    // Release the mic if the user navigates away mid-recording rather than
    // clicking Stop & Save.
    return () => {
      if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current)
      if (tickIntervalRef.current) clearInterval(tickIntervalRef.current)
      releaseStream()
    }
  }, [releaseStream])

  const uploadSegment = useCallback((blob: Blob, index: number): Promise<void> => {
    setSegments((prev) => [...prev, { index, status: 'uploading' }])
    return (async () => {
      try {
        const formData = new FormData()
        formData.set('audio', blob, `segment-${index}.${extensionForMimeType(blob.type)}`)
        const res = await fetch('/api/documents/record-chunk', { method: 'POST', body: formData })
        const body = await res.json()
        const text = res.ok && typeof body.text === 'string' ? body.text : '[transcription failed for this segment]'
        // eslint-disable-next-line security/detect-object-injection -- index is a monotonic local segment counter (segmentIndexRef), not user input
        transcriptRef.current[index] = text
        setSegments((prev) => prev.map((s) => (s.index === index ? { ...s, status: res.ok ? 'done' : 'failed' } : s)))
      } catch {
        // eslint-disable-next-line security/detect-object-injection -- see the disable above, same bounded local index
        transcriptRef.current[index] = '[transcription failed for this segment]'
        setSegments((prev) => prev.map((s) => (s.index === index ? { ...s, status: 'failed' } : s)))
      } finally {
        setTranscriptPreview(transcriptRef.current.filter(Boolean).join(' '))
      }
    })()
  }, [])

  const startNewRecorderCycle = useCallback(() => {
    const stream = streamRef.current
    const mimeType = mimeTypeRef.current
    if (!stream || !mimeType) return

    const chunks: Blob[] = []
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      const index = segmentIndexRef.current
      segmentIndexRef.current += 1
      const blob = new Blob(chunks, { type: mimeType })
      // See MIN_SEGMENT_BYTES. A frameless (silent) segment is skipped
      // entirely rather than uploaded: it contributes nothing to the
      // transcript and is never counted in the segment tally, so the
      // counter only ever reflects segments that actually carried audio.
      if (blob.size >= MIN_SEGMENT_BYTES) {
        uploadPromisesRef.current.push(uploadSegment(blob, index))
      }

      if (stoppingRef.current) {
        releaseStream()
      } else {
        startCycleRef.current?.()
      }
    }
    recorder.start()
    recorderRef.current = recorder
    cycleTimeoutRef.current = setTimeout(() => recorderRef.current?.stop(), SEGMENT_DURATION_MS)
  }, [releaseStream, uploadSegment])

  // See startCycleRef's declaration above. Runs on mount, long before any
  // user can click "Start recording", so the cycle can never fire with an
  // unassigned ref.
  useEffect(() => {
    startCycleRef.current = startNewRecorderCycle
  }, [startNewRecorderCycle])

  // Shared by handleStopAndSave (first attempt) and handleRetrySave (after a
  // failed attempt) — extracted so a failed save can be retried with the
  // exact same already-transcribed text instead of forcing a re-recording.
  const saveTranscript = useCallback(
    async (fullText: string) => {
      try {
        const formData = new FormData()
        formData.set('recordingText', fullText)
        if (title.trim()) formData.set('title', title.trim())
        const res = await fetch('/api/documents', { method: 'POST', body: formData })
        const body = await res.json()
        if (!res.ok) {
          setPhase('error')
          setPendingSaveText(fullText)
          setErrorMessage(body.error ?? 'Failed to save recording')
          return
        }
        setPendingSaveText(null)
        // Back to idle rather than staying on 'saving' forever: the parent
        // (components/upload-form.tsx) renders its own success message and
        // "View document" link below this component, so leaving the recorder
        // showing a pulsing "Saving…" next to a success message reads as a
        // hung save. Idle also makes recording a second lecture a single
        // click, and handleStart() re-initialises every ref/state it needs.
        setPhase('idle')
        onSaved(body.document.id, body.document.title, body.document.rawText.length)
      } catch {
        setPhase('error')
        setPendingSaveText(fullText)
        setErrorMessage('Network error while saving the recording, please try again.')
      }
    },
    [onSaved, title]
  )

  const handleStopAndSave = useCallback(async () => {
    if (stoppingRef.current) return
    stoppingRef.current = true
    if (tickIntervalRef.current) clearInterval(tickIntervalRef.current)
    if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current)
    setPhase('saving')

    // Stop the in-progress segment — its onstop handler (above) uploads
    // this final chunk and, since stoppingRef is now true, releases the
    // mic instead of starting another cycle.
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        const originalOnStop = recorder.onstop
        recorder.onstop = (ev) => {
          if (typeof originalOnStop === 'function') originalOnStop.call(recorder, ev)
          resolve()
        }
        recorder.stop()
      })
    }

    // uploadSegment() calls above are fire-and-forget from onstop's
    // perspective — wait for every one of them (including this final
    // segment's) before assembling the transcript.
    await Promise.all(uploadPromisesRef.current)

    const fullText = transcriptRef.current.filter(Boolean).join(' ').trim()
    if (!fullText) {
      setPhase('error')
      setErrorMessage("Nothing was transcribed from this recording — check your microphone and try again.")
      return
    }

    await saveTranscript(fullText)
  }, [saveTranscript])

  async function handleRetrySave() {
    if (!pendingSaveText) return
    setErrorMessage(null)
    setPhase('saving')
    await saveTranscript(pendingSaveText)
  }

  async function handleStart() {
    setErrorMessage(null)

    const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    const mimeType = supported ? pickSupportedMimeType() : null
    if (!supported || !mimeType) {
      setPhase('error')
      setErrorMessage("Recording isn't supported in this browser. Try a recent version of Chrome, Firefox, Edge, or Safari.")
      return
    }
    mimeTypeRef.current = mimeType

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    } catch {
      setPhase('error')
      setErrorMessage('Microphone access was denied or unavailable. Check your browser permissions and try again.')
      return
    }
    streamRef.current = stream

    stoppingRef.current = false
    segmentIndexRef.current = 0
    transcriptRef.current = []
    uploadPromisesRef.current = []
    setSegments([])
    setTranscriptPreview('')
    setPendingSaveText(null)
    setElapsedMs(0)
    startedAtRef.current = Date.now()
    setPhase('recording')
    startNewRecorderCycle()

    tickIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      if (elapsed >= MAX_TOTAL_DURATION_MS) {
        void handleStopAndSave()
      }
    }, 1000)
  }

  if (phase === 'idle' || phase === 'error') {
    return (
      <div className="flex flex-col gap-3">
        {phase === 'error' && pendingSaveText ? (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">{errorMessage}</p>
            <p className="text-xs text-muted-foreground">
              Your transcript wasn&apos;t lost — it&apos;s kept here until you retry the save or start a new recording.
            </p>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              {pendingSaveText}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void handleRetrySave()}>
              Retry save
            </Button>
          </div>
        ) : errorMessage ? (
          <p className="text-sm text-destructive">{errorMessage}</p>
        ) : null}

        <p className="text-sm text-muted-foreground">
          Record a lecture live — Meminno transcribes it in the background as you go, in roughly 8-minute segments,
          up to 90 minutes total.
        </p>
        <p className="text-xs text-muted-foreground">
          Audio is sent to OpenAI for transcription and isn&apos;t stored by us afterward — only the resulting text is saved.
        </p>
        <Button type="button" onClick={handleStart}>
          Start recording
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${phase === 'recording' ? 'animate-pulse bg-destructive' : 'bg-muted-foreground'}`} />
          <span className="text-sm font-medium text-foreground">
            {phase === 'recording' ? 'Recording' : 'Saving…'} — {formatElapsed(elapsedMs)}
          </span>
        </div>
        {phase === 'recording' ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void handleStopAndSave()}>
            Stop &amp; save
          </Button>
        ) : null}
      </div>

      {segments.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {segments.filter((s) => s.status === 'done').length}/{segments.length} segment
          {segments.length === 1 ? '' : 's'} transcribed
          {segments.some((s) => s.status === 'failed') ? ' (some failed — still saveable)' : ''}
        </p>
      ) : null}

      {transcriptPreview ? (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {transcriptPreview}
        </div>
      ) : null}
    </div>
  )
}

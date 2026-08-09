import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { checkRecordingBurstLimit, claimChunkTranscriptionBudget } from '@/lib/recordingLimits'
import { transcribeAudioChunk, type TranscribeChunkResult } from '@/lib/audioTranscription'

// Issue #42: lecture recording. Stateless — transcribes ONE audio chunk of
// a lecture (components/lecture-recorder.tsx's ~8-minute segments) and
// returns the text. No DB write here at all; the client accumulates each
// chunk's text in order and only creates a real document (via the existing
// POST /api/documents route, sourceType='recording') once the whole
// recording is stopped and saved. See lib/recordingLimits.ts's header
// comment for why this route has no notion of a "recording session" and no
// per-session cap of its own.
//
// Same platform-hard-cap reasoning as app/api/documents/route.ts's
// MAX_PDF_BYTES: Vercel Functions cap request bodies at 4.5MB platform-wide,
// unconfigurable. 4MB leaves the same headroom for multipart/form-data
// boundary overhead MAX_PDF_BYTES does, so this route's own friendlier
// error fires before Vercel's opaque 413 would. components/
// lecture-recorder.tsx requests a 32kbps mono encoding specifically to keep
// a real ~8-minute chunk to roughly 1.9MB — this cap is deliberately NOT
// sized to that expected size, but to the platform ceiling, since a
// browser that doesn't honor the bitrate hint should get a clear message
// here rather than an opaque platform-level failure.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

// lib/audioTranscription.ts's own worst-case math: (OPENAI_MAX_RETRIES + 1)
// x OPENAI_TIMEOUT_MS = 2 x 60s = 120s for the transcription call itself,
// plus session/burst/budget overhead around it — 180s leaves real margin
// under the 300s Fluid Compute Hobby ceiling (see issue #24's own research,
// referenced in every other generation route's maxDuration comment) while
// still bounding a genuinely stuck request to a fraction of that ceiling.
export const maxDuration = 180

type ChunkFailureReason = Exclude<TranscribeChunkResult, { success: true }>['reason']

const REASON_STATUS: Record<ChunkFailureReason, number> = {
  not_configured: 503,
  empty_input: 422,
  invalid_response: 422,
  api_error: 502,
}

export async function POST(req: Request) {
  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId, plan } = session

  // Burst check first — cheap, content-independent, matches every other
  // generation route's ordering.
  const burst = await checkRecordingBurstLimit(userId)
  if (!burst.ok) {
    logger.warn({ userId, plan }, 'Recording-chunk transcription burst-limited')
    return NextResponse.json({ error: burst.reason }, { status: burst.status })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data with an "audio" field' }, { status: 400 })
  }

  const audio = formData.get('audio')
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: 'Missing "audio" field' }, { status: 400 })
  }
  if (audio.size > MAX_CHUNK_BYTES) {
    return NextResponse.json({ error: `Recording segment must be under ${MAX_CHUNK_BYTES / (1024 * 1024)}MB` }, { status: 400 })
  }
  if (audio.size === 0) {
    return NextResponse.json({ error: 'Recording segment is empty' }, { status: 400 })
  }

  // Only now, once the request is known to be a well-formed, in-budget
  // chunk actually worth sending to OpenAI, claim a unit of quota — same
  // "don't spend budget on a request that was never going to succeed"
  // ordering every other generation route in this codebase follows.
  const budget = await claimChunkTranscriptionBudget(userId, plan)
  if (!budget.ok) {
    logger.warn({ userId, plan }, 'Recording-chunk transcription budget limited')
    return NextResponse.json({ error: budget.reason }, { status: budget.status })
  }

  const result = await transcribeAudioChunk(audio)
  if (!result.success) {
    logger.warn({ userId, reason: result.reason }, 'Recording-chunk transcription failed')
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: REASON_STATUS[result.reason] })
  }

  logger.info({ userId, textLength: result.text.length }, 'Recording chunk transcribed')
  return NextResponse.json({ text: result.text }, { status: 200 })
}

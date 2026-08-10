import OpenAI from 'openai'
import { logger } from '@/lib/logger'

// Lecture recording (issue #42, direct Pranav-requested feature — the
// original Turbo AI core use case this product fast-follows). Transcribes
// one audio chunk of a lecture recording via OpenAI's audio transcription
// API. Deliberately NOT the forced-tool-use + zod pattern
// lib/notesGeneration.ts/lib/flashcardsGeneration.ts/lib/quizGeneration.ts
// use — those extract structured JSON from text; this is a plain
// audio-to-text call with no schema to force, so the surface is much
// simpler. Same typed-result-never-throws shape as those modules, though,
// for the same reason: a route calling this must never see an unhandled
// exception, including when OPENAI_API_KEY is unset.
//
// Why chunks, not one call per full recording: see
// components/lecture-recorder.tsx's header comment for the full client-side
// reasoning (Vercel's 4.5MB request-body cap is the real constraint). This
// module only ever sees one already-small chunk at a time — it has no
// concept of a "recording session" at all, that's assembled client-side.

export type TranscribeChunkResult =
  | { success: true; text: string }
  | {
      success: false
      reason: 'not_configured' | 'empty_input' | 'invalid_response' | 'api_error'
      message: string
    }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// gpt-4o-mini-transcribe, not the flagship gpt-4o-transcribe: confirmed a
// real model id against the installed openai package's own
// resources/audio/transcriptions.d.ts ("The options are gpt-4o-transcribe,
// gpt-4o-mini-transcribe, ..., whisper-1, ..."), not assumed. Matches this
// codebase's existing cost-conscious "-mini" convention for every other
// OpenAI call (lib/notesGeneration.ts/lib/flashcardsGeneration.ts/
// lib/quizGeneration.ts all use gpt-4o-mini for the same reason).
const MODEL = 'gpt-4o-mini-transcribe'

// A real transcription call (unlike the chat-completion calls elsewhere in
// this codebase) has to actually process audio, not just tokens — a
// generous per-attempt budget is warranted. Sized against
// app/api/documents/record-chunk/route.ts's maxDuration: worst case is
// (OPENAI_MAX_RETRIES + 1) x OPENAI_TIMEOUT_MS = 2 x 60s = 120s, leaving
// real margin under that route's 180s ceiling for session/rate-limit
// overhead alongside it.
const OPENAI_TIMEOUT_MS = 60_000
const OPENAI_MAX_RETRIES = 1

/**
 * Transcribes one audio chunk (webm/opus from the browser's MediaRecorder,
 * per components/lecture-recorder.tsx) to text. Never throws — every
 * failure mode, including OPENAI_API_KEY being unset, returns a typed
 * result, same convention as every other lib/*Generation.ts module.
 */
export async function transcribeAudioChunk(file: File): Promise<TranscribeChunkResult> {
  if (file.size === 0) {
    return {
      success: false,
      reason: 'empty_input',
      message: 'This recording segment is empty.',
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.warn('Lecture transcription requested but OPENAI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `Lecture transcription isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  try {
    const client = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES })
    const transcription = await client.audio.transcriptions.create({ file, model: MODEL })

    // response_format defaults to 'json' (unset above), so `transcription`
    // is the { text: string, ... } shape, not a raw string — verified
    // against the installed SDK's own create() overloads rather than
    // assumed. A near-silent segment (real room tone, nobody speaking) can
    // legitimately transcribe to an empty string; that's not an error, just
    // nothing said in this chunk, so it's returned as success with empty
    // text rather than treated as invalid_response.
    //
    // Note the boundary, established empirically during this ticket's
    // browser verification rather than assumed: that tolerance covers audio
    // that HAS frames but no speech. A segment with no audio frames at all
    // (pure digital silence encodes to a bare ~110-byte WebM header) is not
    // transcribed to empty — OpenAI rejects it with `400 Audio file might
    // be corrupted or unsupported`, which lands here as `api_error`. That
    // case is filtered out client-side before upload instead; see
    // components/lecture-recorder.tsx's MIN_SEGMENT_BYTES.
    if (typeof transcription.text !== 'string') {
      logger.warn('Lecture transcription: OpenAI response had no text field')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't transcribe this segment. ${FALLBACK_MESSAGE}`,
      }
    }

    return { success: true, text: transcription.text }
  } catch (err) {
    logger.error({ err }, 'Lecture transcription failed')
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong transcribing this segment. ${FALLBACK_MESSAGE}`,
    }
  }
}

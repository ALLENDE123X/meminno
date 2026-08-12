import { GoogleGenAI } from '@google/genai'
import { logger } from '@/lib/logger'

// MEM-014 (issue #49) — the audio half of the AI-podcast feature: turn
// MEM-013's speaker-tagged script into a real, playable audio file via
// Gemini's native multi-speaker TTS.
//
// This is the codebase's FIRST call to a billed vendor other than OpenAI,
// which is exactly why CLAUDE.md HARD STOP 6 now names Gemini too — see
// lib/podcastLimits.ts for the two-layer cap this call must sit behind, and
// for the real measured per-call cost that sized it.
//
// Same typed-result-never-throws contract as lib/audioTranscription.ts and
// the lib/*Generation.ts modules: a route calling this must never see an
// unhandled exception, including when GEMINI_API_KEY is unset. Deliberately
// NOT the forced-tool-use + zod machinery lib/notesGeneration.ts uses —
// there is no structured JSON to force out of a text-to-audio call.
//
// EVERYTHING BELOW WAS VERIFIED WITH REAL API CALLS during this ticket
// (real GEMINI_API_KEY, real audio returned), not read off a blog post:
// the model id and its `generateContent` support came from a live
// `GET /v1beta/models` listing, and the request/response shapes came from
// two real multi-speaker syntheses. Numbers quoted in the comments below are
// measurements from those runs.

/**
 * One speaker-tagged turn of a podcast script, as this module needs it.
 *
 * Deliberately NOT imported from `lib/podcastScript.ts`, even though MEM-013
 * has since merged and exports its own `PodcastScriptTurn`. Two reasons:
 *
 * 1. MEM-013's type narrows `speaker` to the literal union `'A' | 'B'`. This
 *    module genuinely does not care what the labels are — it reads the
 *    distinct labels out of the turns themselves and maps them to voices in
 *    order of first appearance — so binding to that union would couple
 *    synthesis to a naming choice that belongs to script generation.
 * 2. Keeping the dependency one-directional (MEM-015 wires the two together;
 *    neither half imports the other) means either can change independently.
 *
 * MEM-013's `PodcastScriptTurn` is assignable to this type (`'A' | 'B'` is a
 * subtype of `string`), so `generatePodcastAudio(script.turns)` type-checks
 * with no adapter. Named `PodcastAudioTurn` rather than `PodcastScriptTurn`
 * specifically so MEM-015 can import from both modules without a collision or
 * an alias.
 */
export type PodcastAudioTurn = { speaker: string; text: string }

export type GeneratePodcastAudioResult =
  | {
      success: true
      /** A complete, playable RIFF/WAVE file (header + PCM), not raw samples. */
      audio: Buffer
      mimeType: typeof PODCAST_AUDIO_MIME_TYPE
      /** Wall-clock length of the synthesized audio, for `podcasts.durationSeconds`. */
      durationSeconds: number
    }
  | {
      success: false
      // `empty_input` means there was nothing to say at all; `invalid_script`
      // means there WAS content but its shape is unusable (not exactly two
      // speakers). Kept as separate discriminators because they are different
      // failures with different fixes: the first is a caller/user-facing empty
      // state, the second is an upstream generation bug worth surfacing
      // distinctly in MEM-015's routing and logs.
      reason: 'not_configured' | 'empty_input' | 'invalid_script' | 'script_too_long' | 'invalid_response' | 'api_error'
      message: string
    }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// Confirmed a real, currently-live model id by listing GET /v1beta/models
// against the real API with this project's own key, not by trusting a doc
// page: `models/gemini-2.5-flash-preview-tts`, supportedGenerationMethods
// includes `generateContent`. Two sibling TTS models are also live
// (`gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview`) and
// `gemini-3.1-flash-tts-preview` was separately live-tested to accept this
// exact multi-speaker config unchanged, so switching is a one-constant edit.
// This one is chosen because it is the cheapest of the three by 2x on both
// sides of the meter ($0.50/1M text input + $10/1M audio output, vs $1/$20
// for both others) and because cost is the whole reason HARD STOP 6 exists.
// All three are preview-tier, so treat this constant as something to
// re-verify against a live model listing if calls ever start 404ing.
const MODEL = 'gemini-2.5-flash-preview-tts'

// Two real prebuilt voice names from Gemini's documented 30-voice set, and
// the exact pair the official multi-speaker example uses. Picked for maximum
// separability rather than taste: a listener has to be able to tell who is
// talking with no visual cue at all, so the two voices differ in register
// and delivery rather than being two variations of the same read. Both were
// live-tested in this ticket's real synthesis runs.
export const PODCAST_VOICE_A = 'Kore'
export const PODCAST_VOICE_B = 'Puck'

// Gemini's multi-speaker TTS supports EXACTLY two speakers — the SDK's own
// MultiSpeakerVoiceConfig type says so verbatim ("Exactly two speaker voice
// configurations must be provided"). A script with one speaker or three is
// a real MEM-013 bug, not something to paper over by dropping turns.
const REQUIRED_SPEAKER_COUNT = 2

// Sized from a real measurement, not a guess. A genuine 831-word / 5,220-char
// two-speaker script synthesized to 4.63 minutes of audio in 144 seconds of
// wall clock — call it ~28ms of latency per character. 7,000 characters is
// therefore roughly a 6.2-minute podcast taking ~195s, staying comfortably
// under GEMINI_TIMEOUT_MS below. It is nowhere near the model's own 8k-token
// input ceiling (5,220 chars measured as 1,207 input tokens), so latency and
// cost, not context, are what this bound exists for.
//
// This same 831-word/5,220-char sample (~6.28 chars/word for real spoken
// dialogue, including this module's own "A: "/"B: " speaker-prefix and
// newline formatting overhead) is also the real-world evidence
// lib/podcastScript.ts's MAX_TOTAL_WORDS is now sized against (issue #63,
// 2026-08-11 post-ship fix) — see that constant's comment for the full
// derivation. Exported (rather than kept module-private) specifically so
// tests/unit/podcastScript.test.ts can assert that invariant directly
// against this real constant instead of a hardcoded literal that could
// silently drift. Do NOT raise this value to "fix" a script-too-long
// rejection instead of lowering the word ceiling upstream — it is sized
// against the hard Vercel maxDuration ceiling documented below, not against
// script length.
export const MAX_SCRIPT_CHARS = 7_000

// 240s per attempt. Unusually long for this codebase (lib/audioTranscription.ts
// uses 60s, the text-generation modules 20s) because TTS latency scales with
// the length of the audio being produced, and the measured rate is ~31s of
// wall clock per minute of finished audio. A 7-minute podcast is a genuinely
// multi-minute request.
//
// READ THIS BEFORE WIRING THE ROUTE (MEM-015): at these latencies a
// synchronous serverless request is close to its ceiling. The route needs an
// explicit `maxDuration` of at least 300 (not the 60/120 the other AI routes
// use), and if podcasts get longer than this module's cap allows, the honest
// answer is a background job rather than a bigger timeout.
const GEMINI_TIMEOUT_MS = 240_000

// The SDK retries FIVE times by default (its own HttpRetryOptions doc:
// "If not specified, default to 5"). On a 240-second call that is a
// 20-minute worst case, and each attempt that reaches the model is billed
// audio output. One attempt only: a failure surfaces as a typed api_error
// immediately, and the caller decides whether to retry, having already
// spent exactly one unit of the daily budget for it.
const GEMINI_MAX_ATTEMPTS = 1

/** The container this module always produces. See wrapPcmInWavContainer(). */
export const PODCAST_AUDIO_MIME_TYPE = 'audio/wav' as const

/** Matching file extension, used by lib/podcastStorage.ts's path convention. */
export const PODCAST_AUDIO_FILE_EXTENSION = 'wav' as const

// Defaults matching what the API actually returned in this ticket's live
// runs; only used if the response's own mimeType omits a field.
const DEFAULT_SAMPLE_RATE = 24_000
const DEFAULT_CHANNELS = 1
const DEFAULT_BITS_PER_SAMPLE = 16

type PcmFormat = { sampleRate: number; channels: number; bitsPerSample: number }

/**
 * Gemini's TTS response is RAW PCM, not a playable container, and the
 * mimeType announcing that is not formatted consistently across models.
 * Both of these came back from real calls in this ticket:
 *
 *   gemini-2.5-flash-preview-tts -> "audio/L16;codec=pcm;rate=24000"
 *   gemini-3.1-flash-tts-preview -> "audio/l16; rate=24000; channels=1"
 *
 * Different casing, different spacing, different fields present. So parse
 * tolerantly and fall back to the observed defaults rather than pattern
 * matching one exact string. The `L16` token is itself the bit depth.
 */
export function parsePcmMimeType(mimeType: string | undefined): PcmFormat {
  const raw = mimeType ?? ''
  const rate = /rate=(\d+)/i.exec(raw)
  const channels = /channels=(\d+)/i.exec(raw)
  const bits = /\bl(\d+)\b/i.exec(raw)

  return {
    sampleRate: rate ? Number(rate[1]) : DEFAULT_SAMPLE_RATE,
    channels: channels ? Number(channels[1]) : DEFAULT_CHANNELS,
    bitsPerSample: bits ? Number(bits[1]) : DEFAULT_BITS_PER_SAMPLE,
  }
}

/**
 * Prepends a canonical 44-byte RIFF/WAVE header to raw little-endian PCM.
 *
 * This function is the difference between a feature that works and one that
 * silently doesn't: handing the raw response bytes to a browser `<audio>`
 * element, or storing them as `.wav`, produces a file that every player
 * refuses, because there is no container telling it the sample rate, channel
 * count, or bit depth. Gemini returns samples only.
 *
 * WAV (not MP3/AAC) because it is the only format reachable without adding a
 * native audio encoder to this project, and it plays natively in every
 * browser. The cost is size: uncompressed 24kHz/16-bit mono is ~2.9MB per
 * minute, so a 7-minute podcast is a ~20MB object. That is fine for Supabase
 * Storage and for a signed-URL download, but it is a real number worth
 * knowing — see ARCHITECTURE.md for the compression follow-up.
 */
export function wrapPcmInWavContainer(pcm: Buffer, format: PcmFormat): Buffer {
  const { sampleRate, channels, bitsPerSample } = format
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4) // total file size minus the 8 bytes before this field
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk is 16 bytes
  header.writeUInt16LE(1, 20) // audio format 1 = uncompressed PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm])
}

/**
 * Cleans one turn's text before it is handed to the TTS API.
 *
 * Two jobs:
 *
 * 1. **Strip bracketed stage directions** ("[laughs]", "[pause]", "[upbeat]").
 *    MEM-013's generator is prompted not to emit these and, per its own
 *    review, did not in real runs — but that is a prompt instruction, not a
 *    guarantee, and the failure mode here is loud and shipped: this model has
 *    no expressive-tag feature, so a stray "[laughs]" is simply READ ALOUD in
 *    a finished podcast. Cheap insurance at the last point before synthesis,
 *    where it holds regardless of which upstream produced the script.
 * 2. **Collapse whitespace**, so a newline inside one turn cannot masquerade
 *    as the start of another speaker's line in the transcript below.
 *
 * THE MATCH IS DELIBERATELY NARROW, and the bias is toward stripping too
 * little rather than too much. This is a study app: a podcast about
 * programming or maths legitimately contains bracket notation, and a naive
 * `\[.*?\]` turns "the array `a[0]`" into "the array a" — silently corrupting
 * real course material, which is a far worse outcome than one stray "[laughs]"
 * being read aloud. So a span only counts as a stage direction when all of
 * these hold:
 *
 *   - it starts at the beginning of the text or after whitespace, which rules
 *     out every subscript/index form (`a[0]`, `x[i]`, `arr[idx]`) since those
 *     attach directly to an identifier with no space;
 *   - its first token is at least three letters, which rules out short index
 *     variables written with a space ("the value [i]");
 *   - it contains only letters, spaces, apostrophes and hyphens — no digits
 *     and no operators, so `[n+1]` and `[0]` are never touched.
 *
 * An unclosed `[` with no matching bracket is likewise left alone: eating
 * everything after a stray bracket would destroy real dialogue.
 *
 * Idempotent: running it twice changes nothing.
 */
const STAGE_DIRECTION_PATTERN = /(^|\s)\[[A-Za-z]{3,}[A-Za-z '-]*\]/g

export function stripStageDirections(text: string): string {
  return text
    .replace(STAGE_DIRECTION_PATTERN, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Renders the script into the single text input Gemini's multi-speaker mode
 * expects: a `Speaker: line` transcript, prefixed with an instruction naming
 * both speakers. The speaker labels here MUST match the `speaker` values in
 * speakerVoiceConfigs, which is why both are derived from the same list.
 */
export function buildMultiSpeakerPrompt(turns: PodcastAudioTurn[], speakers: string[]): string {
  const transcript = turns.map((turn) => `${turn.speaker}: ${stripStageDirections(turn.text)}`).join('\n')
  return `TTS the following conversation between ${speakers[0]} and ${speakers[1]}:\n${transcript}`
}

/** Distinct speaker labels, in order of first appearance. */
function distinctSpeakers(turns: PodcastAudioTurn[]): string[] {
  return [...new Set(turns.map((turn) => turn.speaker))]
}

/**
 * Synthesizes a two-speaker podcast script into a single playable WAV file.
 * Never throws.
 */
export async function generatePodcastAudio(turns: PodcastAudioTurn[]): Promise<GeneratePodcastAudioResult> {
  // Sanitize first, then drop anything left empty — a turn that was nothing
  // but a stage direction ("[both laugh]") has no speech in it and should not
  // reach the model as a bare "Alex:" line.
  const usableTurns = turns
    .map((turn) => ({ speaker: turn.speaker, text: stripStageDirections(turn.text) }))
    .filter((turn) => turn.text.length > 0)
  if (usableTurns.length === 0) {
    return { success: false, reason: 'empty_input', message: 'This podcast script is empty.' }
  }

  const speakers = distinctSpeakers(usableTurns)
  if (speakers.length !== REQUIRED_SPEAKER_COUNT) {
    logger.warn({ speakerCount: speakers.length }, 'Podcast script does not have exactly two speakers')
    return {
      success: false,
      reason: 'invalid_script',
      message: `Couldn't turn this script into audio. ${FALLBACK_MESSAGE}`,
    }
  }

  const prompt = buildMultiSpeakerPrompt(usableTurns, speakers)
  if (prompt.length > MAX_SCRIPT_CHARS) {
    logger.warn({ promptChars: prompt.length }, 'Podcast script exceeds the synthesizable length cap')
    return {
      success: false,
      reason: 'script_too_long',
      message: `This script is too long to turn into audio. ${FALLBACK_MESSAGE}`,
    }
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    logger.warn('Podcast audio requested but GEMINI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `Podcast audio isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  try {
    // Inline client construction with an explicit timeout/retry budget, same
    // convention as lib/audioTranscription.ts — no module-level client, so an
    // unset key can never blow up at import time.
    const ai = new GoogleGenAI({ apiKey })
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              { speaker: speakers[0], voiceConfig: { prebuiltVoiceConfig: { voiceName: PODCAST_VOICE_A } } },
              { speaker: speakers[1], voiceConfig: { prebuiltVoiceConfig: { voiceName: PODCAST_VOICE_B } } },
            ],
          },
        },
        httpOptions: { timeout: GEMINI_TIMEOUT_MS, retryOptions: { attempts: GEMINI_MAX_ATTEMPTS } },
      },
    })

    const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData
    if (!inlineData?.data) {
      logger.warn({ finishReason: response.candidates?.[0]?.finishReason }, 'Gemini TTS response contained no audio data')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't turn this script into audio. ${FALLBACK_MESSAGE}`,
      }
    }

    const format = parsePcmMimeType(inlineData.mimeType)
    const pcm = Buffer.from(inlineData.data, 'base64')
    if (pcm.length === 0) {
      logger.warn('Gemini TTS response decoded to zero audio bytes')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't turn this script into audio. ${FALLBACK_MESSAGE}`,
      }
    }

    const bytesPerFrame = (format.channels * format.bitsPerSample) / 8
    return {
      success: true,
      audio: wrapPcmInWavContainer(pcm, format),
      mimeType: PODCAST_AUDIO_MIME_TYPE,
      durationSeconds: Math.round(pcm.length / (format.sampleRate * bytesPerFrame)),
    }
  } catch (err) {
    logger.error({ err }, 'Gemini podcast audio generation failed')
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong making this podcast. ${FALLBACK_MESSAGE}`,
    }
  }
}

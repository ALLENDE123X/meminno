import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockGenerateContent = vi.fn()
const constructorCalls: Array<Record<string, unknown>> = []

// Same class-mock pattern as tests/unit/audioTranscription.test.ts, exposing
// `.models.generateContent` instead of `.audio.transcriptions.create`.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent }
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options)
    }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  generatePodcastAudio,
  parsePcmMimeType,
  wrapPcmInWavContainer,
  buildMultiSpeakerPrompt,
  stripStageDirections,
  PODCAST_VOICE_A,
  PODCAST_VOICE_B,
} from '@/lib/podcastAudio'

const SCRIPT = [
  { speaker: 'Alex', text: 'Welcome back, today we are talking about mitochondria.' },
  { speaker: 'Sam', text: 'The powerhouse of the cell, but there is more to it.' },
  { speaker: 'Alex', text: 'Right, so what is actually happening in there?' },
]

/** 24kHz/16-bit/mono PCM: 48,000 bytes is exactly one second of audio. */
function fakePcmBase64(bytes: number): string {
  return Buffer.alloc(bytes, 1).toString('base64')
}

function audioResponse(bytes: number, mimeType = 'audio/L16;codec=pcm;rate=24000') {
  return {
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data: fakePcmBase64(bytes) } }] }, finishReason: 'STOP' }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  constructorCalls.length = 0
  delete process.env.GEMINI_API_KEY
})

describe('generatePodcastAudio', () => {
  it('returns not_configured when GEMINI_API_KEY is unset, without calling Gemini', async () => {
    const result = await generatePodcastAudio(SCRIPT)

    expect(result).toEqual({ success: false, reason: 'not_configured', message: expect.stringContaining("isn't available") })
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('returns empty_input for an empty script, without calling Gemini', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'

    const result = await generatePodcastAudio([])

    expect(result).toEqual({ success: false, reason: 'empty_input', message: expect.stringContaining('empty') })
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('treats a script of whitespace-only turns as empty', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'

    const result = await generatePodcastAudio([
      { speaker: 'Alex', text: '   ' },
      { speaker: 'Sam', text: '' },
    ])

    expect(result).toEqual({ success: false, reason: 'empty_input', message: expect.stringContaining('empty') })
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('refuses a script that does not have exactly two speakers', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'

    const oneSpeaker = await generatePodcastAudio([{ speaker: 'Alex', text: 'A monologue, not a podcast.' }])
    const threeSpeakers = await generatePodcastAudio([...SCRIPT, { speaker: 'Jordan', text: 'A third voice.' }])

    expect(oneSpeaker).toMatchObject({ success: false, reason: 'empty_input' })
    expect(threeSpeakers).toMatchObject({ success: false, reason: 'empty_input' })
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('returns script_too_long past the character cap, without calling Gemini', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'

    const result = await generatePodcastAudio([
      { speaker: 'Alex', text: 'a'.repeat(6_000) },
      { speaker: 'Sam', text: 'b'.repeat(6_000) },
    ])

    expect(result).toEqual({ success: false, reason: 'script_too_long', message: expect.stringContaining('too long') })
    expect(mockGenerateContent).not.toHaveBeenCalled()
  })

  it('synthesizes successfully and returns a playable WAV with a real duration', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockResolvedValue(audioResponse(48_000 * 5)) // 5 seconds

    const result = await generatePodcastAudio(SCRIPT)

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.mimeType).toBe('audio/wav')
    expect(result.durationSeconds).toBe(5)
    // 44-byte RIFF header prepended to the decoded PCM, not the raw bytes.
    expect(result.audio.length).toBe(44 + 48_000 * 5)
    expect(result.audio.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(result.audio.subarray(8, 12).toString('ascii')).toBe('WAVE')
  })

  it('sends the documented multi-speaker request shape, mapping both speakers to distinct voices', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockResolvedValue(audioResponse(48_000))

    await generatePodcastAudio(SCRIPT)

    expect(constructorCalls).toEqual([{ apiKey: 'gemini-test' }])
    const request = mockGenerateContent.mock.calls[0][0]
    expect(request.model).toBe('gemini-2.5-flash-preview-tts')
    expect(request.config.responseModalities).toEqual(['AUDIO'])
    expect(request.config.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs).toEqual([
      { speaker: 'Alex', voiceConfig: { prebuiltVoiceConfig: { voiceName: PODCAST_VOICE_A } } },
      { speaker: 'Sam', voiceConfig: { prebuiltVoiceConfig: { voiceName: PODCAST_VOICE_B } } },
    ])
    expect(PODCAST_VOICE_A).not.toBe(PODCAST_VOICE_B)
  })

  it('never sends a bracketed stage direction to the model, and drops turns made only of one', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockResolvedValue(audioResponse(48_000))

    await generatePodcastAudio([
      { speaker: 'Alex', text: '[laughs] So, mitochondria.' },
      { speaker: 'Sam', text: '[both laugh]' },
      { speaker: 'Sam', text: 'The powerhouse line, yes.' },
    ])

    const sentText = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text
    expect(sentText).not.toContain('[')
    expect(sentText).not.toContain('laughs')
    // The direction-only turn produced no bare "Sam:" line of its own.
    expect(sentText.split('\n')).toHaveLength(3) // instruction + two real turns
  })

  it('pins the timeout and the no-retry budget, since the SDK default is five attempts', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockResolvedValue(audioResponse(48_000))

    await generatePodcastAudio(SCRIPT)

    expect(mockGenerateContent.mock.calls[0][0].config.httpOptions).toEqual({
      timeout: 240_000,
      retryOptions: { attempts: 1 },
    })
  })

  it('returns invalid_response when the reply carries no audio data', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'sorry' }] }, finishReason: 'STOP' }] })

    const result = await generatePodcastAudio(SCRIPT)

    expect(result).toEqual({ success: false, reason: 'invalid_response', message: expect.stringContaining("Couldn't turn this script") })
  })

  it('returns invalid_response when the audio decodes to zero bytes', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockResolvedValue(audioResponse(0))

    const result = await generatePodcastAudio(SCRIPT)

    expect(result).toMatchObject({ success: false, reason: 'invalid_response' })
  })

  it('returns api_error and logs when the Gemini call throws', async () => {
    process.env.GEMINI_API_KEY = 'gemini-test'
    mockGenerateContent.mockRejectedValue(new Error('upstream exploded'))

    const result = await generatePodcastAudio(SCRIPT)

    expect(result).toEqual({ success: false, reason: 'api_error', message: expect.stringContaining('Something went wrong') })
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('parsePcmMimeType', () => {
  // Both strings below are verbatim from real API responses captured during
  // this ticket - different casing, spacing and fields between two models.
  it('parses the gemini-2.5 form', () => {
    expect(parsePcmMimeType('audio/L16;codec=pcm;rate=24000')).toEqual({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 })
  })

  it('parses the gemini-3.1 form, including an explicit channel count', () => {
    expect(parsePcmMimeType('audio/l16; rate=24000; channels=1')).toEqual({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 })
  })

  it('honours a non-default sample rate and channel count', () => {
    expect(parsePcmMimeType('audio/L16;rate=48000;channels=2')).toEqual({ sampleRate: 48_000, channels: 2, bitsPerSample: 16 })
  })

  it('falls back to the observed defaults when the mimeType is missing', () => {
    expect(parsePcmMimeType(undefined)).toEqual({ sampleRate: 24_000, channels: 1, bitsPerSample: 16 })
  })
})

describe('wrapPcmInWavContainer', () => {
  it('writes a canonical 44-byte RIFF/WAVE header describing the PCM that follows', () => {
    const pcm = Buffer.alloc(48_000, 7)

    const wav = wrapPcmInWavContainer(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 })

    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16) // PCM fmt chunk size
    expect(wav.readUInt16LE(20)).toBe(1) // uncompressed PCM
    expect(wav.readUInt16LE(22)).toBe(1) // channels
    expect(wav.readUInt32LE(24)).toBe(24_000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(48_000) // byte rate
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    expect(wav.subarray(44)).toEqual(pcm)
  })

  it('derives byte rate and block align from stereo/48kHz too', () => {
    const wav = wrapPcmInWavContainer(Buffer.alloc(8), { sampleRate: 48_000, channels: 2, bitsPerSample: 16 })

    expect(wav.readUInt16LE(32)).toBe(4) // 2 channels x 2 bytes
    expect(wav.readUInt32LE(28)).toBe(48_000 * 4)
  })
})

describe('buildMultiSpeakerPrompt', () => {
  it('renders the Speaker: line transcript Gemini expects, naming both speakers up front', () => {
    const prompt = buildMultiSpeakerPrompt(SCRIPT, ['Alex', 'Sam'])

    expect(prompt.split('\n')[0]).toBe('TTS the following conversation between Alex and Sam:')
    expect(prompt).toContain('Alex: Welcome back, today we are talking about mitochondria.')
    expect(prompt).toContain('Sam: The powerhouse of the cell, but there is more to it.')
  })

  it('strips bracketed stage directions before they reach the model', () => {
    const prompt = buildMultiSpeakerPrompt(
      [
        { speaker: 'Alex', text: '[laughs] Right, so what is it? [pause]' },
        { speaker: 'Sam', text: 'The powerhouse line.' },
      ],
      ['Alex', 'Sam']
    )

    expect(prompt).not.toContain('[')
    expect(prompt).toContain('Alex: Right, so what is it?')
  })

  it('collapses whitespace so a newline inside a turn cannot fake a speaker change', () => {
    const prompt = buildMultiSpeakerPrompt(
      [
        { speaker: 'Alex', text: 'first line\nSam: not really Sam' },
        { speaker: 'Sam', text: 'second' },
      ],
      ['Alex', 'Sam']
    )

    expect(prompt.split('\n')).toHaveLength(3) // instruction + exactly two turns
  })
})

describe('stripStageDirections', () => {
  // MEM-013 is prompted not to emit these and did not in its reviewer's real
  // runs, but that is a prompt instruction rather than a guarantee, and this
  // model has no expressive-tag feature - a stray "[laughs]" would simply be
  // read aloud in a shipped podcast. Enforced here, at the last point before
  // synthesis, so it holds whatever produced the script.
  it('removes bracketed directions anywhere in the line', () => {
    expect(stripStageDirections('[laughs] Sure. [beat] Where were we?')).toBe('Sure. Where were we?')
  })

  it('leaves ordinary dialogue untouched', () => {
    expect(stripStageDirections('The mitochondria is the powerhouse of the cell.')).toBe(
      'The mitochondria is the powerhouse of the cell.'
    )
  })

  it('reduces a turn that is nothing but a direction to an empty string', () => {
    expect(stripStageDirections('[both laugh]')).toBe('')
  })

  it('leaves an unclosed bracket alone rather than eating the rest of the line', () => {
    expect(stripStageDirections('Wait [ what about ATP?')).toBe('Wait [ what about ATP?')
  })

  it('is idempotent', () => {
    const once = stripStageDirections('[sighs]  So,   ATP.')
    expect(stripStageDirections(once)).toBe(once)
  })
})

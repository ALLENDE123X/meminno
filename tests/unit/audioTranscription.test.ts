import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockCreate = vi.fn()
const constructorCalls: Array<Record<string, unknown>> = []

// Same class-mock pattern as tests/unit/notesGeneration.test.ts, exposing
// `.audio.transcriptions.create` instead of `.chat.completions.create`.
vi.mock('openai', () => ({
  default: class MockOpenAI {
    audio = { transcriptions: { create: mockCreate } }
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options)
    }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { transcribeAudioChunk } from '@/lib/audioTranscription'

function makeFile(bytes = 100): File {
  return new File([new Uint8Array(bytes)], 'segment-0.webm', { type: 'audio/webm' })
}

beforeEach(() => {
  vi.clearAllMocks()
  constructorCalls.length = 0
  delete process.env.OPENAI_API_KEY
})

describe('transcribeAudioChunk', () => {
  it('returns not_configured when OPENAI_API_KEY is unset, without calling OpenAI', async () => {
    const result = await transcribeAudioChunk(makeFile())

    expect(result).toEqual({ success: false, reason: 'not_configured', message: expect.stringContaining("isn't available") })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns empty_input for a zero-byte file, without calling OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'

    const result = await transcribeAudioChunk(makeFile(0))

    expect(result).toEqual({ success: false, reason: 'empty_input', message: expect.stringContaining('empty') })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('transcribes successfully and returns the text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    mockCreate.mockResolvedValue({ text: 'the mitochondria is the powerhouse of the cell' })

    const result = await transcribeAudioChunk(makeFile())

    expect(result).toEqual({ success: true, text: 'the mitochondria is the powerhouse of the cell' })
    expect(mockCreate).toHaveBeenCalledWith({ file: expect.any(File), model: 'gpt-4o-mini-transcribe' })
  })

  it('treats an empty-string transcription (silence) as a real success, not invalid_response', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    mockCreate.mockResolvedValue({ text: '' })

    const result = await transcribeAudioChunk(makeFile())

    expect(result).toEqual({ success: true, text: '' })
  })

  it('returns invalid_response when the OpenAI response has no text field', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    mockCreate.mockResolvedValue({})

    const result = await transcribeAudioChunk(makeFile())

    expect(result).toEqual({ success: false, reason: 'invalid_response', message: expect.stringContaining("Couldn't transcribe") })
  })

  it('returns api_error and logs when the OpenAI call throws', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    mockCreate.mockRejectedValue(new Error('network down'))

    const result = await transcribeAudioChunk(makeFile())

    expect(result).toEqual({ success: false, reason: 'api_error', message: expect.stringContaining('Something went wrong') })
    expect(logger.error).toHaveBeenCalled()
  })

  it('constructs the OpenAI client with the documented timeout/retry budget', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    mockCreate.mockResolvedValue({ text: 'ok' })

    await transcribeAudioChunk(makeFile())

    expect(constructorCalls).toEqual([{ apiKey: 'sk-test', timeout: 60_000, maxRetries: 1 }])
  })
})

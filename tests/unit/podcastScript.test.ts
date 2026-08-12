import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockCreate = vi.fn()
// Issue #24 (maxDuration audit) pattern, mirrored from
// tests/unit/notesGeneration.test.ts / tests/unit/quizGeneration.test.ts:
// captures every `new OpenAI(...)` constructor call's options so tests can
// assert the client-side timeout/retry budget without needing a real
// slow/hung network call.
const constructorCalls: Array<Record<string, unknown>> = []

// Mirrors tests/unit/notesGeneration.test.ts's / tests/unit/quizGeneration.test.ts's
// pattern for mocking a class-based SDK client: the `openai` module's
// default export is a constructor; `new OpenAI(...)` must return an object
// exposing `.chat.completions.create`.
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } }
    constructor(options: Record<string, unknown>) {
      constructorCalls.push(options)
    }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// Imported after the mocks above so the module under test picks up the
// mocked openai constructor.
import { generatePodcastScriptFromText, generatedPodcastScriptSchema } from '@/lib/podcastScript'

function toolCallResponse(input: Record<string, unknown>) {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'generate_podcast_script', arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  }
}

// ~900 words split across alternating A/B turns with real backchanneling -
// deliberately within both the MIN_TURNS/MAX_TURNS and
// MIN_TOTAL_WORDS/MAX_TOTAL_WORDS sanity bounds so it represents a genuinely
// valid script, not just a minimal one.
function makeValidTurns(turnCount = 24, wordsPerLongTurn = 45) {
  const turns: Array<{ speaker: 'A' | 'B'; text: string }> = []
  for (let i = 0; i < turnCount; i++) {
    const speaker: 'A' | 'B' = i % 2 === 0 ? 'A' : 'B'
    // Alternate short reactions and longer explanations, like a real
    // conversation - mirrors the system prompt's own "varying turn length"
    // instruction rather than uniform turns.
    const text =
      i % 4 === 1
        ? 'Oh interesting, wait really?'
        : Array.from({ length: wordsPerLongTurn }, (_, w) => `word${w}`).join(' ')
    turns.push({ speaker, text })
  }
  return turns
}

const VALID_SCRIPT = { turns: makeValidTurns() }

describe('generatedPodcastScriptSchema', () => {
  it('accepts a fully valid script', () => {
    expect(generatedPodcastScriptSchema.safeParse(VALID_SCRIPT).success).toBe(true)
  })

  it('rejects a script with fewer than 10 turns', () => {
    expect(
      generatedPodcastScriptSchema.safeParse({
        turns: [
          { speaker: 'A', text: 'Hey, welcome.' },
          { speaker: 'B', text: 'Thanks for having me.' },
        ],
      }).success
    ).toBe(false)
  })

  it('rejects a script with more than 200 turns', () => {
    const turns = Array.from({ length: 201 }, (_, i) => ({
      speaker: i % 2 === 0 ? ('A' as const) : ('B' as const),
      text: 'short line',
    }))
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a script where only speaker A ever talks (a monologue, not a conversation)', () => {
    const turns = Array.from({ length: 12 }, () => ({ speaker: 'A' as const, text: 'Just me talking here.' }))
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a script where only speaker B ever talks', () => {
    const turns = Array.from({ length: 12 }, () => ({ speaker: 'B' as const, text: 'Just me talking here.' }))
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a script that is far too short to be podcast-length (well under 400 words)', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({
      speaker: i % 2 === 0 ? ('A' as const) : ('B' as const),
      text: 'hi',
    }))
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a script that is far too long to be podcast-length (well over 1600 words)', () => {
    const longText = Array.from({ length: 200 }, (_, w) => `word${w}`).join(' ')
    const turns = Array.from({ length: 12 }, (_, i) => ({
      speaker: i % 2 === 0 ? ('A' as const) : ('B' as const),
      text: longText,
    }))
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a turn with an invalid speaker label', () => {
    const turns = makeValidTurns()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(turns[0] as any).speaker = 'C'
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a turn missing its text', () => {
    const turns = makeValidTurns().map((t) => ({ ...t })) as Array<Record<string, unknown>>
    delete turns[0].text
    expect(generatedPodcastScriptSchema.safeParse({ turns }).success).toBe(false)
  })

  it('rejects a missing/malformed shape entirely', () => {
    expect(generatedPodcastScriptSchema.safeParse(null).success).toBe(false)
    expect(generatedPodcastScriptSchema.safeParse('not an object').success).toBe(false)
    expect(generatedPodcastScriptSchema.safeParse({}).success).toBe(false)
  })
})

describe('generatePodcastScriptFromText', () => {
  const ORIGINAL_ENV = process.env.OPENAI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    constructorCalls.length = 0
    process.env.OPENAI_API_KEY = ORIGINAL_ENV
  })

  it('fails gracefully with reason "not_configured" when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY
    const result = await generatePodcastScriptFromText('Some lecture notes about photosynthesis.')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('not_configured')
      expect(result.message).toMatch(/isn't available/i)
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('fails gracefully with reason "empty_input" for blank/whitespace-only text, without calling OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const result = await generatePodcastScriptFromText('   \n\t  ')

    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('empty_input')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('generates and validates a two-speaker podcast script from real document text', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_SCRIPT))

    const result = await generatePodcastScriptFromText('Raw lecture transcript about photosynthesis...')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.turns.length).toBeGreaterThanOrEqual(10)
      expect(result.data.turns.some((t) => t.speaker === 'A')).toBe(true)
      expect(result.data.turns.some((t) => t.speaker === 'B')).toBe(true)
    }

    // Forced tool-use with structured outputs, not free-text generation.
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tool_choice).toEqual({ type: 'function', function: { name: 'generate_podcast_script' } })
    expect(callArgs.model).toBe('gpt-5.6-luna')
    expect(callArgs.messages[1].content).toContain('photosynthesis')
  })

  it('requests OpenAI structured-outputs strict mode with a strict-compliant schema', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_SCRIPT))

    await generatePodcastScriptFromText('some source text')

    const callArgs = mockCreate.mock.calls[0][0]
    const tool = callArgs.tools[0]
    expect(tool.function.strict).toBe(true)
    expect(tool.function.parameters.additionalProperties).toBe(false)
    expect(tool.function.parameters.properties.turns.items.additionalProperties).toBe(false)
    expect(tool.function.parameters.properties.turns.items.required).toEqual(
      expect.arrayContaining(['speaker', 'text'])
    )
  })

  // Real finding from a live smoke-test call against the actual OpenAI API
  // during MEM-013 (see lib/podcastScript.ts's REASONING_EFFORT comment for
  // the full write-up): gpt-5.6-luna is a reasoning model, and
  // /v1/chat/completions rejects any request that combines forced tool-use
  // with reasoning enabled (`400 Function tools with reasoning_effort are
  // not supported...`) unless `reasoning_effort: 'none'` is passed. Every
  // mocked test above would still pass even if this regressed, since the
  // mock doesn't validate request shape against the real API - this test
  // exists specifically to pin the one param that made this module's forced
  // tool-use actually work end to end, not just in mocked tests.
  it('sets reasoning_effort to "none" so forced tool-use works with a reasoning-tier model', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_SCRIPT))

    await generatePodcastScriptFromText('some source text')

    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.reasoning_effort).toBe('none')
  })

  it('truncates unusually long source text before sending it to OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_SCRIPT))

    const hugeText = 'a'.repeat(200_000)
    await generatePodcastScriptFromText(hugeText)

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage.length).toBeLessThan(hugeText.length)
    expect(userMessage.length).toBeLessThanOrEqual(60_000)
  })

  it('fails gracefully when the model returns a script with too few turns (malformed tool-call response)', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(
      toolCallResponse({
        turns: [
          { speaker: 'A', text: 'Hey, welcome.' },
          { speaker: 'B', text: 'Thanks for having me.' },
        ],
      })
    )

    const result = await generatePodcastScriptFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when the model collapses to a single-speaker monologue (malformed tool-call response)', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const turns = Array.from({ length: 12 }, () => ({ speaker: 'A', text: 'Just me, talking the whole time here.' }))
    mockCreate.mockResolvedValueOnce(toolCallResponse({ turns }))

    const result = await generatePodcastScriptFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when OpenAI does not return a tool call', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { content: 'huh?', tool_calls: undefined } }],
    })

    const result = await generatePodcastScriptFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when the tool call arguments are not valid JSON', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'generate_podcast_script', arguments: '{not valid json' },
              },
            ],
          },
        },
      ],
    })

    const result = await generatePodcastScriptFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully on an API/network error, without crashing', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockRejectedValueOnce(new Error('network down'))

    const result = await generatePodcastScriptFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('api_error')
    expect(logger.error).toHaveBeenCalled()
  })

  // Issue #24 (maxDuration audit) pattern: pins that the client is actually
  // constructed with a tight, explicit budget rather than relying on the
  // openai SDK's own (much longer) defaults - see lib/podcastScript.ts's own
  // OPENAI_TIMEOUT_MS/OPENAI_MAX_RETRIES comment for the full reasoning.
  it('constructs the OpenAI client with an explicit request timeout and bounded retries', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_SCRIPT))

    await generatePodcastScriptFromText('some text')

    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]).toMatchObject({ apiKey: 'test-key', timeout: 20_000, maxRetries: 1 })
  })

  it('degrades to the typed "api_error" result when the OpenAI call times out (simulating a hung upstream call)', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const timeoutError = new Error('Request timed out.')
    timeoutError.name = 'APIConnectionTimeoutError'
    mockCreate.mockRejectedValueOnce(timeoutError)

    const result = await generatePodcastScriptFromText('some text')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('api_error')
      expect(result.message).toMatch(/something went wrong/i)
    }
    expect(logger.error).toHaveBeenCalled()
  })
})

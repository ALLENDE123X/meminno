import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockCreate = vi.fn()

// Mirrors tests/unit/notesGeneration.test.ts's pattern for mocking a
// class-based SDK client: the `openai` module's default export is a
// constructor; `new OpenAI(...)` must return an object exposing
// `.chat.completions.create`.
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

// Imported after the mocks above so the module under test picks up the
// mocked openai constructor.
import { generateFlashcardsFromNotes, generatedFlashcardsSchema } from '@/lib/flashcardsGeneration'

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
              function: { name: 'generate_flashcards', arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  }
}

function makeCards(count: number) {
  return Array.from({ length: count }, (_, i) => ({ front: `Front ${i + 1}`, back: `Back ${i + 1}` }))
}

const VALID_NOTES_JSON = JSON.stringify({
  title: 'Photosynthesis Basics',
  summary: 'Covers the light-dependent and light-independent reactions of photosynthesis in plants.',
  sections: [
    {
      heading: 'Light-Dependent Reactions',
      bullets: ['Occur in the thylakoid membrane', 'Produce ATP and NADPH', 'Split water, releasing oxygen'],
    },
  ],
  keyConcepts: [{ term: 'Chlorophyll', definition: 'The pigment that absorbs light energy for photosynthesis.' }],
})

describe('generatedFlashcardsSchema', () => {
  it('accepts a payload with a valid number of cards', () => {
    expect(generatedFlashcardsSchema.safeParse({ cards: makeCards(8) }).success).toBe(true)
  })

  it('rejects fewer than 5 cards', () => {
    expect(generatedFlashcardsSchema.safeParse({ cards: makeCards(4) }).success).toBe(false)
  })

  it('rejects more than 20 cards', () => {
    expect(generatedFlashcardsSchema.safeParse({ cards: makeCards(21) }).success).toBe(false)
  })

  it('accepts the boundary values 5 and 20', () => {
    expect(generatedFlashcardsSchema.safeParse({ cards: makeCards(5) }).success).toBe(true)
    expect(generatedFlashcardsSchema.safeParse({ cards: makeCards(20) }).success).toBe(true)
  })

  it('rejects a card missing a back', () => {
    const cards = makeCards(8)
    delete (cards[0] as Record<string, unknown>).back
    expect(generatedFlashcardsSchema.safeParse({ cards }).success).toBe(false)
  })

  it('rejects a card with an empty front', () => {
    const cards = makeCards(8)
    cards[0].front = ''
    expect(generatedFlashcardsSchema.safeParse({ cards }).success).toBe(false)
  })

  it('rejects a missing/malformed shape entirely', () => {
    expect(generatedFlashcardsSchema.safeParse(null).success).toBe(false)
    expect(generatedFlashcardsSchema.safeParse('not an object').success).toBe(false)
    expect(generatedFlashcardsSchema.safeParse({}).success).toBe(false)
  })
})

describe('generateFlashcardsFromNotes', () => {
  const ORIGINAL_ENV = process.env.OPENAI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = ORIGINAL_ENV
  })

  // The fail-closed path this ticket's dispatch explicitly calls out, same
  // as MEM-005: OPENAI_API_KEY is not provisioned in this environment as of
  // MEM-006's ship date, so real deployed traffic takes exactly this branch
  // today.
  it('fails gracefully with reason "not_configured" when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY
    const result = await generateFlashcardsFromNotes(VALID_NOTES_JSON)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('not_configured')
      expect(result.message).toMatch(/isn't available/i)
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('fails gracefully with reason "empty_input" for blank content, without calling OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const result = await generateFlashcardsFromNotes('   \n  ')

    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('empty_input')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('generates and validates flashcards from real notes content', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ cards: makeCards(10) }))

    const result = await generateFlashcardsFromNotes(VALID_NOTES_JSON)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.cards).toHaveLength(10)
      expect(result.data.cards[0].front).toBe('Front 1')
    }

    // Forced tool-use, not free-text generation.
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tool_choice).toEqual({ type: 'function', function: { name: 'generate_flashcards' } })
    expect(callArgs.model).toBe('gpt-4o-mini')
  })

  it('renders JSON-shaped notes content into readable text before sending it to OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ cards: makeCards(8) }))

    await generateFlashcardsFromNotes(VALID_NOTES_JSON)

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    // Should not just be the raw JSON string — the title/heading/key concept
    // text should be present in a readable form, and the response should not
    // contain literal JSON punctuation like `"sections":[`.
    expect(userMessage).toContain('Photosynthesis Basics')
    expect(userMessage).toContain('Light-Dependent Reactions')
    expect(userMessage).toContain('Chlorophyll')
    expect(userMessage).not.toContain('"sections"')
  })

  it('falls back to the raw text unchanged when content is not valid JSON', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ cards: makeCards(8) }))

    await generateFlashcardsFromNotes('Plain-text notes about mitochondria being the powerhouse of the cell.')

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage).toContain('mitochondria being the powerhouse of the cell')
  })

  it('truncates unusually long source content before sending it to OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ cards: makeCards(8) }))

    const hugeText = 'a'.repeat(200_000)
    await generateFlashcardsFromNotes(hugeText)

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage.length).toBeLessThan(hugeText.length)
    expect(userMessage.length).toBeLessThanOrEqual(60_000)
  })

  it('fails gracefully when the model returns too few cards', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ cards: makeCards(2) }))

    const result = await generateFlashcardsFromNotes(VALID_NOTES_JSON)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when OpenAI does not return a tool call', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { content: 'huh?', tool_calls: undefined } }],
    })

    const result = await generateFlashcardsFromNotes(VALID_NOTES_JSON)
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
              { id: 'call_1', type: 'function', function: { name: 'generate_flashcards', arguments: '{not valid json' } },
            ],
          },
        },
      ],
    })

    const result = await generateFlashcardsFromNotes(VALID_NOTES_JSON)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully on an API/network error, without crashing', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockRejectedValueOnce(new Error('network down'))

    const result = await generateFlashcardsFromNotes(VALID_NOTES_JSON)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('api_error')
    expect(logger.error).toHaveBeenCalled()
  })
})

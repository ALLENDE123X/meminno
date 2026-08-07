import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockCreate = vi.fn()

// Mirrors Propinno's tests/unit/nlpCriteria.test.ts pattern for mocking a
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
import { generateNotesFromText, generatedNotesSchema } from '@/lib/notesGeneration'

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
              function: { name: 'generate_study_notes', arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  }
}

const VALID_NOTES = {
  title: 'Photosynthesis Basics',
  summary: 'Covers the light-dependent and light-independent reactions of photosynthesis in plants.',
  sections: [
    {
      heading: 'Light-Dependent Reactions',
      bullets: ['Occur in the thylakoid membrane', 'Produce ATP and NADPH', 'Split water, releasing oxygen'],
    },
    {
      heading: 'Calvin Cycle',
      bullets: ['Occurs in the stroma', 'Uses ATP/NADPH to fix CO2 into glucose'],
    },
  ],
  keyConcepts: [
    { term: 'Chlorophyll', definition: 'The pigment that absorbs light energy for photosynthesis.' },
    { term: 'Stroma', definition: 'The fluid-filled space inside the chloroplast surrounding the thylakoids.' },
  ],
}

describe('generatedNotesSchema', () => {
  it('accepts a fully valid payload', () => {
    expect(generatedNotesSchema.safeParse(VALID_NOTES).success).toBe(true)
  })

  it('rejects a missing title', () => {
    const rest: Record<string, unknown> = { ...VALID_NOTES }
    delete rest.title
    expect(generatedNotesSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an empty sections array', () => {
    expect(generatedNotesSchema.safeParse({ ...VALID_NOTES, sections: [] }).success).toBe(false)
  })

  it('rejects a section with no bullets', () => {
    expect(
      generatedNotesSchema.safeParse({
        ...VALID_NOTES,
        sections: [{ heading: 'Empty section', bullets: [] }],
      }).success
    ).toBe(false)
  })

  it('accepts an empty keyConcepts array (some material has none)', () => {
    expect(generatedNotesSchema.safeParse({ ...VALID_NOTES, keyConcepts: [] }).success).toBe(true)
  })

  it('rejects a keyConcept missing a definition', () => {
    expect(
      generatedNotesSchema.safeParse({
        ...VALID_NOTES,
        keyConcepts: [{ term: 'Chlorophyll' }],
      }).success
    ).toBe(false)
  })

  it('rejects a missing/malformed shape entirely', () => {
    expect(generatedNotesSchema.safeParse(null).success).toBe(false)
    expect(generatedNotesSchema.safeParse('not an object').success).toBe(false)
  })
})

describe('generateNotesFromText', () => {
  const ORIGINAL_ENV = process.env.OPENAI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = ORIGINAL_ENV
  })

  // The fail-closed path this ticket's dispatch explicitly calls out:
  // OPENAI_API_KEY is not provisioned in this environment as of MEM-005's
  // ship date, so real deployed traffic takes exactly this branch today.
  it('fails gracefully with reason "not_configured" when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY
    const result = await generateNotesFromText('Some lecture notes about photosynthesis.')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('not_configured')
      expect(result.message).toMatch(/isn't available/i)
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('fails gracefully with reason "empty_input" for blank text, without calling OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const result = await generateNotesFromText('   \n  ')

    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('empty_input')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('generates and validates structured notes from real document text', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_NOTES))

    const result = await generateNotesFromText('Raw lecture transcript about photosynthesis...')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.title).toBe('Photosynthesis Basics')
      expect(result.data.sections).toHaveLength(2)
      expect(result.data.keyConcepts[0].term).toBe('Chlorophyll')
    }

    // Forced tool-use, not free-text generation.
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tool_choice).toEqual({ type: 'function', function: { name: 'generate_study_notes' } })
    expect(callArgs.model).toBe('gpt-4o-mini')
    expect(callArgs.messages[1].content).toContain('photosynthesis')
  })

  it('truncates unusually long source text before sending it to OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse(VALID_NOTES))

    const hugeText = 'a'.repeat(200_000)
    await generateNotesFromText(hugeText)

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage.length).toBeLessThan(hugeText.length)
    expect(userMessage.length).toBeLessThanOrEqual(60_000)
  })

  it('fails gracefully when the model returns notes missing a required field', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ title: 'Incomplete', summary: 'Missing sections entirely' }))

    const result = await generateNotesFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully when OpenAI does not return a tool call', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { content: 'huh?', tool_calls: undefined } }],
    })

    const result = await generateNotesFromText('some text')
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
              { id: 'call_1', type: 'function', function: { name: 'generate_study_notes', arguments: '{not valid json' } },
            ],
          },
        },
      ],
    })

    const result = await generateNotesFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
  })

  it('fails gracefully on an API/network error, without crashing', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockRejectedValueOnce(new Error('network down'))

    const result = await generateNotesFromText('some text')
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('api_error')
    expect(logger.error).toHaveBeenCalled()
  })
})

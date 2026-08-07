import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockCreate = vi.fn()

// Mirrors tests/unit/notesGeneration.test.ts / tests/unit/flashcardsGeneration.test.ts's
// pattern for mocking a class-based SDK client: the `openai` module's
// default export is a constructor; `new OpenAI(...)` must return an object
// exposing `.chat.completions.create`.
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
import { generateQuizFromContent, generatedQuizSchema } from '@/lib/quizGeneration'

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
              function: { name: 'generate_quiz', arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  }
}

function makeQuestion(i: number, overrides: Partial<{ question: string; options: string[]; correctAnswer: string }> = {}) {
  return {
    question: overrides.question ?? `Question ${i}?`,
    options: overrides.options ?? [`Option ${i}A`, `Option ${i}B`, `Option ${i}C`, `Option ${i}D`],
    correctAnswer: overrides.correctAnswer ?? `Option ${i}A`,
  }
}

function makeQuestions(count: number) {
  return Array.from({ length: count }, (_, i) => makeQuestion(i + 1))
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

const VALID_FLASHCARDS = [
  { front: 'What is the powerhouse of the cell?', back: 'The mitochondria.' },
  { front: 'What pigment absorbs light for photosynthesis?', back: 'Chlorophyll.' },
]

describe('generatedQuizSchema', () => {
  it('accepts a payload with a valid number of questions', () => {
    expect(generatedQuizSchema.safeParse({ questions: makeQuestions(8) }).success).toBe(true)
  })

  it('rejects fewer than 5 questions', () => {
    expect(generatedQuizSchema.safeParse({ questions: makeQuestions(4) }).success).toBe(false)
  })

  it('rejects more than 12 questions', () => {
    expect(generatedQuizSchema.safeParse({ questions: makeQuestions(13) }).success).toBe(false)
  })

  it('accepts the boundary values 5 and 12', () => {
    expect(generatedQuizSchema.safeParse({ questions: makeQuestions(5) }).success).toBe(true)
    expect(generatedQuizSchema.safeParse({ questions: makeQuestions(12) }).success).toBe(true)
  })

  it('rejects a question with fewer than 4 options', () => {
    const questions = makeQuestions(6)
    questions[0].options = ['Only one option']
    expect(generatedQuizSchema.safeParse({ questions }).success).toBe(false)
  })

  it('rejects a question with more than 4 options', () => {
    const questions = makeQuestions(6)
    questions[0].options = ['A', 'B', 'C', 'D', 'E']
    expect(generatedQuizSchema.safeParse({ questions }).success).toBe(false)
  })

  it('rejects a question whose correctAnswer does not match any option', () => {
    const questions = makeQuestions(6)
    questions[0].correctAnswer = 'Not one of the options'
    expect(generatedQuizSchema.safeParse({ questions }).success).toBe(false)
  })

  it('rejects a question missing its question text', () => {
    const questions = makeQuestions(6) as Array<Record<string, unknown>>
    delete questions[0].question
    expect(generatedQuizSchema.safeParse({ questions }).success).toBe(false)
  })

  it('rejects a missing/malformed shape entirely', () => {
    expect(generatedQuizSchema.safeParse(null).success).toBe(false)
    expect(generatedQuizSchema.safeParse('not an object').success).toBe(false)
    expect(generatedQuizSchema.safeParse({}).success).toBe(false)
  })
})

describe('generateQuizFromContent', () => {
  const ORIGINAL_ENV = process.env.OPENAI_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OPENAI_API_KEY = ORIGINAL_ENV
  })

  // The fail-closed path this ticket's dispatch explicitly calls out, same
  // as MEM-005/MEM-006: OPENAI_API_KEY is not provisioned in this
  // environment as of MEM-007's ship date, so real deployed traffic takes
  // exactly this branch today.
  it('fails gracefully with reason "not_configured" when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY
    const result = await generateQuizFromContent(VALID_NOTES_JSON, VALID_FLASHCARDS)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason).toBe('not_configured')
      expect(result.message).toMatch(/isn't available/i)
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('fails gracefully with reason "empty_input" for blank notes content, without calling OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const result = await generateQuizFromContent('   \n  ', [])

    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('empty_input')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('generates and validates a quiz from real notes content, with no flashcards', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(7) }))

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.questions).toHaveLength(7)
      expect(result.data.questions[0].options).toHaveLength(4)
    }

    // Forced tool-use, not free-text generation.
    const callArgs = mockCreate.mock.calls[0][0]
    expect(callArgs.tool_choice).toEqual({ type: 'function', function: { name: 'generate_quiz' } })
    expect(callArgs.model).toBe('gpt-4o-mini')
  })

  // Issue #26 / MEM-007-fix: the real root cause of the ~50% production
  // failure rate was malformed forced-tool-call output (a missing required
  // field, or an array item of the wrong type) that OpenAI's structured
  // outputs `strict` mode is designed to prevent server-side. Pin that the
  // tool definition actually requests it, and that both object levels of the
  // schema satisfy strict mode's requirements (additionalProperties: false,
  // every property required) - a regression here would silently reopen the
  // exact bug this ticket fixes.
  it('requests OpenAI structured-outputs strict mode with a strict-compliant schema', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(6) }))

    await generateQuizFromContent(VALID_NOTES_JSON, [])

    const callArgs = mockCreate.mock.calls[0][0]
    const tool = callArgs.tools[0]
    expect(tool.function.strict).toBe(true)
    expect(tool.function.parameters.additionalProperties).toBe(false)
    expect(tool.function.parameters.properties.questions.items.additionalProperties).toBe(false)
    expect(tool.function.parameters.properties.questions.items.required).toEqual(
      expect.arrayContaining(['question', 'options', 'correctAnswer'])
    )
  })

  it('generates a quiz using notes as primary content when flashcards are provided too', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(7) }))

    await generateQuizFromContent(VALID_NOTES_JSON, VALID_FLASHCARDS)

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    // Notes content renders first/primarily...
    expect(userMessage).toContain('Photosynthesis Basics')
    expect(userMessage).toContain('Light-Dependent Reactions')
    // ...flashcards are appended as a clearly-labeled reinforcement section.
    expect(userMessage).toContain('Existing Flashcards')
    expect(userMessage).toContain('What is the powerhouse of the cell?')
    expect(userMessage).toContain('The mitochondria.')
    // Notes content appears before the flashcards section.
    expect(userMessage.indexOf('Photosynthesis Basics')).toBeLessThan(userMessage.indexOf('Existing Flashcards'))
  })

  it('omits the flashcards section entirely when none are provided', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(7) }))

    await generateQuizFromContent(VALID_NOTES_JSON, [])

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage).not.toContain('Existing Flashcards')
  })

  it('falls back to the raw text unchanged when notes content is not valid JSON', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(6) }))

    await generateQuizFromContent('Plain-text notes about mitochondria being the powerhouse of the cell.', [])

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage).toContain('mitochondria being the powerhouse of the cell')
  })

  it('truncates unusually long notes content before sending it to OpenAI', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(6) }))

    const hugeText = 'a'.repeat(200_000)
    await generateQuizFromContent(hugeText, [])

    const callArgs = mockCreate.mock.calls[0][0]
    const userMessage = callArgs.messages[1].content as string
    expect(userMessage.length).toBeLessThan(hugeText.length)
    expect(userMessage.length).toBeLessThanOrEqual(60_000)
  })

  // Issue #26 / MEM-007-fix: generateQuizFromContent now retries exactly
  // once on `invalid_response` (defense-in-depth alongside `strict: true`
  // above), so every "fails gracefully with invalid_response" case below
  // must queue the malformed response TWICE - once per attempt - to reflect
  // real end-to-end behavior when both attempts genuinely fail, and each
  // asserts mockCreate was called exactly twice (proving the retry happened,
  // and that it stopped there rather than looping).

  it('fails gracefully when the model returns too few questions on both attempts', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValue(toolCallResponse({ questions: makeQuestions(2) }))

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('fails gracefully when a question\'s correctAnswer does not match any of its options on both attempts', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const questions = makeQuestions(6)
    questions[0].correctAnswer = 'Something else entirely'
    mockCreate.mockResolvedValue(toolCallResponse({ questions }))

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('fails gracefully when OpenAI does not return a tool call on either attempt', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'huh?', tool_calls: undefined } }],
    })

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('fails gracefully when the tool call arguments are not valid JSON on either attempt', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockResolvedValue({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'generate_quiz', arguments: '{not valid json' } },
            ],
          },
        },
      ],
    })

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('invalid_response')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  // The retry is the actual point of this ticket's defense-in-depth change:
  // a first attempt that comes back malformed should not surface as a user
  // -facing failure if a second attempt succeeds.
  it('retries once and succeeds when the first attempt is malformed but the second is valid', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate
      .mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(2) })) // first: too few questions
      .mockResolvedValueOnce(toolCallResponse({ questions: makeQuestions(7) })) // second: valid

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])

    expect(result.success).toBe(true)
    if (result.success) expect(result.data.questions).toHaveLength(7)
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('does not retry on an API/network error - fails gracefully after a single attempt, without crashing', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    mockCreate.mockRejectedValueOnce(new Error('network down'))

    const result = await generateQuizFromContent(VALID_NOTES_JSON, [])
    expect(result.success).toBe(false)
    if (!result.success) expect(result.reason).toBe('api_error')
    expect(logger.error).toHaveBeenCalled()
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})

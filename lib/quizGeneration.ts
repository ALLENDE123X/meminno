import OpenAI from 'openai'
import { z } from 'zod'
import { logger } from '@/lib/logger'

// MEM-007: AI-generated multiple-choice quiz from a `notes` row's content
// (notes.content, MEM-005), reinforced with that note's existing
// `flashcards` rows (front/back pairs, MEM-006) when any exist — the
// notes->flashcards->quiz escalating reveal is the exact structure this
// ticket's dispatch flagged as load-bearing for the launch marketing video.
//
// Same architecture, same reasoning, as MEM-005/MEM-006 (per this ticket's
// dispatch instructions to mirror both closely) — itself mirrored from
// Propinno's lib/nlpCriteria.ts:
//   - OpenAI Chat Completions with FORCED tool-use (`tool_choice` pinned to
//     one function) rather than free-text generation + regex/JSON.parse.
//   - The tool-call output is untrusted model output derived from
//     already-AI-generated (and, further back, user-uploaded) content, and
//     is re-validated with zod before it is ever persisted or returned.
//   - Every failure mode is a typed, non-throwing result
//     ({ success: false, reason, message }), never an unhandled exception.
//     `not_configured` (OPENAI_API_KEY unset) is the expected, first-class
//     path in this environment as of MEM-007's ship date, same as
//     MEM-005/MEM-006 — see CLAUDE.md HARD STOP 6 / this ticket's dispatch.
//
// Two-layer rate limiting (HARD STOP 6) is NOT this module's job — it lives
// in lib/quizLimits.ts, called by the route before this function, mirroring
// MEM-006's lib/flashcardsLimits.ts split, with its own
// `meminno-ai-budget:quiz-generation:...` Redis namespace so it never shares
// a counter with notes or flashcards generation.
const SYSTEM_PROMPT = `You are an expert quiz writer helping a student test their understanding of material they have already studied. Given a set of study notes (title, summary, sections with bullet points, and key concepts) and, when available, a set of flashcards already generated from those notes, produce a multiple-choice quiz by calling the generate_quiz tool.

Rules:
- Each question must have exactly 4 answer options and exactly one correct answer. "correctAnswer" must be copied verbatim from one of the four "options".
- The 3 incorrect options ("distractors") must be plausible and related to the material — not obviously wrong, not jokes, and not near-duplicates of the correct answer or of each other.
- Prioritize the material's key concepts, definitions, and any facts, distinctions, or relationships a student would genuinely need to recall. Do not create near-duplicate questions that test the same fact twice.
- Use the notes as the primary source of truth. Treat any provided flashcards as a hint toward which concepts matter most and are worth testing, not as additional facts to invent questions from beyond what the notes support.
- Generate between 6 and 10 questions for typical material. Use fewer (but never fewer than 5) only if the notes are genuinely short. Use more (up to 12) only if the notes are unusually rich and 10 would leave real material untested.
- Base everything strictly on the provided material. Do not add outside facts, and do not invent details the material does not support.`

const GENERATE_QUIZ_TOOL_NAME = 'generate_quiz'

// Same OpenAI function-calling shape as lib/notesGeneration.ts /
// lib/flashcardsGeneration.ts ({type: 'function', function: {name,
// description, parameters}}), with a schema suited to a multiple-choice quiz.
//
// `strict: true` (issue #26 / MEM-007-fix, real root cause of the ~50%
// failure rate): without it, gpt-4o-mini's forced tool-call arguments were
// observed in production to come back malformed in ways that are perfectly
// valid loose JSON but violate this schema - e.g. `questions[3]` missing
// `correctAnswer` entirely, or `questions[4]` a bare string instead of an
// object - which JSON.parse happily accepts and only zod's post-hoc
// validation catches, after the (billed) call already happened. OpenAI's
// structured-outputs `strict` mode enforces the JSON schema
// constrained-decoding server-side, before the response is ever returned, so
// the entire "syntactically valid JSON, wrong shape" failure class this
// module's own zod schema was built to catch should no longer occur at the
// source. Neither lib/notesGeneration.ts nor lib/flashcardsGeneration.ts
// showed real evidence of the same failure rate (see this ticket's PR
// description for the comparison), so they are intentionally left
// unchanged - not because their schemas couldn't benefit in principle, but
// per this ticket's explicit scope ("only if you find real evidence").
//
// Strict mode requires every object in the schema to set
// `additionalProperties: false` and list every property as `required` (no
// optional fields) - already true here (question/options/correctAnswer were
// already all required), so the only schema change needed is adding
// `additionalProperties: false` to both object levels. zod's post-parse
// validation (generatedQuizSchema below, including the exactly-4-options and
// correctAnswer-must-match-an-option checks strict mode's JSON Schema subset
// cannot itself express) is kept as-is and still runs on every response -
// defense in depth, not redundant: strict mode guarantees shape, not the
// domain-specific invariants this app actually cares about.
const GENERATE_QUIZ_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: GENERATE_QUIZ_TOOL_NAME,
    description: 'Report a multiple-choice quiz generated from the provided notes (and, when available, flashcards).',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The generated quiz questions.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text.' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exactly 4 answer options, in any order.',
              },
              correctAnswer: {
                type: 'string',
                description: 'The correct answer, copied verbatim from one of the 4 options.',
              },
            },
            required: ['question', 'options', 'correctAnswer'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
}

// Sanity bounds on the model's own output, mirroring lib/notesGeneration.ts /
// lib/flashcardsGeneration.ts's treatment of model output as untrusted until
// validated — this is content a user will be quizzed on and (via
// app/api/notes/[id]/quiz) is persisted verbatim into quizzes.questions.
//
// Exactly 4 options is enforced at the schema level (not just requested in
// the prompt): a standard multiple-choice shape is the simplest to grade
// consistently in a future MEM-008 quiz-taking UI, matches the format most
// competitor study apps use, and a variable option count would meaningfully
// complicate that UI for no real benefit here. `correctAnswer` is validated
// per-question (via superRefine below) to actually be one of that question's
// own `options` — catches the most likely way a model response could be
// silently wrong (a correct answer that doesn't match any option, e.g. due
// to paraphrasing) before it is ever persisted or shown to a student.
//
// min(5)/max(12) is deliberately a little looser than the 6-10 the system
// prompt asks for, the same relationship lib/flashcardsGeneration.ts's
// schema has to its own 8-15 prompt target: the prompt is the actual product
// target, the schema bound only exists to catch a genuinely broken or
// abusive response rather than to police the model's judgment call on
// material that's shorter or richer than typical.
const questionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(300)).length(4),
    correctAnswer: z.string().trim().min(1).max(300),
  })
  .refine((q) => q.options.includes(q.correctAnswer), {
    message: 'correctAnswer must exactly match one of the 4 options',
    path: ['correctAnswer'],
  })

export const generatedQuizSchema = z.object({
  questions: z.array(questionSchema).min(5).max(12),
})

export type GeneratedQuiz = z.infer<typeof generatedQuizSchema>
export type GeneratedQuizQuestion = GeneratedQuiz['questions'][number]

export type GenerateQuizResult =
  | { success: true; data: GeneratedQuiz }
  | {
      success: false
      reason: 'not_configured' | 'empty_input' | 'invalid_response' | 'api_error'
      message: string
    }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// notes.content (lib/db/schema.ts) is a plain `text` column holding MEM-005's
// JSON.stringify'd GeneratedNotes object — same bound and reasoning as
// lib/flashcardsGeneration.ts's MAX_INPUT_CHARS: predictable prompt
// size/latency/cost on an endpoint HARD STOP 6 exists to bound. The
// flashcards portion of the prompt (see buildPromptText below) is naturally
// far smaller (short front/back pairs) and is not separately truncated —
// this single combined cap is enough to bound total prompt size either way.
const MAX_INPUT_CHARS = 60_000

// gpt-4o-mini, same model choice as lib/notesGeneration.ts /
// lib/flashcardsGeneration.ts and for the same reason: structured extraction
// against a forced schema, not open-ended creative writing, so a fast/cheap
// model is the right fit — especially given this endpoint's own daily budget
// cap (lib/quizLimits.ts) is sized assuming a low per-call cost.
const MODEL = 'gpt-4o-mini'

/** A flashcard's front/back pair, the shape lib/db/schema.ts's `flashcards` table stores. */
export type QuizInputFlashcard = { front: string; back: string }

/**
 * Renders a notes row's `content` column into plain text suitable for the
 * quiz prompt. Same rendering as lib/flashcardsGeneration.ts's
 * renderNotesContentForPrompt — deliberately re-implemented rather than
 * imported, matching this repo's existing convention of not tightly coupling
 * sibling generation modules (see that file's own header comment), so a
 * notes row saved by a future/older format still degrades to "treat it as
 * plain text" here too, independently of whether flashcards generation ever
 * changes.
 */
function renderNotesContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as {
      title?: unknown
      summary?: unknown
      sections?: unknown
      keyConcepts?: unknown
    }
    if (typeof parsed !== 'object' || parsed === null) return rawContent

    const lines: string[] = []
    if (typeof parsed.title === 'string') lines.push(`Title: ${parsed.title}`)
    if (typeof parsed.summary === 'string') lines.push(`Summary: ${parsed.summary}`)

    if (Array.isArray(parsed.sections)) {
      for (const section of parsed.sections) {
        if (typeof section !== 'object' || section === null) continue
        const { heading, bullets } = section as { heading?: unknown; bullets?: unknown }
        if (typeof heading === 'string') lines.push(`\n## ${heading}`)
        if (Array.isArray(bullets)) {
          for (const bullet of bullets) {
            if (typeof bullet === 'string') lines.push(`- ${bullet}`)
          }
        }
      }
    }

    if (Array.isArray(parsed.keyConcepts) && parsed.keyConcepts.length > 0) {
      lines.push('\n## Key Concepts')
      for (const concept of parsed.keyConcepts) {
        if (typeof concept !== 'object' || concept === null) continue
        const { term, definition } = concept as { term?: unknown; definition?: unknown }
        if (typeof term === 'string' && typeof definition === 'string') {
          lines.push(`- ${term}: ${definition}`)
        }
      }
    }

    return lines.length > 0 ? lines.join('\n') : rawContent
  } catch {
    return rawContent
  }
}

/**
 * Combines a notes row's content (primary source) with its existing
 * flashcards, if any (reinforcement signal for which concepts matter most),
 * into the single prompt sent to OpenAI.
 *
 * Design decision (per this ticket's dispatch, "notes content as primary
 * context, flashcard fronts/backs as reinforcement of key concepts to
 * test"): flashcards are appended as a clearly-labeled section, not
 * interleaved with or treated as equal to the notes. The system prompt
 * reinforces the same asymmetry ("a hint toward which concepts matter most
 * ... not additional facts to invent questions from"), so a note with a
 * thin or stale flashcards set can't skew the quiz toward material the notes
 * themselves don't actually support. Flashcards are optional: a note with no
 * flashcards yet (a user going straight from notes to quiz) still produces a
 * complete quiz from the notes alone — nothing here requires MEM-006 to have
 * run first for a given note.
 */
function buildPromptText(notesContent: string, flashcards: QuizInputFlashcard[]): string {
  const rendered = renderNotesContent(notesContent)
  const notesText = rendered.length > MAX_INPUT_CHARS ? rendered.slice(0, MAX_INPUT_CHARS) : rendered

  if (flashcards.length === 0) return notesText

  const flashcardsText = flashcards.map((card) => `- Q: ${card.front} / A: ${card.back}`).join('\n')
  return `${notesText}\n\n## Existing Flashcards (for reference only - which concepts matter most)\n${flashcardsText}`
}

/**
 * Single OpenAI call + parse + validate attempt, factored out of
 * generateQuizFromContent so it can be tried up to twice (see
 * MAX_ATTEMPTS below) without duplicating the request/parse/validate logic.
 * Never throws - api_error is caught and returned as a typed result, same as
 * before this was split out.
 */
async function attemptGenerateQuiz(client: OpenAI, sourceText: string): Promise<GenerateQuizResult> {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: sourceText },
      ],
      tools: [GENERATE_QUIZ_TOOL],
      tool_choice: { type: 'function', function: { name: GENERATE_QUIZ_TOOL_NAME } },
    })

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0]
    // As in lib/notesGeneration.ts / lib/flashcardsGeneration.ts: the SDK's
    // tool-call type is a union of a function-tool-call shape
    // (`.function.arguments`) and a "custom tool" shape with no `.function`.
    // Only a `type: 'function'` tool is ever declared/forced above, so a
    // real response can only come back as the function variant - this
    // narrows the type rather than assuming it.
    if (!toolCall || toolCall.type !== 'function') {
      logger.warn(
        { finishReason: completion.choices[0]?.finish_reason },
        'AI quiz generation: no tool call in OpenAI response'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate a quiz from these notes. ${FALLBACK_MESSAGE}`,
      }
    }

    let rawOutput: unknown
    try {
      rawOutput = JSON.parse(toolCall.function.arguments)
    } catch (parseErr) {
      logger.warn({ err: parseErr }, 'AI quiz generation: tool call arguments were not valid JSON')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate a quiz from these notes. ${FALLBACK_MESSAGE}`,
      }
    }

    const parsed = generatedQuizSchema.safeParse(rawOutput)
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        'AI quiz generation: validation failed'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate a valid quiz from these notes. ${FALLBACK_MESSAGE}`,
      }
    }

    return { success: true, data: parsed.data }
  } catch (err) {
    logger.error({ err }, 'AI quiz generation failed')
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong generating this quiz. ${FALLBACK_MESSAGE}`,
    }
  }
}

// One retry, not a loop (issue #26 / MEM-007-fix): defense-in-depth for a
// genuinely malformed response even after `strict: true` above, which should
// eliminate most but promises to eliminate none of this failure class in
// principle. Deliberately bounded to a single extra attempt (MAX_ATTEMPTS =
// 2 total) rather than a retry loop, both to keep worst-case latency/cost on
// this endpoint predictable and to avoid ever looping unboundedly.
//
// Only retried on `invalid_response` - not `api_error` (a real
// network/API-level failure retrying immediately is unlikely to help and is
// out of scope here) and not `not_configured`/`empty_input` (retrying a
// request that can never succeed wastes a call for nothing).
//
// Rate-limit/budget interaction (CLAUDE.md HARD STOP 6): this retry is
// entirely internal to this function and invisible to the caller.
// app/api/notes/[id]/quiz's route calls claimQuizBudget() exactly once per
// POST request, BEFORE calling generateQuizFromContent - the route never
// knows or cares whether zero, one, or two OpenAI calls happened inside a
// single generateQuizFromContent invocation, so a retry here can never
// double-claim a day's quota or bypass the budget check. It does mean a
// single POST can cost up to two real OpenAI calls instead of one on the
// (expected to be rare, post-strict-mode) retry path - an accepted,
// explicitly bounded tradeoff, not an unbounded one.
const MAX_ATTEMPTS = 2

/**
 * Generates a multiple-choice quiz from a notes row's `content`, reinforced
 * by that note's existing flashcards (if any), via OpenAI forced tool-use.
 * Zod-validates the result and never throws — every failure mode (including
 * OPENAI_API_KEY being unset) returns a typed, caller-safe result instead of
 * an unhandled exception or a silent empty-quiz return.
 */
export async function generateQuizFromContent(
  notesContent: string,
  flashcards: QuizInputFlashcard[] = []
): Promise<GenerateQuizResult> {
  const trimmed = notesContent.trim()
  if (!trimmed) {
    return {
      success: false,
      reason: 'empty_input',
      message: 'These notes have no content to generate a quiz from.',
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.warn('AI quiz generation requested but OPENAI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `AI quiz generation isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  const sourceText = buildPromptText(trimmed, flashcards)
  const client = new OpenAI({ apiKey })

  let result = await attemptGenerateQuiz(client, sourceText)
  for (let attempt = 2; attempt <= MAX_ATTEMPTS && !result.success && result.reason === 'invalid_response'; attempt++) {
    logger.warn({ attempt }, 'AI quiz generation: retrying once after invalid_response')
    result = await attemptGenerateQuiz(client, sourceText)
  }
  return result
}

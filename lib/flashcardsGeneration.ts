import OpenAI from 'openai'
import { z } from 'zod'
import { logger } from '@/lib/logger'

// MEM-006: AI-generated flashcards from an existing `notes` row's content
// (notes.content, populated by MEM-005's AI notes generation — see
// lib/notesGeneration.ts, which this file's structure mirrors directly).
//
// Same architecture, same reasoning, as MEM-005 (per this ticket's dispatch
// instructions to mirror lib/notesGeneration.ts closely rather than invent a
// new pattern) — itself mirrored from Propinno's lib/nlpCriteria.ts:
//   - OpenAI Chat Completions with FORCED tool-use (`tool_choice` pinned to
//     one function) rather than free-text generation + regex/JSON.parse.
//   - The tool-call output is untrusted model output derived from
//     already-AI-generated (and, one hop further back, user-uploaded)
//     content, and is re-validated with zod before it is ever persisted or
//     returned.
//   - Every failure mode is a typed, non-throwing result
//     ({ success: false, reason, message }), never an unhandled exception.
//     `not_configured` (OPENAI_API_KEY unset) is the expected, first-class
//     path in this environment as of MEM-006's ship date, same as MEM-005 —
//     see CLAUDE.md HARD STOP 6 / this ticket's dispatch notes.
//
// Two-layer rate limiting (HARD STOP 6) is NOT this module's job — it lives
// in lib/flashcardsLimits.ts, called by the route before this function,
// mirroring MEM-005's lib/notesLimits.ts split (generation logic vs. quota
// enforcement are separate, separately testable concerns) and using its own
// `meminno-ai-budget:flashcards-generation:...` Redis namespace so it never
// shares a counter with notes generation.
const SYSTEM_PROMPT = `You are an expert flashcard writer helping a student review material they have already studied. Given a set of study notes (title, summary, sections with bullet points, and key concepts), produce a set of high-quality flashcards by calling the generate_flashcards tool.

Rules:
- Each flashcard's "front" is a short, specific question, term, or prompt (not a full restatement of the notes). Each "back" is the concise answer or explanation — enough to genuinely test recall, not a copy-pasted bullet point.
- Prioritize the material's key concepts/definitions and any facts, distinctions, or relationships a student would need to recall under quiz conditions. Do not create near-duplicate cards that test the same fact twice.
- Generate between 8 and 15 flashcards for typical material. Use fewer (but never fewer than 5) only if the notes are genuinely short and 8 distinct, non-redundant cards aren't supportable. Use more (up to 20) only if the notes are unusually rich and 15 would leave real material uncovered.
- Base everything strictly on the provided notes. Do not add outside facts, and do not invent details the notes do not support.`

const GENERATE_FLASHCARDS_TOOL_NAME = 'generate_flashcards'

// Same OpenAI function-calling shape as lib/notesGeneration.ts
// ({type: 'function', function: {name, description, parameters}}), with a
// schema suited to flashcards rather than notes.
const GENERATE_FLASHCARDS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: GENERATE_FLASHCARDS_TOOL_NAME,
    description: 'Report a set of study flashcards generated from the provided notes.',
    parameters: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          description: 'The generated flashcards, each a front (question/prompt) and back (answer) pair.',
          items: {
            type: 'object',
            properties: {
              front: { type: 'string', description: 'A short, specific question, term, or prompt.' },
              back: { type: 'string', description: 'The concise answer or explanation for this card\'s front.' },
            },
            required: ['front', 'back'],
          },
        },
      },
      required: ['cards'],
    },
  },
}

// Sanity bounds on the model's own output, mirroring lib/notesGeneration.ts's
// generatedNotesSchema's treatment of model output as untrusted until
// validated (this is content a user will study from, and
// app/api/notes/[id]/flashcards persists it verbatim into flashcards.front/
// flashcards.back, one row per card).
//
// min(5)/max(20) is deliberately a little looser than the 8-15 the system
// prompt asks for: the prompt is the actual product target (documented
// above), while the schema bound exists only to catch a genuinely broken or
// abusive response (e.g. 1 card, or 200 cards) rather than to police the
// model's judgment call on material that's shorter or richer than typical.
// A card count in [5, 20] that isn't exactly 8-15 is still a reasonable,
// billable response worth accepting, not a validation failure.
export const generatedFlashcardsSchema = z.object({
  cards: z
    .array(
      z.object({
        front: z.string().trim().min(1).max(300),
        back: z.string().trim().min(1).max(1000),
      })
    )
    .min(5)
    .max(20),
})

export type GeneratedFlashcards = z.infer<typeof generatedFlashcardsSchema>
export type GeneratedFlashcard = GeneratedFlashcards['cards'][number]

export type GenerateFlashcardsResult =
  | { success: true; data: GeneratedFlashcards }
  | {
      success: false
      reason: 'not_configured' | 'empty_input' | 'invalid_response' | 'api_error'
      message: string
    }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// notes.content (lib/db/schema.ts) is a plain `text` column holding
// MEM-005's JSON.stringify'd GeneratedNotes object — already synthesized,
// denser than raw source text, and normally well under this bound. But
// generatedNotesSchema itself permits up to 30 sections x 30 bullets x 500
// chars plus 50 key concepts x 1000 chars, which can still add up to a large
// blob, so this module bounds its own input the same way
// lib/notesGeneration.ts bounds MAX_INPUT_CHARS — for the same reason
// (predictable prompt size/latency/cost on an endpoint HARD STOP 6 exists to
// bound), not because notes.content is expected to reach this size in
// practice.
const MAX_INPUT_CHARS = 60_000

// gpt-4o-mini, same model choice as lib/notesGeneration.ts and for the same
// reason: structured extraction against a forced schema, not open-ended
// creative writing, so a fast/cheap model is the right fit — especially
// given this endpoint's own daily budget cap (lib/flashcardsLimits.ts) is
// sized assuming a low per-call cost.
const MODEL = 'gpt-4o-mini'

/**
 * Renders a notes row's `content` column into plain text suitable for the
 * flashcards prompt.
 *
 * notes.content is normally MEM-005's JSON.stringify'd GeneratedNotes shape
 * ({title, summary, sections, keyConcepts}) — this formats that structure
 * into readable text (headings, bullets, term/definition pairs) rather than
 * handing the model raw JSON syntax to parse itself. Falls back to the raw
 * trimmed string unchanged if it isn't valid JSON or doesn't match the
 * expected shape, rather than failing the request — this module is
 * deliberately decoupled from lib/notesGeneration.ts's exact schema (no
 * import of it, no shared type), matching this repo's existing convention of
 * not tightly coupling sibling generation modules, so a notes row saved by a
 * future/older format still degrades to "treat it as plain text" instead of
 * erroring.
 */
function renderNotesContentForPrompt(rawContent: string): string {
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

    // If nothing recognizable was extracted (e.g. valid JSON, but a
    // completely different shape), fall back to the raw content rather than
    // returning an empty prompt.
    return lines.length > 0 ? lines.join('\n') : rawContent
  } catch {
    return rawContent
  }
}

/**
 * Generates flashcards from a notes row's `content` via OpenAI forced
 * tool-use, zod-validates the result, and never throws — every failure mode
 * (including OPENAI_API_KEY being unset) returns a typed, caller-safe result
 * instead of an unhandled exception or a silent empty-cards return.
 */
export async function generateFlashcardsFromNotes(notesContent: string): Promise<GenerateFlashcardsResult> {
  const trimmed = notesContent.trim()
  if (!trimmed) {
    return {
      success: false,
      reason: 'empty_input',
      message: 'These notes have no content to generate flashcards from.',
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.warn('AI flashcards generation requested but OPENAI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `AI flashcards generation isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  const rendered = renderNotesContentForPrompt(trimmed)
  const sourceText = rendered.length > MAX_INPUT_CHARS ? rendered.slice(0, MAX_INPUT_CHARS) : rendered

  try {
    const client = new OpenAI({ apiKey })
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: sourceText },
      ],
      tools: [GENERATE_FLASHCARDS_TOOL],
      tool_choice: { type: 'function', function: { name: GENERATE_FLASHCARDS_TOOL_NAME } },
    })

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0]
    // As in lib/notesGeneration.ts: the SDK's tool-call type is a union of a
    // function-tool-call shape (`.function.arguments`) and a "custom tool"
    // shape with no `.function`. Only a `type: 'function'` tool is ever
    // declared/forced above, so a real response can only come back as the
    // function variant - this narrows the type rather than assuming it.
    if (!toolCall || toolCall.type !== 'function') {
      logger.warn(
        { finishReason: completion.choices[0]?.finish_reason },
        'AI flashcards generation: no tool call in OpenAI response'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate flashcards from these notes. ${FALLBACK_MESSAGE}`,
      }
    }

    let rawOutput: unknown
    try {
      rawOutput = JSON.parse(toolCall.function.arguments)
    } catch (parseErr) {
      logger.warn({ err: parseErr }, 'AI flashcards generation: tool call arguments were not valid JSON')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate flashcards from these notes. ${FALLBACK_MESSAGE}`,
      }
    }

    const parsed = generatedFlashcardsSchema.safeParse(rawOutput)
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        'AI flashcards generation: validation failed'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate valid flashcards from these notes. ${FALLBACK_MESSAGE}`,
      }
    }

    return { success: true, data: parsed.data }
  } catch (err) {
    logger.error({ err }, 'AI flashcards generation failed')
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong generating flashcards. ${FALLBACK_MESSAGE}`,
    }
  }
}

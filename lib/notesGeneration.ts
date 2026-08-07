import OpenAI from 'openai'
import { z } from 'zod'
import { logger } from '@/lib/logger'

// MEM-005: AI-generated study notes from a document's extracted/pasted text
// (documents.raw_text, populated by MEM-004's upload flow).
//
// Architecture mirrored directly from Propinno's lib/nlpCriteria.ts (the
// established sibling-project precedent for "structured AI generation" per
// this ticket's dispatch instructions) - same shape, adapted from criteria
// extraction to notes generation:
//   - OpenAI Chat Completions with FORCED tool-use (`tool_choice` pinned to
//     one function) rather than free-text generation + regex/JSON.parse, so
//     the model can only respond in the exact shape we ask for.
//   - The tool-call output is untrusted model output derived from untrusted
//     user-uploaded content, and is re-validated with zod before it is ever
//     persisted or returned - never trusted just because the API call
//     succeeded or the JSON parsed.
//   - Every failure mode is a typed, non-throwing result
//     ({ success: false, reason, message }), never an unhandled exception or
//     a silent empty-notes return. `not_configured` (OPENAI_API_KEY unset)
//     is the expected, first-class path in this environment as of MEM-005's
//     ship date - see CLAUDE.md HARD STOP 6 / this ticket's dispatch notes:
//     OPENAI_API_KEY is not yet provisioned in Vercel, so this path is what
//     every real deployed request currently takes, not a rare edge case.
//
// Two-layer rate limiting (HARD STOP 6) is NOT this module's job - it lives
// in lib/notesLimits.ts, called by the route before this function, mirroring
// MEM-004's lib/uploadLimits.ts split (generation logic vs. quota
// enforcement are separate concerns, separately testable).
const SYSTEM_PROMPT = `You are an expert study-notes writer. Given raw source material (a student's uploaded document or pasted text), produce structured, genuinely useful study notes by calling the generate_study_notes tool.

Rules:
- Do not simply repeat or lightly rephrase the source text. Synthesize it: organize it into logical sections and distill each into concise, study-ready bullet points a student could review quickly before an exam.
- "title" should describe the actual subject matter of the material, not a generic label like "Notes" or "Summary".
- "summary" is a short overview (2-4 sentences) of what the material covers, written for someone who has not read it yet.
- "sections" should reflect the real structure or topics in the material (e.g. by chapter, theme, or concept) - not an arbitrary chunking of the raw text.
- "keyConcepts" should surface the specific terms, definitions, formulas, or facts most likely to matter for later review or a quiz. Only include real terms/concepts drawn from the material - never invent ones that aren't there.
- Base everything strictly on the provided material. Do not add outside facts, and do not invent details the material does not support.`

const GENERATE_NOTES_TOOL_NAME = 'generate_study_notes'

// Same OpenAI function-calling shape as Propinno's lib/nlpCriteria.ts
// ({type: 'function', function: {name, description, parameters}}), with a
// schema suited to notes rather than criteria extraction.
const GENERATE_NOTES_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: GENERATE_NOTES_TOOL_NAME,
    description: 'Report structured study notes generated from the provided course material.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short, descriptive title for these notes, derived from the material (not a generic label).',
        },
        summary: {
          type: 'string',
          description: 'A 2-4 sentence overview of what this material covers.',
        },
        sections: {
          type: 'array',
          description: 'The material broken into logical sections, each with a heading and bullet-point notes.',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: 'This section\'s topic.' },
              bullets: {
                type: 'array',
                items: { type: 'string' },
                description: 'Concise, study-ready bullet points for this section.',
              },
            },
            required: ['heading', 'bullets'],
          },
        },
        keyConcepts: {
          type: 'array',
          description: 'Important terms/concepts from the material with a short definition, for quick review.',
          items: {
            type: 'object',
            properties: {
              term: { type: 'string' },
              definition: { type: 'string' },
            },
            required: ['term', 'definition'],
          },
        },
      },
      required: ['title', 'summary', 'sections', 'keyConcepts'],
    },
  },
}

// Reasonable sanity bounds on the model's own output - this is generated
// content a user will read and (via app/api/documents/[id]/notes) is
// persisted verbatim into notes.content, so it's validated the same way
// Propinno's nlpCriteria.ts validates model output before trusting it, not
// just type-checked.
export const generatedNotesSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(1).max(200),
        bullets: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
      })
    )
    .min(1)
    .max(30),
  keyConcepts: z
    .array(
      z.object({
        term: z.string().trim().min(1).max(200),
        definition: z.string().trim().min(1).max(1000),
      })
    )
    .max(50),
})

export type GeneratedNotes = z.infer<typeof generatedNotesSchema>

export type GenerateNotesResult =
  | { success: true; data: GeneratedNotes }
  | {
      success: false
      reason: 'not_configured' | 'empty_input' | 'invalid_response' | 'api_error'
      message: string
    }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// documents.raw_text can be up to MEM-004's own 200k-character cap
// (app/api/documents/route.ts's MAX_TEXT_CHARS) - far more than is sane or
// necessary to send in a single prompt. 60k characters (~15k tokens, well
// inside gpt-4o-mini's context window with room for the system prompt and a
// generous structured-output response) covers a genuinely long multi-lecture
// document while keeping prompt size, latency, and per-call cost bounded and
// predictable - important on an endpoint HARD STOP 6 specifically exists to
// bound the cost of. Truncating loses some tail content on unusually long
// documents rather than failing the request outright; a future ticket could
// chunk-and-merge instead if that tradeoff turns out to matter in practice.
const MAX_INPUT_CHARS = 60_000

// gpt-4o-mini, same model Propinno's lib/nlpCriteria.ts uses: this is a
// structured-extraction/synthesis task with a forced schema, not open-ended
// creative writing, so a fast/cheap model is the right fit - especially
// given this endpoint's daily budget cap is sized assuming a low per-call
// cost (see lib/notesLimits.ts).
const MODEL = 'gpt-4o-mini'

/**
 * Generates structured study notes from `rawText` via OpenAI forced
 * tool-use, zod-validates the result, and never throws - every failure mode
 * (including OPENAI_API_KEY being unset) returns a typed, caller-safe
 * result instead of an unhandled exception or silent empty notes.
 */
export async function generateNotesFromText(rawText: string): Promise<GenerateNotesResult> {
  const trimmed = rawText.trim()
  if (!trimmed) {
    return {
      success: false,
      reason: 'empty_input',
      message: 'This document has no text to generate notes from.',
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.warn('AI notes generation requested but OPENAI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `AI notes generation isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  const sourceText = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed

  try {
    const client = new OpenAI({ apiKey })
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: sourceText },
      ],
      tools: [GENERATE_NOTES_TOOL],
      tool_choice: { type: 'function', function: { name: GENERATE_NOTES_TOOL_NAME } },
    })

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0]
    // As in nlpCriteria.ts: the SDK's tool-call type is a union of a
    // function-tool-call shape (`.function.arguments`) and a "custom tool"
    // shape with no `.function`. Only a `type: 'function'` tool is ever
    // declared/forced above, so a real response can only come back as the
    // function variant - this narrows the type rather than assuming it.
    if (!toolCall || toolCall.type !== 'function') {
      logger.warn(
        { finishReason: completion.choices[0]?.finish_reason },
        'AI notes generation: no tool call in OpenAI response'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate notes from this document. ${FALLBACK_MESSAGE}`,
      }
    }

    let rawOutput: unknown
    try {
      rawOutput = JSON.parse(toolCall.function.arguments)
    } catch (parseErr) {
      logger.warn({ err: parseErr }, 'AI notes generation: tool call arguments were not valid JSON')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate notes from this document. ${FALLBACK_MESSAGE}`,
      }
    }

    const parsed = generatedNotesSchema.safeParse(rawOutput)
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
        'AI notes generation: validation failed'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate valid notes from this document. ${FALLBACK_MESSAGE}`,
      }
    }

    return { success: true, data: parsed.data }
  } catch (err) {
    logger.error({ err }, 'AI notes generation failed')
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong generating notes. ${FALLBACK_MESSAGE}`,
    }
  }
}

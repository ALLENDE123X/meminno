import OpenAI from 'openai'
import { z } from 'zod'
import { logger } from '@/lib/logger'

// MEM-013: AI-generated 2-speaker podcast script ("Audio Overview" style,
// the NotebookLM-equivalent core differentiator for the AI-podcast feature)
// from a document's raw text (documents.raw_text, populated by MEM-004's
// upload flow). This module is deliberately JUST the generation function -
// text-to-speech synthesis per turn is MEM-014, and the route wiring
// (including this endpoint's own two-layer rate limiting) is MEM-015, per
// this ticket's dispatch scope. Do not add route-level rate limiting here.
//
// Architecture mirrored directly from lib/notesGeneration.ts /
// lib/quizGeneration.ts, per this ticket's dispatch instructions to copy
// their exact architecture rather than invent a new one:
//   - OpenAI Chat Completions with FORCED tool-use (`tool_choice` pinned to
//     one function), not free-text generation + regex/string-splitting.
//   - `strict: true` OpenAI structured-outputs mode (lib/quizGeneration.ts's
//     MEM-007-fix pattern, issue #26), adopted here from the start rather
//     than only after a production failure: an array of speaker-tagged turns
//     is exactly the shape (an array of objects with multiple required
//     fields) that was found in production to fail non-strict forced
//     tool-use for the quiz module, and there's no reason to expect a
//     two-speaker turns array to be any more reliable non-strict. The
//     residual failure rate that strict mode CANNOT catch (a perfectly
//     shaped response that is simply too long) is what issue #65 later
//     added the bounded retry below for - see MAX_ATTEMPTS.
//   - The tool-call output is untrusted model output derived from
//     user-uploaded content, and is re-validated with zod before it is ever
//     persisted or returned - never trusted just because the API call
//     succeeded or the JSON parsed.
//   - Every failure mode is a typed, non-throwing result
//     ({ success: false, reason, message }), never an unhandled exception or
//     a silent empty-script return.
//
// Two-layer rate limiting (HARD STOP 6) is NOT this module's job, for the
// same reason it isn't lib/notesGeneration.ts's/lib/quizGeneration.ts's job -
// it belongs in the calling route (MEM-015's lib/podcastLimits.ts, not built
// yet), mirroring the generation-logic-vs-quota-enforcement split every
// other lib/*Generation.ts module in this repo follows.
//
// A function rather than a plain const (issue #65) purely so it can
// interpolate MAX_TOTAL_WORDS, which is declared further down: the prompt now
// states the HARD ceiling as well as the soft target, and a prompt that
// hardcodes "800" while the constant says something else is exactly the drift
// that caused issue #63. Evaluated per call, so there is no
// temporal-dead-zone problem referencing a later const.
function buildSystemPrompt(): string {
  return `You are an expert podcast script writer creating a natural, engaging two-person "Audio Overview" style podcast conversation from a student's study material, in the style popularized by NotebookLM. Given raw source material (a document's extracted or pasted text), produce a complete podcast script by calling the generate_podcast_script tool.

Speakers:
- Exactly two speakers, labeled "A" and "B" - no other labels.
- Speaker A is the more prepared host: they've read the material closely and drive the conversation, walking through its key ideas in a sensible order.
- Speaker B is an engaged co-host who has NOT read the material in advance: they ask genuine clarifying questions, react in the moment, occasionally push back with "wait, why does that matter?" or "okay but how does that work?", and periodically restate what they just heard in their own words to check understanding - a real technique that makes review material easier to retain than a dry monologue.

Make it sound like two real people talking, not a monologue arbitrarily split between two names:
- Natural backchanneling throughout ("mhm", "right", "oh interesting", "totally", "yeah exactly", "huh").
- Genuine reactions and follow-up questions ("wait, really?", "okay so basically...", "why is that though?").
- Occasional interruptions, or a speaker picking up mid-thought from the other - written as short, natural turns, never as stage directions or bracketed notes.
- Verbal fillers used sparingly and naturally ("so", "I mean", "honestly"), not on every line - overusing them reads as fake, not natural.
- Varying turn length: some turns are a single short reaction (just a few words), others are a longer explanation. A real conversation is not evenly paced, and not every turn needs to teach something - some turns exist purely to react.
- Never write "[laughs]", sound-effect cues, or other bracketed stage directions - only what a speaker actually says.

Content:
- Cover the real substance of the material - the concepts, facts, and structure actually present in the source - not a vague gloss over it.
- Base everything strictly on the provided material. Do not add outside facts, and do not invent details the material does not support.
- Open with a brief, natural cold-open that sets up what this material covers - no "Welcome to the show" radio-announcer framing. Close with a short, natural wrap-up, not an abrupt stop.
- Target a natural 3.5-5 minute spoken conversation at a conversational pace (about 150 words per minute), which works out to roughly 500-700 total words across all turns combined (issue #63: lowered from an original 750-1050 target after real production TTS output showed that word count runs close enough to podcastAudio.ts's hard 7,000-character synthesis ceiling to leave no real safety margin). Do not pad to hit a word count - a slightly shorter, tighter conversation that genuinely covers the material well is better than a bloated one that doesn't.
- HARD LIMIT: the finished script must never exceed ${MAX_TOTAL_WORDS} total words across all turns combined. A script over that length is rejected outright and cannot be turned into audio at all, so going over is worse than leaving material out.
- Long, dense, multi-topic source material (a full textbook chapter, a whole course reader, a 50+ page PDF) will NOT fit in ${MAX_TOTAL_WORDS} words, and trying to touch every topic in it produces a rushed script that is both over the limit and useless to study from. Choose the handful of ideas that matter most, cover those properly, and deliberately leave the rest out. Dropping whole topics is the correct way to stay within the limit; compressing every turn into dense narration is not.`
}

const GENERATE_PODCAST_SCRIPT_TOOL_NAME = 'generate_podcast_script'

// Same OpenAI function-calling shape as lib/notesGeneration.ts /
// lib/quizGeneration.ts ({type: 'function', function: {name, description,
// parameters}}), with a schema suited to a speaker-tagged turns array.
//
// `strict: true` (see the header comment above for why this module adopts it
// from the start rather than after an observed failure, unlike
// lib/quizGeneration.ts originally did). Strict mode requires every object in
// the schema to set `additionalProperties: false` and list every property as
// `required` (no optional fields) - both object levels below already satisfy
// that, so no schema compromise was needed to enable it.
const GENERATE_PODCAST_SCRIPT_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: GENERATE_PODCAST_SCRIPT_TOOL_NAME,
    description: 'Report a two-speaker podcast script generated from the provided source material.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        turns: {
          type: 'array',
          description:
            'The full podcast script, in speaking order, as a sequence of speaker-tagged turns forming a natural back-and-forth conversation.',
          items: {
            type: 'object',
            properties: {
              speaker: {
                type: 'string',
                enum: ['A', 'B'],
                description: 'Which of the two speakers says this turn.',
              },
              text: {
                type: 'string',
                description:
                  "This turn's spoken line - natural conversational speech (a reaction, question, or explanation), not a written/textbook sentence.",
              },
            },
            required: ['speaker', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['turns'],
      additionalProperties: false,
    },
  },
}

// Word count is only ever an approximation of spoken duration, so these are
// sanity bounds around the system prompt's ~500-700 word target (see
// SYSTEM_PROMPT above), not an attempt to enforce that target exactly -
// mirroring how lib/flashcardsGeneration.ts's/lib/quizGeneration.ts's schema
// bounds are deliberately looser than their own prompt targets, existing
// only to catch a genuinely broken or abusive response (e.g. a handful of
// words, or the whole source document dumped back verbatim) rather than to
// police the model's judgment call on pacing.
// Exported (rather than kept module-private like MIN_TURNS/MAX_TURNS below)
// specifically so tests/unit/podcastScript.test.ts can assert the
// MAX_TOTAL_WORDS <-> podcastAudio.ts MAX_SCRIPT_CHARS invariant this ticket
// exists to fix directly against the real constants, instead of a hardcoded
// literal that could silently drift from either module.
export const MIN_TOTAL_WORDS = 400

// MAX_TOTAL_WORDS (issue #63 post-ship fix, 2026-08-11): this used to be
// 1600, sized by naive word-count arithmetic with no regard for
// lib/podcastAudio.ts's downstream MAX_SCRIPT_CHARS = 7_000 hard TTS-input
// ceiling. That let a dense source document (a real 50+ page econometrics
// PDF, hit live by the founder's own usage) push the model toward the top of
// its word budget and produce a script that generated_podcast_script/zod
// happily accepted but podcastAudio.ts then hard-rejected as
// "script_too_long" - a real production failure, not a hypothetical.
//
// Recomputed from REAL measured output, not a words-times-average-word-length
// guess: lib/podcastAudio.ts's own header comment records a genuine live
// synthesis run from MEM-014 - an 831-word two-speaker script whose built TTS
// prompt (the exact string checked against MAX_SCRIPT_CHARS, including the
// "A: "/"B: " speaker-prefix and newline formatting overhead
// buildMultiSpeakerPrompt() adds per turn) measured 5,220 characters. That is
// ~6.28 characters per word of natural spoken dialogue - punctuation,
// contractions, and per-turn formatting overhead all included, which is
// exactly the kind of real-world density a naive arithmetic estimate misses.
// Applying that measured ratio to the *old* 1600-word ceiling predicts
// ~10,050 characters, matching the issue's own observed 9,000-10,000 char
// range almost exactly - strong confirmation the ratio is real, not an
// artifact of one lucky/unlucky sample.
//
// New ceiling: 800 words x ~6.28 chars/word ~= 5,025 characters, which is
// ~72% of the 7,000-char cap - a genuine ~28% safety margin, not a
// razor-thin one (contrast the 300s Vercel maxDuration budget elsewhere in
// this codebase, whose ~17% margin is explicitly called out in
// ARCHITECTURE.md as "not a comfortable margin"). Even in the pathological
// case of MAX_TURNS (200) worth of very short turns at exactly this word
// count - maximizing the fixed per-turn "A: "/newline formatting overhead
// baked into the ratio above - the built prompt still lands around 86% of
// the cap, comfortably inside it. See ARCHITECTURE.md's MEM-013/MEM-014
// sections for the full write-up.
export const MAX_TOTAL_WORDS = 800

// A 3.5-5 minute natural conversation with real backchanneling/interruptions
// (per the system prompt) is made of many short exchanges, not a handful of
// long speeches - so the floor guards against a degenerate "monologue
// arbitrarily split into two or three turns" response, and the ceiling is a
// generous sanity cap against a runaway/spam response, not a realistic
// expectation.
const MIN_TURNS = 10
const MAX_TURNS = 200

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export const generatedPodcastScriptSchema = z
  .object({
    turns: z
      .array(
        z.object({
          speaker: z.enum(['A', 'B']),
          text: z.string().trim().min(1).max(2000),
        })
      )
      .min(MIN_TURNS)
      .max(MAX_TURNS),
  })
  // A "podcast" with only one speaker's turns populated is not a
  // conversation - catches the model collapsing to a monologue despite the
  // forced two-value speaker enum on every individual turn.
  .refine((script) => script.turns.some((t) => t.speaker === 'A') && script.turns.some((t) => t.speaker === 'B'), {
    message: 'A podcast script must include turns from both speakers, not just one',
    path: ['turns'],
  })
  .refine(
    (script) => {
      const totalWords = script.turns.reduce((sum, t) => sum + countWords(t.text), 0)
      return totalWords >= MIN_TOTAL_WORDS && totalWords <= MAX_TOTAL_WORDS
    },
    {
      message: `Generated script's total length must be roughly podcast-length (${MIN_TOTAL_WORDS}-${MAX_TOTAL_WORDS} words)`,
      path: ['turns'],
    }
  )

export type GeneratedPodcastScript = z.infer<typeof generatedPodcastScriptSchema>
export type PodcastScriptTurn = GeneratedPodcastScript['turns'][number]

export type GeneratePodcastScriptResult =
  | { success: true; data: GeneratedPodcastScript }
  | {
      success: false
      reason: 'not_configured' | 'empty_input' | 'invalid_response' | 'api_error'
      message: string
    }

/**
 * One attempt's result (issue #65). Same shape as the public
 * GeneratePodcastScriptResult plus `correction` - the corrective feedback a
 * failed attempt hands to the retry that follows it (see
 * buildRetryCorrection). Internal: never returned to a caller.
 */
type PodcastScriptAttempt =
  | { success: true; data: GeneratedPodcastScript }
  | {
      success: false
      reason: 'not_configured' | 'empty_input' | 'invalid_response' | 'api_error'
      message: string
      correction?: string
    }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// documents.raw_text can be up to MEM-004's own 200k-character cap
// (app/api/documents/route.ts's MAX_TEXT_CHARS). Same bound and reasoning as
// lib/notesGeneration.ts's/lib/quizGeneration.ts's MAX_INPUT_CHARS: 60k
// characters (~15k tokens) covers a genuinely long multi-lecture document
// while keeping prompt size, latency, and per-call cost bounded and
// predictable - important on an endpoint HARD STOP 6 specifically exists to
// bound the cost of, once MEM-015 wires the route. Mirrors the existing
// convention exactly rather than inventing a new truncation scheme, per this
// ticket's dispatch instructions. Truncating loses some tail content on
// unusually long documents rather than failing the request outright; a
// future ticket could summarize-then-script in two calls instead if that
// tradeoff turns out to matter in practice for source material this long.
const MAX_INPUT_CHARS = 60_000

// gpt-5.6-luna: OpenAI's current low-cost tier (GA 2026-07-09,
// $0.20/1M input + $1.20/1M output tokens post the 2026-07-30 price cut, per
// this ticket's dispatch). Confirmed present as a first-class literal in the
// installed openai SDK's own ChatModel union
// (node_modules/openai/resources/shared.d.ts) - not just accepted via the
// SDK's `(string & {})` fallback - so no cast/workaround is needed to use it.
// Deliberately NOT gpt-4o-mini (the model lib/notesGeneration.ts/
// lib/flashcardsGeneration.ts/lib/quizGeneration.ts all use): this ticket's
// dispatch explicitly confirmed gpt-5.6-luna as current and correct for this
// module, and natural multi-speaker conversational writing benefits more
// from a newer/stronger model than the other three modules' comparatively
// mechanical structured-extraction tasks do.
const MODEL = 'gpt-5.6-luna'

// Same reasoning as lib/notesGeneration.ts's/lib/quizGeneration.ts's
// OPENAI_TIMEOUT_MS/OPENAI_MAX_RETRIES (issue #24, maxDuration audit): the
// openai SDK's own defaults (10-minute timeout, 2 retries per attempt) are
// far longer than any sane route `maxDuration`, so a hung call would
// otherwise be killed opaquely by the platform instead of returning the
// typed `api_error` result this module already handles. Worst case here is
// OPENAI_MAX_RETRIES + 1 attempts x OPENAI_TIMEOUT_MS = 2 x 20s = 40s.
// MEM-015 (this module's route) should size its own `maxDuration` with this
// budget - plus session/DB/Redis/rate-limit overhead around the call - in
// mind, the same way app/api/documents/[id]/notes/route.ts's 60s and
// app/api/notes/[id]/quiz/route.ts's 120s were each sized against their own
// generation module's worst case.
//
// Issue #65 added a second attempt on top of this WITHOUT changing that 40s
// figure - see SCRIPT_GEN_BUDGET_MS below, which is the whole point of how
// that retry is built. Real measured latency for ONE attempt on a genuinely
// dense ~29,000-character source document is 12-16s (seven live runs during
// issue #65), so 20s is a real but not generous per-attempt allowance - do
// not shorten it to buy budget for the retry.
const OPENAI_TIMEOUT_MS = 20_000
const OPENAI_MAX_RETRIES = 1

// ISSUE #65 TIMING BUDGET - READ BEFORE CHANGING ANY NUMBER ABOVE OR BELOW.
//
// This module's total wall-clock ceiling, retry included. Deliberately EXACTLY
// the pre-issue-#65 worst case (2 x 20s = 40s), because this module is the
// first of two sequential vendor calls inside
// app/api/documents/[id]/podcast/route.ts's single hard `maxDuration = 300`
// Vercel ceiling, whose pathological case already had only ~5s of slack:
//
//   script gen                                                        40s
//   TTS       lib/podcastAudio.ts GEMINI_TIMEOUT_MS, pathological     240s
//   upload    ~20MB WAV into Supabase Storage                          10s
//   overhead  session, burst, doc lookup, insert, 2 updates, signing    5s
//                                                            total    295s  (5s margin)
//
// A naive copy of lib/quizGeneration.ts's retry - a second attempt paying its
// own (OPENAI_MAX_RETRIES + 1) x OPENAI_TIMEOUT_MS - makes script gen 2 x 40s
// = 80s and that case 80 + 240 + 10 + 5 = 335s: 35s OVER a hard platform
// ceiling. Going over does not degrade gracefully - the function is killed
// mid-flight, so nothing marks the `podcasts` row failed and it strands at
// 'generating', the exact bug issue #50's review fixed with that route's
// STALE_GENERATING_MS recovery.
//
// So the retry is DEADLINE-AWARE: it runs only when attempt 1 finished with a
// full OPENAI_TIMEOUT_MS still left inside this 40s, and gets no SDK-level
// retries of its own (maxRetries: 0) - it corrects a VALIDATION failure, not a
// transient network fault, which attempt 1's own retry budget already covers.
// Worst case is therefore max(40s, <=20s elapsed + 20s) = 40s, so the route's
// maxDuration arithmetic above stays true and needed no revision. Measured
// reality: one attempt is 12-16s, so the retry normally gets its full 20s and
// the module returns in ~25s.
const SCRIPT_GEN_BUDGET_MS = (OPENAI_MAX_RETRIES + 1) * OPENAI_TIMEOUT_MS

// Real finding from a live smoke-test call against the actual OpenAI API
// during MEM-013 (not documented anywhere else, since this is the first
// caller of a "-luna" reasoning-tier model in this codebase): gpt-5.6-luna
// is a reasoning model, and OpenAI's /v1/chat/completions endpoint rejects
// ANY request that combines function/tool calling with reasoning enabled -
// `400 Function tools with reasoning_effort are not supported for
// gpt-5.6-luna in /v1/chat/completions. To use function tools, use
// /v1/responses or set reasoning_effort to 'none'.` Forced tool-use is this
// module's whole architecture (per this ticket's dispatch instructions to
// mirror lib/notesGeneration.ts/lib/quizGeneration.ts), so the fix is to
// pass `reasoning_effort: 'none'` on every call rather than migrating this
// one module off Chat Completions onto the Responses API that every other
// generation module in this codebase does not use. This also keeps latency
// predictable against OPENAI_TIMEOUT_MS above - reasoning tokens are billed
// and add latency neither of which this task (structured extraction of a
// conversation script, not multi-step logical reasoning) benefits from.
const REASONING_EFFORT = 'none'

/**
 * Best-effort total word count of a tool-call response that PARSED as JSON but
 * failed zod validation. Deliberately tolerant of any shape - it is reading
 * output already known to be invalid - and returns null when there is nothing
 * countable, so callers can tell "1,043 words" apart from "no idea".
 */
function totalWordsOfRawOutput(rawOutput: unknown): number | null {
  if (typeof rawOutput !== 'object' || rawOutput === null) return null
  const turns = (rawOutput as { turns?: unknown }).turns
  if (!Array.isArray(turns)) return null

  let total = 0
  for (const turn of turns) {
    if (typeof turn !== 'object' || turn === null) continue
    const text = (turn as { text?: unknown }).text
    if (typeof text === 'string') total += countWords(text)
  }
  return total
}

// The retry's corrective feedback (issue #65) - the part that makes the retry
// worth having, and deliberately NOT lib/quizGeneration.ts's pattern. That
// module re-rolls an identical request, correct for its failure mode (a
// malformed-JSON sample a re-roll fixes). This module's is different in kind:
// the model overshoots the word ceiling on dense, broad material, a systematic
// tendency of the prompt-plus-document pair rather than an unlucky sample.
// Three identical live calls during issue #65 produced three overshooting
// scripts and zero valid ones, so a blind re-roll was 0-for-3 here - not
// merely less elegant. Telling the model what it did wrong, with the measured
// number, is what makes the retry a fix.
//
// Only produced when there is something real to report (a parsed response we
// could count). A response that never parsed gets a plain re-roll rather than
// invented feedback.
function buildRetryCorrection(rawOutput: unknown): string | undefined {
  const totalWords = totalWordsOfRawOutput(rawOutput)
  if (totalWords === null) return undefined

  if (totalWords > MAX_TOTAL_WORDS) {
    return `Your previous attempt was REJECTED. It came back at ${totalWords} total words, over the hard ${MAX_TOTAL_WORDS}-word limit, so it could not be used at all. Write a genuinely shorter script this time: aim for about ${SHORTER_RETRY_TARGET_WORDS} total words, and never exceed ${MAX_TOTAL_WORDS}. The source material is broader than this length can cover - so cover FEWER topics, not the same topics faster. Pick the few ideas that matter most, explore those properly, and drop the rest of the material entirely.`
  }

  if (totalWords < MIN_TOTAL_WORDS) {
    return `Your previous attempt was REJECTED. It came back at only ${totalWords} total words, under the ${MIN_TOTAL_WORDS}-word minimum, so it could not be used at all. Write a fuller script this time: aim for about ${SHORTER_RETRY_TARGET_WORDS} total words by exploring the key ideas in more depth and letting the two speakers genuinely work through them, rather than by padding with filler.`
  }

  return `Your previous attempt was REJECTED as structurally invalid. The script must have at least ${MIN_TURNS} turns, must include turns from BOTH speakers "A" and "B" (never one speaker alone), and must total between ${MIN_TOTAL_WORDS} and ${MAX_TOTAL_WORDS} words. Follow all of those exactly this time.`
}

/**
 * One OpenAI call + parse + validate attempt, factored out of
 * generatePodcastScriptFromText so it can be tried up to MAX_ATTEMPTS times
 * without duplicating the request/parse/validate logic - the same split
 * lib/quizGeneration.ts's attemptGenerateQuiz uses. Never throws: api_error is
 * caught and returned as a typed result, exactly as before this was split out.
 *
 * `correction` is the retry's corrective feedback (see buildRetryCorrection).
 * It is appended as a trailing system message rather than being folded into
 * the user message on purpose: the user message is untrusted, user-uploaded
 * document text, and blending our own instructions into it would blur exactly
 * the boundary that keeps document content from reading as instructions.
 */
async function attemptGeneratePodcastScript(
  client: OpenAI,
  promptText: string,
  correction?: string
): Promise<PodcastScriptAttempt> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: promptText },
  ]
  if (correction) messages.push({ role: 'system', content: correction })

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: [GENERATE_PODCAST_SCRIPT_TOOL],
      tool_choice: { type: 'function', function: { name: GENERATE_PODCAST_SCRIPT_TOOL_NAME } },
      reasoning_effort: REASONING_EFFORT,
    })

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0]
    // As in lib/notesGeneration.ts / lib/quizGeneration.ts: the SDK's
    // tool-call type is a union of a function-tool-call shape
    // (`.function.arguments`) and a "custom tool" shape with no `.function`.
    // Only a `type: 'function'` tool is ever declared/forced above, so a
    // real response can only come back as the function variant - this
    // narrows the type rather than assuming it.
    if (!toolCall || toolCall.type !== 'function') {
      logger.warn(
        { finishReason: completion.choices[0]?.finish_reason },
        'AI podcast script generation: no tool call in OpenAI response'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate a podcast script from this document. ${FALLBACK_MESSAGE}`,
      }
    }

    let rawOutput: unknown
    try {
      rawOutput = JSON.parse(toolCall.function.arguments)
    } catch (parseErr) {
      logger.warn({ err: parseErr }, 'AI podcast script generation: tool call arguments were not valid JSON')
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate a podcast script from this document. ${FALLBACK_MESSAGE}`,
      }
    }

    const parsed = generatedPodcastScriptSchema.safeParse(rawOutput)
    if (!parsed.success) {
      logger.warn(
        {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          totalWords: totalWordsOfRawOutput(rawOutput),
        },
        'AI podcast script generation: validation failed'
      )
      return {
        success: false,
        reason: 'invalid_response',
        message: `Couldn't generate a valid podcast script from this document. ${FALLBACK_MESSAGE}`,
        correction: buildRetryCorrection(rawOutput),
      }
    }

    return { success: true, data: parsed.data }
  } catch (err) {
    logger.error({ err }, 'AI podcast script generation failed')
    return {
      success: false,
      reason: 'api_error',
      message: `Something went wrong generating this podcast script. ${FALLBACK_MESSAGE}`,
    }
  }
}

// Two attempts total, not a loop - same bound, and the same reasoning, as
// lib/quizGeneration.ts's MAX_ATTEMPTS: keep worst-case latency and cost on
// this endpoint predictable, and never loop unboundedly against a billed
// vendor. Only `invalid_response` is retried. Not `api_error` (a real
// network/API-level failure; the SDK-level retry budget on the first attempt
// already covers the transient case) and not `not_configured`/`empty_input`
// (retrying a request that can never succeed wastes a billed call for
// nothing).
//
// Rate-limit/budget interaction (CLAUDE.md HARD STOP 6): identical to quiz
// generation's. This retry is internal to this function and invisible to the
// caller - app/api/documents/[id]/podcast/route.ts claims its budget unit
// exactly once per POST, BEFORE calling this, so a retry here can never
// double-claim a day's quota. It does mean one POST can cost up to two real
// OpenAI script calls (~$0.002 each at gpt-5.6-luna's rates, against a
// podcast's ~$0.10 all-in cost, which is dominated by the TTS call) - an
// accepted, explicitly bounded tradeoff.
const MAX_ATTEMPTS = 2

// What the corrective retry asks for instead of the system prompt's 500-700:
// the midpoint of the valid range, deliberately well clear of BOTH bounds.
// The retry only ever runs after the model already missed a bound, so aiming
// it back at the edge it just overshot would be asking for the same failure.
const SHORTER_RETRY_TARGET_WORDS = Math.round((MIN_TOTAL_WORDS + MAX_TOTAL_WORDS) / 2)

/**
 * Generates a natural, two-speaker podcast script from `sourceText` (a
 * document's raw/extracted text) via OpenAI forced tool-use with structured
 * outputs (`strict: true`), zod-validates the result, and never throws -
 * every failure mode (including OPENAI_API_KEY being unset) returns a typed,
 * caller-safe result instead of an unhandled exception or a silent
 * empty-script return.
 *
 * Retries ONCE on `invalid_response`, with corrective feedback and inside a
 * fixed 40s total budget - see SCRIPT_GEN_BUDGET_MS for the full timing
 * arithmetic against the calling route's hard 300s ceiling, and
 * buildRetryCorrection for why the retry is corrective rather than a re-roll.
 */
export async function generatePodcastScriptFromText(sourceText: string): Promise<GeneratePodcastScriptResult> {
  const trimmed = sourceText.trim()
  if (!trimmed) {
    return {
      success: false,
      reason: 'empty_input',
      message: 'This document has no text to generate a podcast script from.',
    }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    logger.warn('AI podcast script generation requested but OPENAI_API_KEY is not configured')
    return {
      success: false,
      reason: 'not_configured',
      message: `AI podcast generation isn't available right now. ${FALLBACK_MESSAGE}`,
    }
  }

  const promptText = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed
  const startedAt = Date.now()

  const client = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES })
  let result = await attemptGeneratePodcastScript(client, promptText)

  for (let attempt = 2; attempt <= MAX_ATTEMPTS && !result.success && result.reason === 'invalid_response'; attempt++) {
    // The deadline check that keeps this whole module inside the 40s the
    // calling route's maxDuration budget allots it. A retry only happens with
    // a FULL further attempt's worth of budget left; with less, giving up now
    // and returning the typed failure is strictly better than starting a call
    // that would be cut off mid-flight after burning the remaining seconds
    // (and being billed for it) - and the caller sees exactly the same
    // outcome it would have seen before this fix existed.
    const remainingMs = SCRIPT_GEN_BUDGET_MS - (Date.now() - startedAt)
    if (remainingMs < OPENAI_TIMEOUT_MS) {
      logger.warn(
        { attempt, remainingMs },
        'AI podcast script generation: skipping retry, not enough time budget left'
      )
      break
    }

    logger.warn(
      { attempt, remainingMs, corrected: Boolean(result.correction) },
      'AI podcast script generation: retrying once after invalid_response'
    )
    // No SDK-level retries on the retry (maxRetries: 0): it exists to correct
    // a validation failure, not a transient network fault, so stacking another
    // (OPENAI_MAX_RETRIES + 1) x OPENAI_TIMEOUT_MS budget on top would double
    // this module's worst case for no reliability gain. See
    // SCRIPT_GEN_BUDGET_MS.
    const retryClient = new OpenAI({ apiKey, timeout: OPENAI_TIMEOUT_MS, maxRetries: 0 })
    result = await attemptGeneratePodcastScript(retryClient, promptText, result.correction)
  }

  // `correction` is internal plumbing between the two attempts and is not part
  // of this module's public result contract - narrowed away explicitly rather
  // than leaked to callers by structural typing.
  if (result.success) return result
  return { success: false, reason: result.reason, message: result.message }
}

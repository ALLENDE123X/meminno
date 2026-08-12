import { NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'
import { logger } from '@/lib/logger'
import { getSessionUser, sessionErrorResponse } from '@/lib/session'
import { checkPodcastBurstLimit, claimPodcastBudget } from '@/lib/podcastLimits'
import { generatePodcastScriptFromText, type GeneratePodcastScriptResult } from '@/lib/podcastScript'
import { generatePodcastAudio, type GeneratePodcastAudioResult } from '@/lib/podcastAudio'
import { uploadPodcastAudio, createPodcastSignedUrl, type PodcastUploadResult } from '@/lib/podcastStorage'
import { withUserContext } from '@/lib/db'
import { documents, podcasts } from '@/lib/db/schema'

// MEM-015 (issue #50): the route that finally wires MEM-012 (schema) +
// MEM-013 (script) + MEM-014 (TTS/Storage/budget) into one user-visible
// action — "make a podcast out of this document."
//
// Shape and ordering are lifted from app/api/documents/[id]/notes/route.ts
// rather than invented: validate id -> session -> burst -> ownership-scoped
// document lookup -> request validation -> budget claim -> generate ->
// persist -> respond. Three things are genuinely different here, and each is
// a deliberate decision rather than a deviation for its own sake:
//
//   1. ONE budget claim covers TWO billed vendor calls (OpenAI for the
//      script, Google for the TTS). See lib/podcastLimits.ts's own
//      "NOTE FOR MEM-015" header: this is one user-visible action costing
//      ~$0.10 end to end, and claiming per sub-call would silently make the
//      documented cap mean half what it says.
//   2. A real `podcasts` row is written BEFORE generation starts and updated
//      on every terminal outcome. Every other generation route in this repo
//      inserts only on success, because they either succeed or leave nothing
//      behind. This one spends minutes and real money before it has anything
//      to persist, so a row that records 'generating' -> 'failed' (with the
//      typed reason in `error_message`) is the only way a caller or a future
//      UI can tell "this failed and why" apart from "nothing was ever
//      started" — which is exactly what MEM-012 added `status`/
//      `error_message` for.
//   3. It returns a freshly-minted signed URL alongside the row. See the
//      response-shape note further down.
//
// EXISTING-PODCAST HANDLING (issue #50 doesn't specify it; this is the
// judgment call, documented per this ticket's dispatch):
//   - An already-'ready' podcast for this document is RETURNED AS-IS, with a
//     fresh signed URL and 200 (not 201). It is not regenerated. A podcast
//     costs ~60x a notes/flashcards/quiz generation and the daily cap is
//     2/day free, so silently burning a user's whole day's allowance to
//     re-make something they already have is the wrong default — and unlike
//     notes/flashcards/quizzes (where each POST deliberately creates a new
//     row, since a second take is cheap and often what you want), there is
//     no cheap second take here. A future explicit `?regenerate=true` is the
//     right way to add one, when a UI actually asks for it.
//   - A 'pending'/'generating' row is treated as IN FLIGHT and rejected with
//     409, not joined and not duplicated. Generation is synchronous, so a
//     second concurrent request would spend a second full budget unit and a
//     second ~$0.10 producing a duplicate of what the first request is
//     already producing — the exact double-charge case a mashed button
//     causes. (The burst limiter narrows that window but does not close it:
//     it allows several requests within its window, and this one runs for
//     minutes.) 409 also fails safe against a genuinely stuck row: a caller
//     sees "already generating" rather than being charged again.
//   - A 'failed' row is NOT a blocker — a retry after a failure creates a
//     new row and generates for real. The failed row is left in place as the
//     record of what went wrong.
// Only ONE row is looked at: the newest for this document. That is what makes
// the three cases above mutually exclusive and cheap to reason about.
//
// maxDuration — this route is by far the longest-running in the codebase, and
// the number is pinned to the platform ceiling on purpose, not padded up to
// it. Worst-case math, all from real measurements in MEM-013/MEM-014:
//   script gen  (OPENAI_MAX_RETRIES + 1) x OPENAI_TIMEOUT_MS = 2 x 20s =  40s
//   TTS         one attempt, bounded by MAX_SCRIPT_CHARS = 7,000 chars at a
//               measured ~28ms/char                                    ~195s
//   upload      a ~20MB uncompressed WAV into Supabase Storage          ~10s
//   overhead    session, burst, doc lookup, insert, 2 updates, signing   ~5s
//                                                             total    ~250s
// That leaves ~50s of real margin at 300. It is NOT a comfortable margin, and
// the reason it can't be bigger is a hard platform limit rather than a
// choice: Vercel's Fluid Compute Hobby ceiling is 300s (see ARCHITECTURE.md's
// issue #24 section), and declaring more than the plan allows fails the
// deployment outright. The pathological case — Gemini burning its full 240s
// GEMINI_TIMEOUT_MS instead of finishing in ~195s — comes to ~295s and would
// be killed by the platform at 300 either way. MEM-014's ARCHITECTURE.md
// entry already names the honest fix if podcasts ever need to be longer than
// MAX_SCRIPT_CHARS allows: a background job, not a bigger timeout. Do not
// raise MAX_SCRIPT_CHARS without moving this off a synchronous request.
export const maxDuration = 300

// The union of every typed failure reason the three pipeline stages can
// produce, derived from their own result types rather than hand-listed — so
// a new reason added to any of those modules breaks this build instead of
// silently falling through to `undefined` as a status code.
type PodcastFailureReason =
  | Exclude<GeneratePodcastScriptResult, { success: true }>['reason']
  | Exclude<GeneratePodcastAudioResult, { success: true }>['reason']
  | Exclude<PodcastUploadResult, { success: true }>['reason']

// Same convention as every other generation route's REASON_STATUS table:
// missing credentials are 503, a model producing something unusable is 422
// (this is the caller's request being unfulfillable, not a crash), and an
// upstream vendor failing is 502. `invalid_script`/`script_too_long` sit with
// `invalid_response` because they are all the same class of event — a model
// returned something this pipeline can't use — even though they originate in
// different stages. `upload_failed` is 502 rather than 500: Supabase Storage
// is a third-party upstream, same as OpenAI and Gemini.
const REASON_STATUS: Record<PodcastFailureReason, number> = {
  not_configured: 503,
  empty_input: 422,
  invalid_response: 422,
  invalid_script: 422,
  script_too_long: 422,
  api_error: 502,
  upload_failed: 502,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shape returned to callers. Never includes `storagePath` — see below. */
type PodcastRow = typeof podcasts.$inferSelect

/**
 * `storagePath` is deliberately absent from every response. It is an internal
 * Storage key, not a capability: the only way to fetch audio is a signed URL
 * this server mints, so handing clients the raw path invites exactly the
 * direct-Storage-access pattern lib/podcastStorage.ts's access-control note
 * says would invalidate the whole "no storage.objects policies" design.
 *
 * An explicit allow-list rather than an omit-one-key spread, so a column added
 * to `podcasts` later has to be opted into the API surface deliberately
 * instead of appearing in it by default.
 */
function publicPodcast(row: PodcastRow) {
  return {
    id: row.id,
    documentId: row.documentId,
    userId: row.userId,
    status: row.status,
    durationSeconds: row.durationSeconds,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  }
}

/**
 * Marks a podcast row failed with the typed reason from whichever stage
 * failed. Never throws: the request is already failing, and losing the
 * user-facing error to a secondary DB error would be strictly worse than a
 * row left at 'generating'.
 *
 * `error_message` gets the short internal `reason` string, not the vendor's
 * own text — exactly what MEM-012's schema comment specifies that column is
 * for ("a short internal reason ... not raw third-party provider output
 * echoed straight back to a user").
 */
async function markPodcastFailed(userId: string, podcastId: string, reason: string): Promise<void> {
  try {
    await withUserContext(userId, (tx) =>
      tx
        .update(podcasts)
        .set({ status: 'failed', errorMessage: reason })
        .where(and(eq(podcasts.id, podcastId), eq(podcasts.userId, userId)))
    )
  } catch (err) {
    logger.error({ err, userId, podcastId, reason }, 'Failed to mark podcast row as failed')
  }
}

/** Mints a fresh signed URL, degrading to null rather than failing a caller. */
async function signIfReady(row: PodcastRow) {
  if (row.status !== 'ready' || !row.storagePath) return { audioUrl: null, expiresInSeconds: null }
  const signed = await createPodcastSignedUrl(row.storagePath)
  if (!signed.success) return { audioUrl: null, expiresInSeconds: null }
  return { audioUrl: signed.url, expiresInSeconds: signed.expiresInSeconds }
}

/** The newest podcast row for one document, or undefined. */
async function latestPodcastForDocument(userId: string, documentId: string): Promise<PodcastRow | undefined> {
  const [row] = await withUserContext(userId, (tx) =>
    tx
      .select()
      .from(podcasts)
      .where(and(eq(podcasts.documentId, documentId), eq(podcasts.userId, userId)))
      .orderBy(desc(podcasts.createdAt))
      .limit(1)
  )
  return row
}

/**
 * POST /api/documents/[id]/podcast — generate an Audio Overview for a
 * document the caller owns.
 *
 * 201 { podcast, audioUrl, expiresInSeconds } on a fresh generation.
 * 200 { podcast, audioUrl, expiresInSeconds, existing: true } when a ready
 *     podcast already existed (no budget spent, nothing regenerated).
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: documentId } = await context.params
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json({ error: 'Invalid document id' }, { status: 400 })
  }

  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId, plan } = session

  // Burst first: cheap, document-independent, and the one check that should
  // fire on a mashed button before any lookup happens at all. Same ordering
  // every other generation route uses, and the ordering lib/podcastLimits.ts's
  // header comment pins (burst -> validate -> claim), because both budget
  // calls increment a counter unconditionally and so must never be reached by
  // a request that was going to 404/409/422 anyway.
  const burst = await checkPodcastBurstLimit(userId)
  if (!burst.ok) {
    logger.warn({ userId, plan, documentId }, 'Podcast generation burst-limited')
    return NextResponse.json({ error: burst.reason }, { status: burst.status })
  }

  // Explicit userId filter alongside the RLS policy — defense in depth, same
  // convention as every other route here. Another user's document id 404s
  // exactly like a nonexistent one, and can never spend the caller's quota.
  const [doc] = await withUserContext(userId, (tx) =>
    tx.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.userId, userId)))
  )
  if (!doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Existing-podcast handling (see the header comment for the full reasoning).
  // Runs before the raw-text check on purpose: an already-generated podcast is
  // returnable regardless of what its source document looks like now.
  const existing = await latestPodcastForDocument(userId, documentId)
  if (existing?.status === 'ready') {
    const signed = await signIfReady(existing)
    return NextResponse.json({ podcast: publicPodcast(existing), ...signed, existing: true }, { status: 200 })
  }
  if (existing && (existing.status === 'pending' || existing.status === 'generating')) {
    return NextResponse.json(
      { error: 'A podcast for this document is already being generated. Check back in a few minutes.', podcast: publicPodcast(existing) },
      { status: 409 }
    )
  }

  if (!doc.rawText?.trim()) {
    // No quota claimed — a document with nothing to narrate should never cost
    // part of the caller's daily allowance.
    return NextResponse.json({ error: 'This document has no text to generate a podcast from' }, { status: 422 })
  }

  const budget = await claimPodcastBudget(userId, plan)
  if (!budget.ok) {
    logger.warn({ userId, plan, documentId }, 'Podcast generation budget limited')
    return NextResponse.json({ error: budget.reason }, { status: budget.status })
  }

  // 'generating', not 'pending': nothing queues this: the row is created by
  // the request that is already working on it. 'pending' is left meaning
  // "queued, nobody has started" for a future background-job version.
  const [podcast] = await withUserContext(userId, (tx) =>
    tx.insert(podcasts).values({ documentId, userId, status: 'generating' }).returning()
  )

  const script = await generatePodcastScriptFromText(doc.rawText)
  if (!script.success) {
    logger.warn({ userId, documentId, podcastId: podcast.id, reason: script.reason }, 'Podcast script generation failed')
    await markPodcastFailed(userId, podcast.id, script.reason)
    return NextResponse.json(
      { error: script.message, reason: script.reason, podcastId: podcast.id },
      { status: REASON_STATUS[script.reason] }
    )
  }

  const audio = await generatePodcastAudio(script.data.turns)
  if (!audio.success) {
    logger.warn({ userId, documentId, podcastId: podcast.id, reason: audio.reason }, 'Podcast audio synthesis failed')
    await markPodcastFailed(userId, podcast.id, audio.reason)
    return NextResponse.json(
      { error: audio.message, reason: audio.reason, podcastId: podcast.id },
      { status: REASON_STATUS[audio.reason] }
    )
  }

  const upload = await uploadPodcastAudio(userId, podcast.id, audio.audio)
  if (!upload.success) {
    logger.error({ userId, documentId, podcastId: podcast.id, reason: upload.reason }, 'Podcast audio upload failed')
    await markPodcastFailed(userId, podcast.id, upload.reason)
    return NextResponse.json(
      { error: upload.message, reason: upload.reason, podcastId: podcast.id },
      { status: REASON_STATUS[upload.reason] }
    )
  }

  const [ready] = await withUserContext(userId, (tx) =>
    tx
      .update(podcasts)
      .set({ status: 'ready', storagePath: upload.storagePath, durationSeconds: audio.durationSeconds })
      .where(and(eq(podcasts.id, podcast.id), eq(podcasts.userId, userId)))
      .returning()
  )

  // A fresh signed URL is returned with the row so a client that just waited
  // minutes for this doesn't need a second round trip to play it. It is minted
  // per response and never persisted anywhere (lib/podcastStorage.ts: the URL
  // is a one-hour bearer capability; podcasts.storage_path is the durable
  // thing). If signing itself fails, the podcast is still genuinely ready and
  // paid for — returning 201 with a null audioUrl and letting the client
  // re-ask via GET is honest; failing the whole request here would not be.
  const signed = await signIfReady(ready)
  logger.info(
    { userId, documentId, podcastId: ready.id, durationSeconds: ready.durationSeconds },
    'AI podcast generated'
  )
  return NextResponse.json({ podcast: publicPodcast(ready), ...signed }, { status: 201 })
}

/**
 * GET /api/documents/[id]/podcast — the newest podcast for this document,
 * with a freshly-minted signed URL when it's ready.
 *
 * Built in this ticket rather than deferred because MEM-016 (the player) has
 * to poll status and needs a playable URL on every page load, and the only
 * alternative would be re-POSTing — which is a mutating, budget-touching
 * endpoint. Signed URLs expire in an hour and are deliberately not persisted,
 * so "get me a fresh one" is a permanent requirement of the feature, not a
 * convenience.
 *
 * No rate limiting: this makes no billed vendor call (a DB read plus a signed
 * URL mint), so HARD STOP 6 does not apply — it is a read endpoint like
 * app/api/me, and MEM-016 is expected to poll it while a generation runs.
 *
 * 404 covers all of "no such document", "not your document", and "no podcast
 * yet", identically — a caller learns nothing about other users' data.
 */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id: documentId } = await context.params
  if (!UUID_RE.test(documentId)) {
    return NextResponse.json({ error: 'Invalid document id' }, { status: 400 })
  }

  const session = await getSessionUser(req)
  if (!session.ok) {
    const body = sessionErrorResponse(session.status)
    return NextResponse.json(body, { status: body.status })
  }
  const { userId } = session

  // Scoped by user_id as well as document_id, and read through
  // withUserContext, so RLS and the explicit filter each independently
  // guarantee a caller only ever sees their own row.
  const row = await latestPodcastForDocument(userId, documentId)
  if (!row) {
    return NextResponse.json({ error: 'No podcast found for this document' }, { status: 404 })
  }

  const signed = await signIfReady(row)
  return NextResponse.json({ podcast: publicPodcast(row), ...signed })
}

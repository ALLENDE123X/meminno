import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { PODCAST_AUDIO_FILE_EXTENSION, PODCAST_AUDIO_MIME_TYPE } from '@/lib/podcastAudio'

// MEM-014 (issue #49) — Meminno's FIRST Supabase Storage integration. There
// was no existing bucket, upload helper, or signed-URL pattern in this
// codebase to copy, so the design decisions are written out here rather than
// left implicit.
//
// ---------------------------------------------------------------------------
// BUCKET: `podcasts`, PRIVATE. Created once, out of band — not on first use.
// ---------------------------------------------------------------------------
// Locked by Pranav: private bucket plus short-lived signed URLs, not a public
// bucket. Creation is a one-time setup step run by hand against the project
// (`scripts/setup-podcast-storage.mjs`), deliberately NOT a lazy
// `createBucket()` on the first request. Same reasoning as CLAUDE.md's
// one-time SQL role bootstrap: infrastructure that exists exactly once should
// be an explicit, reviewable, re-runnable action, not a side effect hidden in
// a request path where it would need service-role bucket-creation privileges
// on every single call and could half-apply under concurrency.
//
// ---------------------------------------------------------------------------
// PATH: `podcasts/{userId}/{podcastId}.wav`
// ---------------------------------------------------------------------------
// That is the ticket's convention read literally: bucket `podcasts`, and
// `{userId}/{podcastId}.wav` as the object path INSIDE it — which is exactly
// how Supabase addresses it (`/object/podcasts/{userId}/{podcastId}.wav`).
// Nesting a second `podcasts/` prefix inside the `podcasts` bucket would be
// redundant. `podcasts.storagePath` (MEM-012's column) stores the in-bucket
// path — the `{userId}/{podcastId}.wav` part — because that is the exact
// string `createSignedUrl()` takes.
//
// The userId segment is not an access control (see below); it is there so a
// user's objects can be listed/deleted as a unit for account deletion or a
// GDPR-style erasure request, without a DB round trip.
//
// ---------------------------------------------------------------------------
// STORAGE RLS: deliberately NO `storage.objects` policies on this bucket.
// ---------------------------------------------------------------------------
// This is a real decision with a real justification, not an omission.
//
// Supabase Storage has its own policy system on `storage.objects`, separate
// from the Postgres RLS in lib/db/schema.ts. A private bucket with no
// policies is default-deny for `anon` and `authenticated`: a browser client
// holding a real user JWT cannot list, download, or upload anything in it.
// Uploads and signed-URL minting here run server-side under
// SUPABASE_SERVICE_ROLE_KEY, which bypasses bucket policies entirely — so any
// policy written today would have exactly zero effect on the only code path
// that exists.
//
// The actual access-control boundary is therefore: a caller can only obtain a
// signed URL by asking OUR server for one, and the server only mints it after
// reading the `podcasts` row through `withUserContext()`, where MEM-012's
// FORCE'd row-level policy already proves the row belongs to that caller. The
// database row is the gate; the signed URL is the capability it hands out.
// Writing decorative object policies on top of that would suggest clients
// touch Storage directly, which they must not.
//
// THE ONE THING THAT WOULD INVALIDATE THIS: if a future ticket ever gives the
// browser client direct Storage access (a client-side upload, a
// `supabase.storage.from('podcasts')` call in a component), object-level RLS
// on `storage.objects` becomes mandatory in that same PR, because the
// service-role-only assumption above stops holding. Until then, keeping the
// bucket unreachable by `anon`/`authenticated` at all is the stronger
// position, not the weaker one.

export const PODCAST_BUCKET = 'podcasts'

// One hour. A several-minute podcast has to survive a whole listening session,
// and `<audio>` re-issues range requests on every seek and replay, so an
// expiry measured in minutes would break scrubbing back through a lecture
// halfway in. An hour covers a full listen plus replays with room to spare.
//
// It is short for the reason signed URLs are short-lived at all: the URL is a
// bearer capability. Anyone who gets the link — from browser history, a
// screenshot, a shared devtools network tab — can fetch the file until it
// expires, with no further auth check. An hour bounds that window while
// staying invisible to a legitimate listener. MEM-015/016 should mint a fresh
// URL per page load rather than persisting one anywhere.
export const PODCAST_SIGNED_URL_TTL_SECONDS = 60 * 60

export type PodcastUploadResult =
  | { success: true; storagePath: string }
  | { success: false; reason: 'not_configured' | 'upload_failed'; message: string }

export type PodcastSignedUrlResult =
  | { success: true; url: string; expiresInSeconds: number }
  | { success: false; reason: 'not_configured' | 'sign_failed'; message: string }

const FALLBACK_MESSAGE = 'Please try again in a moment.'

// Both ids are UUIDs everywhere in this schema. Validating that before
// interpolating them into an object path keeps anything resembling `../` out
// of a storage key by construction, rather than trusting every future caller
// to have validated its inputs first.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The in-bucket object path for one podcast. See the PATH note above. */
export function podcastObjectPath(userId: string, podcastId: string): string | null {
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(podcastId)) return null
  return `${userId}/${podcastId}.${PODCAST_AUDIO_FILE_EXTENSION}`
}

/**
 * Service-role Supabase client, constructed per call rather than at module
 * scope so an unset key can't throw at import time — the same fail-closed
 * shape lib/audioTranscription.ts uses for its OpenAI client.
 *
 * This is NOT lib/supabase/server.ts: that one is the cookie-bound anon
 * client for a user's own PostgREST calls, which by design cannot write to a
 * private bucket. Storage writes need the service role. It never touches user
 * tables, so it cannot be used to sidestep the RLS the rest of the app
 * depends on; it only ever addresses the `podcasts` bucket, and only from
 * server code that has already proven ownership through the DB.
 */
function serviceRoleStorage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return null

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage.from(PODCAST_BUCKET)
}

/**
 * Uploads a finished podcast WAV. Never throws.
 *
 * `upsert: true` on purpose: regenerating a podcast for the same row, or
 * retrying after a failed DB write, should overwrite rather than error or
 * strand a second copy — the path is derived from the podcast id, so there is
 * exactly one correct object for it.
 */
export async function uploadPodcastAudio(userId: string, podcastId: string, audio: Buffer): Promise<PodcastUploadResult> {
  const storage = serviceRoleStorage()
  if (!storage) {
    logger.warn('Podcast upload requested but Supabase service-role credentials are not configured')
    return { success: false, reason: 'not_configured', message: `Podcast storage isn't available right now. ${FALLBACK_MESSAGE}` }
  }

  const path = podcastObjectPath(userId, podcastId)
  if (!path) {
    logger.warn('Podcast upload rejected: userId/podcastId are not both UUIDs')
    return { success: false, reason: 'upload_failed', message: `Couldn't save this podcast. ${FALLBACK_MESSAGE}` }
  }

  const { error } = await storage.upload(path, audio, {
    contentType: PODCAST_AUDIO_MIME_TYPE,
    upsert: true,
  })

  if (error) {
    logger.error({ err: error, path }, 'Podcast audio upload to Supabase Storage failed')
    return { success: false, reason: 'upload_failed', message: `Couldn't save this podcast. ${FALLBACK_MESSAGE}` }
  }

  return { success: true, storagePath: path }
}

/**
 * Mints a short-lived signed URL for a stored podcast. Never throws.
 *
 * CALLERS MUST HAVE ALREADY PROVEN OWNERSHIP of the `podcasts` row this path
 * came from (read it via `withUserContext()`), because the service role used
 * here bypasses Storage policies — this function signs whatever path it is
 * handed and performs no authorization of its own.
 */
export async function createPodcastSignedUrl(storagePath: string): Promise<PodcastSignedUrlResult> {
  const storage = serviceRoleStorage()
  if (!storage) {
    logger.warn('Podcast signed URL requested but Supabase service-role credentials are not configured')
    return { success: false, reason: 'not_configured', message: `Podcast playback isn't available right now. ${FALLBACK_MESSAGE}` }
  }

  const { data, error } = await storage.createSignedUrl(storagePath, PODCAST_SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) {
    logger.error({ err: error, storagePath }, 'Failed to create a signed URL for a stored podcast')
    return { success: false, reason: 'sign_failed', message: `Couldn't load this podcast. ${FALLBACK_MESSAGE}` }
  }

  return { success: true, url: data.signedUrl, expiresInSeconds: PODCAST_SIGNED_URL_TTL_SECONDS }
}

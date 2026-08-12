// One-time Supabase Storage bootstrap for the podcast feature (MEM-014,
// issue #49). Idempotent: safe to re-run, does nothing if the bucket already
// exists with the right settings.
//
// Run it by hand, once per Supabase project:
//
//   node --env-file=.env.local scripts/setup-podcast-storage.mjs
//
// Why a script instead of creating the bucket lazily on first upload: the
// same reasoning CLAUDE.md gives for its one-time SQL role bootstrap. A
// bucket is infrastructure that exists exactly once. Making it an explicit,
// reviewable, re-runnable action keeps a request path from needing
// bucket-creation privileges on every call, and keeps two concurrent first
// requests from racing each other. It also means a fresh Supabase project can
// be brought up by running this, rather than by rediscovering the settings.
//
// Requires SUPABASE_SERVICE_ROLE_KEY. Bucket creation is an admin operation;
// the anon key cannot do it.

import { createClient } from '@supabase/supabase-js'

const BUCKET = 'podcasts'

// Private, and that is the whole point: playback goes through short-lived
// signed URLs minted server-side only after lib/db's RLS has proven the
// requesting user owns the `podcasts` row. See lib/podcastStorage.ts's header
// for the full access-control reasoning, including why this bucket
// deliberately has no `storage.objects` policies.
const PUBLIC = false

// Only ever written by lib/podcastStorage.ts, which always uploads a WAV.
const ALLOWED_MIME_TYPES = ['audio/wav']

// Uncompressed 24kHz/16-bit mono PCM runs ~2.9MB per minute, so the longest
// podcast lib/podcastAudio.ts's MAX_SCRIPT_CHARS can produce is roughly 20MB.
// 50MB is comfortable headroom without leaving the bucket open to something
// wildly outside that shape.
const FILE_SIZE_LIMIT = 50 * 1024 * 1024

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceRoleKey) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.')
  console.error('Try: node --env-file=.env.local scripts/setup-podcast-storage.mjs')
  process.exit(1)
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const { data: buckets, error: listError } = await supabase.storage.listBuckets()
if (listError) {
  console.error('Could not list buckets:', listError.message)
  process.exit(1)
}

const existing = buckets.find((bucket) => bucket.name === BUCKET)

if (existing) {
  console.log(`Bucket "${BUCKET}" already exists (public: ${existing.public}).`)
  if (existing.public) {
    console.error('It is PUBLIC, which this feature must not use. Fix it in the Supabase dashboard before shipping.')
    process.exit(1)
  }
} else {
  const { error } = await supabase.storage.createBucket(BUCKET, {
    public: PUBLIC,
    allowedMimeTypes: ALLOWED_MIME_TYPES,
    fileSizeLimit: FILE_SIZE_LIMIT,
  })
  if (error) {
    console.error(`Could not create bucket "${BUCKET}":`, error.message)
    process.exit(1)
  }
  console.log(`Created private bucket "${BUCKET}".`)
}

console.log(`Done. Objects live at ${BUCKET}/{userId}/{podcastId}.wav, reachable only via server-minted signed URLs.`)

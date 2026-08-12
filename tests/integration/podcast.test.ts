import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { generatePodcastAudio } from '@/lib/podcastAudio'
import { uploadPodcastAudio, createPodcastSignedUrl, podcastObjectPath, PODCAST_BUCKET } from '@/lib/podcastStorage'

// The real MEM-014 chain, end to end, against real services: Gemini
// multi-speaker TTS -> raw PCM -> WAV container -> Supabase Storage upload ->
// signed URL -> HTTP fetch of the actual bytes. No mocks at any layer.
//
// OPT-IN ONLY, and gated deliberately rather than on credential presence
// alone, because unlike every other integration test in this repo this one
// SPENDS REAL MONEY on a billed vendor call. It is skipped in CI (which has
// neither key) and skipped locally unless RUN_LIVE_PODCAST_TEST=true is set
// explicitly, mirroring the opt-in gate Propinno puts on its own
// side-effect-heavy suite. Do not remove or weaken that gate, and do not set
// it in CI - a per-push billed TTS call is exactly the runaway-cost shape
// CLAUDE.md HARD STOP 6 exists to prevent.
//
// The script below is deliberately two short turns, not a real several-minute
// podcast: it exercises every step of the chain for a few tenths of a cent
// instead of the ~$0.10 a full-length synthesis costs.
const LIVE = process.env.RUN_LIVE_PODCAST_TEST === 'true' && !!process.env.GEMINI_API_KEY && !!process.env.SUPABASE_SERVICE_ROLE_KEY

const userId = randomUUID()
const podcastId = randomUUID()

describe.skipIf(!LIVE)('podcast audio + storage against the real Gemini and Supabase Storage', () => {
  afterAll(async () => {
    // Removes only the one object this test created.
    const path = podcastObjectPath(userId, podcastId)
    if (!path) return
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    await supabase.storage.from(PODCAST_BUCKET).remove([path])
  })

  it('synthesizes, stores, signs and serves a playable podcast', async () => {
    const generated = await generatePodcastAudio([
      { speaker: 'Alex', text: 'Quick one today. What does a mitochondrion actually do?' },
      { speaker: 'Sam', text: 'It converts what you ate into the energy currency your cells can spend.' },
    ])

    expect(generated.success).toBe(true)
    if (!generated.success) return
    expect(generated.durationSeconds).toBeGreaterThan(0)
    // A real RIFF/WAVE container, not the raw PCM Gemini returns.
    expect(generated.audio.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(generated.audio.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(generated.audio.readUInt32LE(24)).toBe(24_000)

    const uploaded = await uploadPodcastAudio(userId, podcastId, generated.audio)
    expect(uploaded).toEqual({ success: true, storagePath: `${userId}/${podcastId}.wav` })
    if (!uploaded.success) return

    const signed = await createPodcastSignedUrl(uploaded.storagePath)
    expect(signed.success).toBe(true)
    if (!signed.success) return

    const response = await fetch(signed.url)
    expect(response.status).toBe(200)
    const served = Buffer.from(await response.arrayBuffer())
    expect(served.length).toBe(generated.audio.length)
    expect(served.subarray(0, 12)).toEqual(generated.audio.subarray(0, 12))
  }, 300_000)

  it('is unreachable without the signed token, proving the bucket is private', async () => {
    const path = podcastObjectPath(userId, podcastId)!
    const unsigned = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${PODCAST_BUCKET}/${path}`

    const response = await fetch(unsigned)

    expect(response.ok).toBe(false)
  })
})

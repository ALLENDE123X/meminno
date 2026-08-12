import { describe, it, expect, vi, beforeEach } from 'vitest'
import { logger } from '@/lib/logger'

const mockUpload = vi.fn()
const mockCreateSignedUrl = vi.fn()
const mockFrom = vi.fn(() => ({ upload: mockUpload, createSignedUrl: mockCreateSignedUrl }))
const createClientCalls: Array<[string, string, Record<string, unknown>]> = []

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: Record<string, unknown>) => {
    createClientCalls.push([url, key, options])
    return { storage: { from: mockFrom } }
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  uploadPodcastAudio,
  createPodcastSignedUrl,
  podcastObjectPath,
  PODCAST_BUCKET,
  PODCAST_SIGNED_URL_TTL_SECONDS,
} from '@/lib/podcastStorage'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const PODCAST_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const AUDIO = Buffer.alloc(64, 3)

beforeEach(() => {
  vi.clearAllMocks()
  createClientCalls.length = 0
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
  mockUpload.mockResolvedValue({ data: { path: 'ok' }, error: null })
  mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/audio.wav' }, error: null })
})

describe('podcastObjectPath', () => {
  it('builds the documented {userId}/{podcastId}.wav in-bucket path', () => {
    expect(podcastObjectPath(USER_ID, PODCAST_ID)).toBe(`${USER_ID}/${PODCAST_ID}.wav`)
  })

  it('does not nest a second podcasts/ prefix inside the podcasts bucket', () => {
    expect(PODCAST_BUCKET).toBe('podcasts')
    expect(podcastObjectPath(USER_ID, PODCAST_ID)?.startsWith('podcasts/')).toBe(false)
  })

  it('rejects anything that is not a pair of UUIDs, so traversal cannot reach a path', () => {
    expect(podcastObjectPath('../../etc', PODCAST_ID)).toBeNull()
    expect(podcastObjectPath(USER_ID, `${PODCAST_ID}/../other`)).toBeNull()
    expect(podcastObjectPath('', '')).toBeNull()
  })
})

describe('uploadPodcastAudio', () => {
  it('uploads to the private podcasts bucket as audio/wav, overwriting on regeneration', async () => {
    const result = await uploadPodcastAudio(USER_ID, PODCAST_ID, AUDIO)

    expect(result).toEqual({ success: true, storagePath: `${USER_ID}/${PODCAST_ID}.wav` })
    expect(mockFrom).toHaveBeenCalledWith('podcasts')
    expect(mockUpload).toHaveBeenCalledWith(`${USER_ID}/${PODCAST_ID}.wav`, AUDIO, {
      contentType: 'audio/wav',
      upsert: true,
    })
  })

  it('uses the service-role key with session persistence off', async () => {
    await uploadPodcastAudio(USER_ID, PODCAST_ID, AUDIO)

    expect(createClientCalls).toEqual([
      ['https://project.supabase.co', 'service-role-test', { auth: { persistSession: false, autoRefreshToken: false } }],
    ])
  })

  it('fails closed with not_configured when the service-role key is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY

    const result = await uploadPodcastAudio(USER_ID, PODCAST_ID, AUDIO)

    expect(result).toMatchObject({ success: false, reason: 'not_configured' })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('refuses a non-UUID id rather than interpolating it into an object path', async () => {
    const result = await uploadPodcastAudio('not-a-uuid', PODCAST_ID, AUDIO)

    expect(result).toMatchObject({ success: false, reason: 'upload_failed' })
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('returns upload_failed and logs when Storage rejects the upload', async () => {
    mockUpload.mockResolvedValue({ data: null, error: { message: 'bucket not found' } })

    const result = await uploadPodcastAudio(USER_ID, PODCAST_ID, AUDIO)

    expect(result).toEqual({ success: false, reason: 'upload_failed', message: expect.stringContaining("Couldn't save") })
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('createPodcastSignedUrl', () => {
  it('signs the stored path with the documented one-hour expiry', async () => {
    const result = await createPodcastSignedUrl(`${USER_ID}/${PODCAST_ID}.wav`)

    expect(result).toEqual({
      success: true,
      url: 'https://signed.example/audio.wav',
      expiresInSeconds: PODCAST_SIGNED_URL_TTL_SECONDS,
    })
    expect(PODCAST_SIGNED_URL_TTL_SECONDS).toBe(3600)
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(`${USER_ID}/${PODCAST_ID}.wav`, 3600)
  })

  it('fails closed with not_configured when Supabase credentials are missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL

    const result = await createPodcastSignedUrl(`${USER_ID}/${PODCAST_ID}.wav`)

    expect(result).toMatchObject({ success: false, reason: 'not_configured' })
    expect(mockCreateSignedUrl).not.toHaveBeenCalled()
  })

  it('returns sign_failed when Storage errors', async () => {
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'object not found' } })

    const result = await createPodcastSignedUrl(`${USER_ID}/${PODCAST_ID}.wav`)

    expect(result).toMatchObject({ success: false, reason: 'sign_failed' })
    expect(logger.error).toHaveBeenCalled()
  })

  it('returns sign_failed when Storage returns no error but no URL either', async () => {
    mockCreateSignedUrl.mockResolvedValue({ data: {}, error: null })

    const result = await createPodcastSignedUrl(`${USER_ID}/${PODCAST_ID}.wav`)

    expect(result).toMatchObject({ success: false, reason: 'sign_failed' })
  })
})

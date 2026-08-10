// @vitest-environment node
//
// This file overrides vitest.config.ts's repo-wide jsdom default, and has to.
// The route under test is a server route handler that runs in Node, and its
// `audio instanceof File` guard (same check MEM-004's live-verified
// app/api/documents/route.ts uses on its own `file` field) only holds when
// the `File` global and the one `Request.formData()` constructs its entries
// from are the SAME class. Under jsdom they are not: `globalThis.File` is
// jsdom's implementation while `formData()` still comes from Node's undici,
// so every valid audio chunk fell through the guard and 400'd — a pure
// test-environment artifact, not a real route bug (production Node has one
// `File`). Running this file in the node environment reproduces production
// exactly rather than loosening the route's guard to accommodate jsdom.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getSessionUser } from '@/lib/session'
import { checkRecordingBurstLimit, claimChunkTranscriptionBudget } from '@/lib/recordingLimits'
import { transcribeAudioChunk } from '@/lib/audioTranscription'

// Same mocking shape as tests/unit/notes-route.test.ts — mock factories
// return only inline vi.fn()s (hoisting-safe), typed refs obtained via
// vi.mocked() afterward.
vi.mock('@/lib/session', () => ({
  getSessionUser: vi.fn(),
  sessionErrorResponse: (status: 401 | 403) => ({
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }),
}))
vi.mock('@/lib/recordingLimits', () => ({
  checkRecordingBurstLimit: vi.fn(),
  claimChunkTranscriptionBudget: vi.fn(),
}))
vi.mock('@/lib/audioTranscription', () => ({
  transcribeAudioChunk: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const checkRecordingBurstLimitMock = vi.mocked(checkRecordingBurstLimit)
const claimChunkTranscriptionBudgetMock = vi.mocked(claimChunkTranscriptionBudget)
const transcribeAudioChunkMock = vi.mocked(transcribeAudioChunk)

import { POST } from '@/app/api/documents/record-chunk/route'

function makeRequest(formData: FormData | null) {
  return new Request('http://localhost/api/documents/record-chunk', {
    method: 'POST',
    ...(formData ? { body: formData } : {}),
  })
}

function makeAudioFormData(bytes = 1000, filename = 'segment-0.webm') {
  const formData = new FormData()
  formData.set('audio', new File([new Uint8Array(bytes)], filename, { type: 'audio/webm' }))
  return formData
}

describe('POST /api/documents/record-chunk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkRecordingBurstLimitMock.mockResolvedValue({ ok: true })
    claimChunkTranscriptionBudgetMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when there is no session, before doing anything else', async () => {
    getSessionUserMock.mockResolvedValue({ ok: false, status: 401 })

    const res = await POST(makeRequest(makeAudioFormData()))

    expect(res.status).toBe(401)
    expect(checkRecordingBurstLimitMock).not.toHaveBeenCalled()
  })

  it('returns 429 and never parses formData work further when burst-limited', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    checkRecordingBurstLimitMock.mockResolvedValue({ ok: false, status: 429, reason: 'slow down' })

    const res = await POST(makeRequest(makeAudioFormData()))

    expect(res.status).toBe(429)
    expect(claimChunkTranscriptionBudgetMock).not.toHaveBeenCalled()
    expect(transcribeAudioChunkMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the "audio" field is missing', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })

    const res = await POST(makeRequest(new FormData()))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('audio')
    expect(claimChunkTranscriptionBudgetMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an oversized chunk without claiming budget or calling OpenAI', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })

    const res = await POST(makeRequest(makeAudioFormData(5 * 1024 * 1024)))
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('4MB')
    expect(claimChunkTranscriptionBudgetMock).not.toHaveBeenCalled()
    expect(transcribeAudioChunkMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a zero-byte chunk without claiming budget', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })

    const res = await POST(makeRequest(makeAudioFormData(0)))

    expect(res.status).toBe(400)
    expect(claimChunkTranscriptionBudgetMock).not.toHaveBeenCalled()
  })

  it('returns 429 when the chunk budget is exhausted, without calling OpenAI', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    claimChunkTranscriptionBudgetMock.mockResolvedValue({ ok: false, status: 429, reason: 'daily limit reached' })

    const res = await POST(makeRequest(makeAudioFormData()))

    expect(res.status).toBe(429)
    expect(transcribeAudioChunkMock).not.toHaveBeenCalled()
  })

  it('transcribes a valid chunk and returns its text on success', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    transcribeAudioChunkMock.mockResolvedValue({ success: true, text: 'photosynthesis converts light into chemical energy' })

    const res = await POST(makeRequest(makeAudioFormData()))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ text: 'photosynthesis converts light into chemical energy' })
    expect(claimChunkTranscriptionBudgetMock).toHaveBeenCalledWith('user-1', 'free')
  })

  it('maps not_configured to 503', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    transcribeAudioChunkMock.mockResolvedValue({ success: false, reason: 'not_configured', message: 'not configured' })

    const res = await POST(makeRequest(makeAudioFormData()))

    expect(res.status).toBe(503)
  })

  it('maps api_error to 502', async () => {
    getSessionUserMock.mockResolvedValue({ ok: true, userId: 'user-1', plan: 'free' })
    transcribeAudioChunkMock.mockResolvedValue({ success: false, reason: 'api_error', message: 'failed' })

    const res = await POST(makeRequest(makeAudioFormData()))

    expect(res.status).toBe(502)
  })
})

import { describe, it, expect } from 'vitest'
import { normalizeReferralCode, REFERRAL_COOKIE_NAME, REFERRAL_COOKIE_MAX_AGE_SECONDS } from '@/lib/referral'

describe('normalizeReferralCode', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeReferralCode('  cynthia  ')).toBe('cynthia')
  })

  it('preserves case (validated only by non-emptiness, per issue #52)', () => {
    expect(normalizeReferralCode('Cynthia')).toBe('Cynthia')
  })

  it('returns null for an empty string', () => {
    expect(normalizeReferralCode('')).toBeNull()
  })

  it('returns null for a whitespace-only string', () => {
    expect(normalizeReferralCode('   ')).toBeNull()
  })

  it('returns null for null', () => {
    expect(normalizeReferralCode(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(normalizeReferralCode(undefined)).toBeNull()
  })
})

describe('referral cookie config', () => {
  it('uses a stable cookie name', () => {
    expect(REFERRAL_COOKIE_NAME).toBe('meminno_ref')
  })

  it('expires after 30 days', () => {
    expect(REFERRAL_COOKIE_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30)
  })
})

// MEM-018 (issue #52): shared affiliate/referral-attribution cookie config
// + normalization, used by both capture paths that feed
// `users.referredByCode`:
//
//   1. `?ref=<code>` on the marketing landing page - a bio-link click.
//      Captured in proxy.ts (a Server Component like app/page.tsx can read
//      cookies but cannot WRITE them - see proxy.ts's own header comment -
//      so proxy/middleware, which runs on every request and can do both,
//      is the one reliable place for this).
//   2. An optional "Referral code" field on the sign-in page itself
//      (app/sign-in/actions.ts's setReferralCookie server action) - a
//      creator saying a code out loud (e.g. "use code CYNTHIA") rather than
//      linking it, which URL-param capture alone can't reach. Added after
//      a direct scope correction from a real call with Cynthia
//      (2026-08-11): TikTok in particular gives link placement much less
//      real estate than a bio link, so a spoken code needs its own capture
//      path, not just the link one.
//
// Both paths write the SAME cookie name/options, so lib/session.ts's
// ensureUserRow() only ever needs to read one place regardless of which
// path supplied the code. Both treat an explicit non-empty code as
// last-write-wins (a legitimate re-attribution signal - e.g. a visitor who
// clicks a different creator's link later, or types in a different code
// than whatever stale cookie already exists) - but neither path ever
// CLEARS the cookie on an empty/absent value. That asymmetry is what makes
// this first-touch (not last-touch) attribution overall: whichever code
// gets explicitly supplied first sticks until a NEW explicit code
// overwrites it, and is never wiped just by revisiting (or submitting the
// sign-in form) without one.
export const REFERRAL_COOKIE_NAME = 'meminno_ref'

// 30 days - long enough to cover a realistic browse-then-signup gap for a
// college-student audience (someone might watch a creator's video well
// before actually getting around to signing up), short enough that a
// years-old cookie doesn't misattribute an unrelated later signup. No hard
// requirement beyond "reasonable" from issue #52; not httpOnly-exempt
// either - nothing client-side ever needs to read this cookie's value (the
// sign-in page's manual-entry path sets it via a server action, not
// document.cookie), so it's set httpOnly on both write paths.
export const REFERRAL_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/** Cookie options shared by both write paths (proxy.ts and app/sign-in/actions.ts). */
export const REFERRAL_COOKIE_OPTIONS = {
  maxAge: REFERRAL_COOKIE_MAX_AGE_SECONDS,
  path: '/',
  sameSite: 'lax' as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
}

/**
 * Trims a raw ref/referral-code input down to the value actually worth
 * persisting, returning null for empty/whitespace-only/absent input so
 * every call site can use a single `if (normalized)` check instead of
 * repeating a `.trim().length > 0` guard itself.
 *
 * Deliberately no case-folding or format validation beyond that - per the
 * ticket (issue #52), a code is "just a free-text string a creator picks
 * (e.g. 'cynthia')", validated only by non-emptiness. Not worth
 * over-constraining to a slug/handle format this early, with 1-2
 * affiliates and no `promo_codes` table to validate against.
 */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

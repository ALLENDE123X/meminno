'use server'

// MEM-018 (issue #52): sets the same `meminno_ref` attribution cookie the
// `?ref=` URL path (proxy.ts) sets, but from a manually-typed referral code
// on the sign-in page itself - covers a creator who says a code out loud
// (e.g. "use code CYNTHIA") rather than linking it, which URL-param capture
// alone can't reach (a direct scope correction from the real Cynthia call,
// 2026-08-11 - see lib/referral.ts's header comment for the full context).
//
// Called directly as a plain async function from app/sign-in/page.tsx's
// client-side submit handler (a Server Action invoked without a <form
// action={...}>, which Next.js supports identically), before
// signInWithOtp() fires. Because it sets a real Set-Cookie on the response
// to that call, the cookie is already present in the browser by the time
// the user later clicks the magic-link email and lands on
// app/auth/callback/route.ts in the same browser (the same browser
// requirement the magic-link PKCE flow itself already has - see that
// route's own header comment).
import { cookies } from 'next/headers'
import { REFERRAL_COOKIE_NAME, REFERRAL_COOKIE_OPTIONS, normalizeReferralCode } from '@/lib/referral'

/**
 * No-ops silently on an empty/whitespace-only code so leaving the field
 * blank never clears an existing cookie a prior bio-link visit may already
 * have set - same first-touch-unless-explicit-override semantics as
 * proxy.ts's `?ref=` capture.
 */
export async function setReferralCookie(rawCode: string): Promise<void> {
  const code = normalizeReferralCode(rawCode)
  if (!code) return

  const cookieStore = await cookies()
  cookieStore.set(REFERRAL_COOKIE_NAME, code, REFERRAL_COOKIE_OPTIONS)
}

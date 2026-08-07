// Session-gate helper — real Supabase Auth verification, not a stub.
//
// MEM-003 (issue #3: "Supabase Auth integration, session-gate helper
// pattern mirrored from Propinno's lib/session.ts, discriminated
// {ok:true,userId}|{ok:false,status:401|403} shape") has not landed as of
// this ticket (MEM-004, issue #4) — no branch or PR exists for it yet (see
// ARCHITECTURE.md's MEM-004 entry). MEM-004's upload route needs real auth
// regardless, so this file IS that helper, built minimally against the REAL
// Supabase Auth infra that already exists (lib/supabase/server.ts,
// provisioned since MEM-001) — not a fake/insecure bypass. MEM-003 should
// extend this (richer profile fields at creation time, sign-up UX) rather
// than re-invent it.
//
// Mirrors Propinno's lib/session.ts in shape (discriminated SessionResult,
// a sessionErrorResponse() helper), not in mechanism — Propinno's users
// authenticate via Twilio phone OTP and a raw session cookie holding their
// own DB id; Meminno uses real Supabase Auth, so identity comes from a
// cryptographically verified JWT instead.
import { createClient as createServerSupabaseClient } from '@/lib/supabase/server'
import { withUserContext } from '@/lib/db'
import { users } from '@/lib/db/schema'

export type SessionResult =
  | { ok: true; userId: string; plan: string }
  | { ok: false; status: 401 | 403 }

/**
 * Resolves the caller's identity to a real, Supabase-Auth-verified user and
 * ensures a corresponding `public.users` row exists.
 *
 * Accepts either a `Bearer <access_token>` Authorization header or a
 * cookie-based Supabase session (whichever `@supabase/ssr`'s server client
 * resolves) — the bearer-token path exists because there is no sign-in UI
 * yet (MEM-003) to mint a browser cookie session, and it also makes this
 * route callable by a future mobile client without change. Either way this
 * calls `supabase.auth.getUser(...)`, never `getSession()`: `getUser` round
 * -trips to Supabase's Auth server to verify the JWT signature, rather than
 * trusting an unverified locally-decoded cookie/token — see
 * https://supabase.com/docs/guides/auth/server-side/nextjs ("Never trust
 * getSession() inside server code").
 *
 * `public.users.id` matching `auth.users.id` is an application-level
 * invariant (lib/db/schema.ts's header comment — there's no DB-level FK,
 * Supabase's managed `auth` schema doesn't allow one). Since MEM-003 hasn't
 * shipped a dedicated profile-creation flow yet, this function upserts the
 * profile row itself on every call: creates it on a caller's first-ever
 * request, and keeps `email` in sync afterwards. The upsert runs through
 * `withUserContext` with the caller's OWN id, so the `users_own_row` RLS
 * policy (`WITH CHECK id = caller`) allows it — this is a normal
 * self-service write, not a privileged bypass.
 */
export async function getSessionUser(req: Request): Promise<SessionResult> {
  const authHeader = req.headers.get('authorization')
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length).trim()
    : undefined

  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.auth.getUser(bearerToken)
  if (error || !data.user) {
    return { ok: false, status: 401 }
  }

  const userId = data.user.id
  // Supabase Auth users created via email/password or magic link (the only
  // providers CLAUDE.md scopes for this app) always carry an email; the
  // fallback just keeps the notNull `users.email` column from throwing on
  // an edge case rather than claiming to guarantee one never occurs.
  const email = data.user.email ?? ''

  const [profile] = await withUserContext(userId, (tx) =>
    tx
      .insert(users)
      .values({ id: userId, email })
      .onConflictDoUpdate({ target: users.id, set: { email } })
      .returning({ plan: users.plan })
  )

  return { ok: true, userId, plan: profile?.plan ?? 'free' }
}

/** Standard error body/status pair for a failed getSessionUser() result. */
export function sessionErrorResponse(status: 401 | 403) {
  return {
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }
}

import { createClient } from '@/lib/supabase/server'
import { withUserContext } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { logger } from '@/lib/logger'

export type SessionResult =
  | { ok: true; userId: string; plan: string }
  | { ok: false; status: 401 | 403 }

/**
 * Resolves the current request's Supabase Auth session to a userId (+ plan).
 *
 * Mirrors Propinno's lib/session.ts discriminated-union pattern
 * ({ok:true,userId}|{ok:false,status:401|403}), adapted from Propinno's
 * phone/cookie-session check to Supabase Auth:
 *
 * - 401: no session, or the session doesn't validate. Uses
 *   supabase.auth.getUser() rather than getSession() deliberately -
 *   getSession() only decodes the JWT it finds in a cookie without checking
 *   it against Supabase's Auth server, so it will happily "succeed" on a
 *   forged or stale cookie. getUser() makes a real network call to Supabase
 *   Auth and can only return a user for a token Supabase itself issued and
 *   still considers valid. See
 *   https://supabase.com/docs/guides/auth/server-side/nextjs for why this
 *   distinction matters for any server-side check that gates real access.
 * - 403: reserved, not reachable yet. Propinno's 403 fires for a real
 *   session belonging to a user who isn't an active paying subscriber -
 *   Meminno has no equivalent concept yet (billing is a later ticket, not
 *   MEM-003). Kept in the return type now so every call site already
 *   handles it, rather than becoming a breaking change to every caller once
 *   a real 403 condition exists.
 *
 * `req` is optional and, when passed, also allows a `Bearer <access_token>`
 * Authorization header to satisfy the session, alongside the usual
 * cookie-based path — both go through the same `supabase.auth.getUser(jwt?)`
 * call. Added by MEM-004 (upload flow): at the time it shipped there was no
 * sign-in UI yet to mint a browser cookie session, so its route (and its
 * live E2E verification) needed a way to authenticate without one; it also
 * makes any route using this callable by a future non-browser client
 * without change. Existing cookie-only call sites (app/auth/callback,
 * app/api/me) are unaffected — they simply don't pass `req`.
 *
 * On every successful resolution, upserts a matching public.users row for
 * this Supabase Auth identity (see ensureUserRow below), returning its
 * `plan` alongside `userId` so callers that need it (e.g. MEM-004's
 * per-plan upload caps) don't need a second query. public.users has no
 * DB-level FK to auth.users (a documented Supabase platform constraint on
 * this project - meminno_app/meminno_rls can never be granted USAGE on the
 * auth schema; see CLAUDE.md's "auth schema access" section), so that link
 * is an application-level invariant, and this function is what upholds it
 * on every authenticated request rather than only at a one-time signup
 * step.
 */
export async function getSessionUser(req?: Request): Promise<SessionResult> {
  const authHeader = req?.headers.get('authorization')
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length).trim()
    : undefined

  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser(bearerToken)

  if (error || !data.user) return { ok: false, status: 401 }

  const authUser = data.user
  if (!authUser.email) {
    // users.email is NOT NULL, and every sign-in path this app offers
    // (magic link, or a Bearer token minted from that same flow) requires
    // an email to begin with - should be unreachable in practice. Fail
    // closed rather than insert a row that violates the schema.
    logger.error({ userId: authUser.id }, 'Supabase Auth user has no email on the session')
    return { ok: false, status: 401 }
  }

  const plan = await ensureUserRow(authUser.id, authUser.email)
  return { ok: true, userId: authUser.id, plan }
}

/**
 * Looks up or creates the public.users row for a Supabase Auth identity,
 * returning its current plan.
 *
 * Upserts via onConflictDoUpdate() rather than onConflictDoNothing():
 * `id` is the primary key and, by convention (see lib/db/schema.ts's
 * header comment on `users`), always equals the Supabase Auth user's own
 * id, so a concurrent second call for the same brand-new account (e.g. two
 * tabs completing the magic-link callback at once) still races safely
 * instead of erroring on a duplicate-key violation — the same safety
 * onConflictDoNothing() had. The difference: onConflictDoUpdate() also
 * keeps `email` in sync with Supabase Auth on every later call, which
 * onConflictDoNothing() would silently stop doing after the first insert.
 * Flagged during MEM-004's merge review (independently, by two reviews) as
 * the better default here — an auth-provider email change (e.g. the user
 * updates it in Supabase Auth) shouldn't leave this table permanently
 * stale.
 *
 * Runs through withUserContext(userId, ...) like every other query in this
 * app - the RLS policy's withCheck (`meminno_current_user_id() = id`) only
 * passes because the transaction's identity GUC is set to the same id being
 * inserted.
 */
async function ensureUserRow(userId: string, email: string): Promise<string> {
  const [profile] = await withUserContext(userId, (tx) =>
    tx
      .insert(users)
      .values({ id: userId, email })
      .onConflictDoUpdate({ target: users.id, set: { email } })
      .returning({ plan: users.plan })
  )
  return profile?.plan ?? 'free'
}

/** Standard error body/status pair for a failed getSessionUser() result. */
export function sessionErrorResponse(status: 401 | 403) {
  return {
    error: status === 401 ? 'Unauthorized' : 'Access forbidden',
    status,
  }
}

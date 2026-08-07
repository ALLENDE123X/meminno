import { createClient } from '@/lib/supabase/server'
import { withUserContext } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { logger } from '@/lib/logger'

type SessionResult = { ok: true; userId: string } | { ok: false; status: 401 | 403 }

/**
 * Resolves the current request's Supabase Auth session to a userId.
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
 * On every successful resolution, ensures a matching public.users row
 * exists for this Supabase Auth identity (see ensureUserRow below).
 * public.users has no DB-level FK to auth.users (a documented Supabase
 * platform constraint on this project - meminno_app/meminno_rls can never
 * be granted USAGE on the auth schema; see CLAUDE.md's "auth schema access"
 * section), so that link is an application-level invariant, and this
 * function is what upholds it on every authenticated request rather than
 * only at a one-time signup step.
 */
export async function getSessionUser(): Promise<SessionResult> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data.user) return { ok: false, status: 401 }

  const authUser = data.user
  if (!authUser.email) {
    // users.email is NOT NULL, and every sign-in path this app offers
    // (magic link) requires an email to begin with - should be unreachable
    // in practice. Fail closed rather than insert a row that violates the
    // schema.
    logger.error({ userId: authUser.id }, 'Supabase Auth user has no email on the session')
    return { ok: false, status: 401 }
  }

  await ensureUserRow(authUser.id, authUser.email)
  return { ok: true, userId: authUser.id }
}

/**
 * Looks up or creates the public.users row for a Supabase Auth identity.
 *
 * Idempotent via onConflictDoNothing(): `id` is the primary key and, by
 * convention (see lib/db/schema.ts's header comment on `users`), always
 * equals the Supabase Auth user's own id, so a concurrent second call for
 * the same brand-new account (e.g. two tabs completing the magic-link
 * callback at once) races safely instead of erroring on a duplicate-key
 * violation.
 *
 * Runs through withUserContext(userId, ...) like every other query in this
 * app - the RLS policy's withCheck (`meminno_current_user_id() = id`) only
 * passes because the transaction's identity GUC is set to the same id being
 * inserted.
 */
async function ensureUserRow(userId: string, email: string): Promise<void> {
  await withUserContext(userId, async (tx) => {
    await tx.insert(users).values({ id: userId, email }).onConflictDoNothing()
  })
}

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getSessionUser } from '@/lib/session'
import { withUserContext } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { createClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

// The first real protected route in this app (MEM-003) - doubles as a
// concrete "am I signed in, and does my own row come back through RLS"
// check for any client, and as the manual/e2e verification endpoint used
// to prove getSessionUser()/withUserContext() actually work end to end
// against the live Supabase project (see CLAUDE.md's "Two-role database
// architecture" for why a bare db.select() would return nothing here).
export async function GET() {
  const session = await getSessionUser()
  if (!session.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: session.status })
  }

  // withUserContext is not optional plumbing here - it's what makes this
  // query return anything at all. Every user table is FORCE ROW LEVEL
  // SECURITY with no policy naming the runtime role's identity unless the
  // app.current_user_id GUC is set first (see lib/db/index.ts).
  const [user] = await withUserContext(session.userId, (tx) =>
    tx.select({ id: users.id, email: users.email, plan: users.plan }).from(users).where(eq(users.id, session.userId))
  )

  if (!user) {
    // Should be unreachable - getSessionUser() just ensured this row
    // exists - but RLS could in principle hide a row that failed its own
    // insert silently upstream, so this is a real 500, not an assumption.
    logger.error({ userId: session.userId }, 'Authenticated session has no matching users row')
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ user })
}

// Signs the current session out. DELETE (not POST) because this ends the
// session resource rather than creating anything - matches this route's
// existing GET-a-resource shape instead of adding a separate one-off route
// file for it (this ticket's 5-file budget).
export async function DELETE() {
  const session = await getSessionUser()
  if (!session.ok) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: session.status })
  }

  const supabase = await createClient()
  await supabase.auth.signOut()
  logger.info({ userId: session.userId, action: 'sign_out' })
  return NextResponse.json({ ok: true })
}

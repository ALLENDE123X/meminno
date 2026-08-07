import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

// Exercises the RLS policies in lib/db/schema.ts for real, against a real
// Postgres connection - not a mocked assertion. Deliberately does NOT use
// the shared `db` export from lib/db/index.ts: that client always connects
// as `meminno_app`, which bypasses RLS entirely (table ownership, and now
// also the BYPASSRLS role attribute directly - see CLAUDE.md's
// "`meminno_app` bypasses RLS entirely" section) - a test written against
// it would pass even if every policy below were deleted. Instead this opens
// its own connection and, inside a transaction, `SET LOCAL ROLE
// authenticated` + spoofs `request.jwt.claim.sub` (the exact GUC the real
// auth.uid() reads, via public.rls_current_user_id() - see schema.ts's
// header comment) to become a specific authenticated user for that
// transaction only - the same effective role/identity PostgREST would give
// a real client-side Supabase query.
//
// `users.id` has no real FK to auth.users (see schema.ts's header comment
// on why), so unlike an earlier draft of this file, nothing here needs to
// write into auth.users at all - it inserts straight into `public.users`.
// The real limiting factor is `SET ROLE authenticated` itself: that
// requires either superuser or membership in `authenticated`, and
// `meminno_app` has neither (superuser: no; membership: blocked by the same
// platform wall documented in CLAUDE.md that blocks its `auth`-schema
// grants). CI's `test` role IS superuser, so this suite runs fully there.
// Run outside CI (e.g. locally against the real Supabase project via
// meminno_app), `SET ROLE authenticated` itself fails, detected in
// beforeAll, and the suite skips itself gracefully rather than failing
// noisily - see the PR description for why DB-touching verification for
// this ticket happened in CI, not against production.
const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('RLS policies enforce per-user isolation (lib/db/schema.ts)', () => {
  let sql: postgres.Sql
  let canRunAgainstThisDatabase = true
  const userA = randomUUID()
  const userB = randomUUID()

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { prepare: false, max: 1 })
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE authenticated')
      })
    } catch {
      canRunAgainstThisDatabase = false
    }
  })

  afterAll(async () => {
    if (sql) {
      if (canRunAgainstThisDatabase) {
        // meminno_app (the default role for this connection outside the
        // per-test transactions below) bypasses RLS, so this cleans up
        // regardless of what the policies under test did. ON DELETE CASCADE
        // from users takes documents/notes/flashcards/quizzes/quiz_attempts
        // with it.
        await sql`delete from users where id in (${userA}, ${userB})`.catch(() => {})
      }
      await sql.end()
    }
  })

  // Runs `fn` as `authenticated`, with the caller's identity spoofed to
  // `userId`, in a single transaction (SET LOCAL is transaction-scoped, so
  // this can never leak the role/claim into a later query on the same
  // connection).
  async function asUser<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE authenticated')
      await tx.unsafe(`SET LOCAL request.jwt.claim.sub = '${userId}'`)
      return fn(tx)
    })
    // sql.begin()'s own generic (UnwrapPromiseArray<T>) doesn't structurally
    // match this function's T even though they're the same value at
    // runtime - see the call site above, fn always returns Promise<T>.
    return result as T
  }

  it('a user can create and read their own rows, and cannot see, modify, or delete another user\'s rows', async () => {
    if (!canRunAgainstThisDatabase) {
      console.warn('[rls.test.ts] skipping: connected role cannot SET ROLE authenticated (expected when run outside CI - see file header comment)')
      return
    }

    await asUser(userA, async (tx) => {
      await tx`insert into users (id, email) values (${userA}, 'a@example.com')`
      await tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userA}, 'user A doc', 'text')`
    })
    await asUser(userB, async (tx) => {
      await tx`insert into users (id, email) values (${userB}, 'b@example.com')`
    })

    // Sanity check: A can see their own document.
    const ownDoc = await asUser(userA, (tx) => tx`select * from documents where user_id = ${userA}`)
    expect(ownDoc).toHaveLength(1)
    const docId = ownDoc[0].id as string

    // B cannot see A's document at all - not an error, just zero rows,
    // exactly like a real cross-user PostgREST query would see.
    const crossUserSelect = await asUser(userB, (tx) => tx`select * from documents where id = ${docId}`)
    expect(crossUserSelect).toHaveLength(0)

    // B's UPDATE against A's row matches zero rows (RLS's USING clause
    // filters it out before the update ever applies) rather than erroring.
    const updateResult = await asUser(userB, (tx) =>
      tx`update documents set title = 'hijacked' where id = ${docId} returning *`
    )
    expect(updateResult).toHaveLength(0)

    // B's DELETE against A's row likewise matches zero rows.
    const deleteResult = await asUser(userB, (tx) =>
      tx`delete from documents where id = ${docId} returning *`
    )
    expect(deleteResult).toHaveLength(0)

    // B cannot INSERT a row claiming to be A's (user_id = A while acting as
    // B) - WITH CHECK rejects it outright, a real error, not a silent no-op.
    await expect(
      asUser(userB, (tx) =>
        tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userA}, 'forged', 'text')`
      )
    ).rejects.toThrow(/row-level security/i)

    // Confirm A's row survived every one of B's attempts above, completely
    // untouched.
    const stillThere = await asUser(userA, (tx) => tx`select title from documents where id = ${docId}`)
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0].title).toBe('user A doc')
  })

  it('a user cannot read or modify another user\'s own profile row', async () => {
    if (!canRunAgainstThisDatabase) return

    const crossUserProfile = await asUser(userB, (tx) => tx`select * from users where id = ${userA}`)
    expect(crossUserProfile).toHaveLength(0)

    const crossUserProfileUpdate = await asUser(userB, (tx) =>
      tx`update users set plan = 'monthly' where id = ${userA} returning *`
    )
    expect(crossUserProfileUpdate).toHaveLength(0)
  })
})

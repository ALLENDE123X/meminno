import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
// MEM-012's suite at the bottom of this file exercises the app's real entry
// point (withUserContext + the drizzle table object) on the new `podcasts`
// table, not only this file's hand-rolled equivalent - see that describe
// block's comment for why.
import { withUserContext } from '@/lib/db'
import { podcasts } from '@/lib/db/schema'

// Proves the RLS policies in lib/db/schema.ts genuinely isolate users - not
// as a mocked assertion, but by connecting as the SAME role the running app
// connects as (`meminno_rls`, via DATABASE_URL - see lib/db/index.ts) and
// running real INSERT/SELECT/UPDATE/DELETE against real rows, cleaned up
// afterwards.
//
// This is the whole point of MEM-002-fix (issue #14). MEM-002's version of
// this file could not test the app's real path at all: the app connected as
// `meminno_app`, which owned every table AND carried `BYPASSRLS`, so it had
// to open a side connection and `SET LOCAL ROLE authenticated` to find a
// role the policies applied to. That only ever worked under a CI superuser
// and told us nothing about production. Now the app's own role is a role
// RLS applies to, so this suite tests the real thing, in CI and against the
// live project alike.
//
// Safe to run against the live Supabase project (CLAUDE.md HARD STOP 5):
// nothing here truncates or deletes by anything but the two random UUIDs it
// created itself, and RLS makes it structurally incapable of touching any
// other user's rows even if it tried.
const DATABASE_URL = process.env.DATABASE_URL
// The table-owning migration role (`meminno_app`). Only used to prove it is
// NOT a way around RLS; never used to set up or clean up test data.
const MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL

describe.skipIf(!DATABASE_URL)('RLS enforces per-user isolation on the app\'s real connection', () => {
  let sql: postgres.Sql
  const userA = randomUUID()
  const userB = randomUUID()

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { prepare: false, max: 1 })
  })

  afterAll(async () => {
    if (!sql) return
    // Each user deletes only their own profile row, through the same
    // policy-scoped path everything else here uses. The ON DELETE CASCADE
    // FKs take documents/notes/flashcards/quizzes/quiz_attempts with them
    // (referential-integrity actions bypass row security by design in
    // Postgres, so the cascade is not itself subject to these policies).
    for (const id of [userA, userB]) {
      await asUser(id, (tx) => tx`delete from users where id = ${id}`).catch(() => {})
    }
    await sql.end()
  })

  // Runs `fn` with the caller's identity set to `userId`, exactly the way
  // lib/db/index.ts's withUserContext() does it: a transaction-local GUC
  // that public.meminno_current_user_id() reads, so it can never leak onto
  // a later query sharing the same pooled connection.
  async function asUser<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_user_id', ${userId}, true)`
      return fn(tx)
    })
    // sql.begin()'s own generic (UnwrapPromiseArray<T>) doesn't structurally
    // match this function's T even though they're the same value at runtime.
    return result as T
  }

  it('connects as a role that RLS actually applies to (no BYPASSRLS, not the table owner)', async () => {
    const [{ current_user: connectedAs, rolbypassrls, rolsuper }] = await sql`
      select current_user, r.rolbypassrls, r.rolsuper
      from pg_roles r where r.rolname = current_user
    `
    expect(rolbypassrls).toBe(false)
    expect(rolsuper).toBe(false)

    const owners = await sql`
      select c.relname, pg_get_userbyid(c.relowner) as owner, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('users','documents','notes','flashcards','quizzes','quiz_attempts')
    `
    expect(owners).toHaveLength(6)
    for (const t of owners) {
      // FORCE, so even the owner is subject to these policies.
      expect(t.relforcerowsecurity).toBe(true)
      // ...and the connected role is not that owner anyway.
      expect(t.owner).not.toBe(connectedAs)
    }
  })

  it('sees nothing at all when no user identity is set on the session (default deny)', async () => {
    await asUser(userA, async (tx) => {
      await tx`insert into users (id, email) values (${userA}, 'a@example.com')`
    })

    const rows = await sql`select * from users where id = ${userA}`
    expect(rows).toHaveLength(0)
  })

  it('a user can create and read their own rows, and cannot see, modify, or delete another user\'s', async () => {
    await asUser(userA, async (tx) => {
      await tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userA}, 'user A doc', 'text')`
    })
    await asUser(userB, async (tx) => {
      await tx`insert into users (id, email) values (${userB}, 'b@example.com')`
    })

    // A can see their own document.
    const ownDoc = await asUser(userA, (tx) => tx`select * from documents where user_id = ${userA}`)
    expect(ownDoc).toHaveLength(1)
    const docId = ownDoc[0].id as string

    // B cannot see A's document at all - zero rows, not an error.
    const crossUserSelect = await asUser(userB, (tx) => tx`select * from documents where id = ${docId}`)
    expect(crossUserSelect).toHaveLength(0)

    // B's UPDATE against A's row matches zero rows (the USING clause filters
    // it out before the update applies) rather than erroring.
    const updateResult = await asUser(userB, (tx) =>
      tx`update documents set title = 'hijacked' where id = ${docId} returning *`
    )
    expect(updateResult).toHaveLength(0)

    // B's DELETE against A's row likewise matches zero rows.
    const deleteResult = await asUser(userB, (tx) =>
      tx`delete from documents where id = ${docId} returning *`
    )
    expect(deleteResult).toHaveLength(0)

    // B cannot INSERT a row claiming to be A's - WITH CHECK rejects it
    // outright, a real error, not a silent no-op.
    await expect(
      asUser(userB, (tx) =>
        tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userA}, 'forged', 'text')`
      )
    ).rejects.toThrow(/row-level security/i)

    // A's row survived every one of B's attempts, completely untouched.
    const stillThere = await asUser(userA, (tx) => tx`select title from documents where id = ${docId}`)
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0].title).toBe('user A doc')
  })

  it('a user cannot read or modify another user\'s profile row', async () => {
    const crossUserProfile = await asUser(userB, (tx) => tx`select * from users where id = ${userA}`)
    expect(crossUserProfile).toHaveLength(0)

    const crossUserProfileUpdate = await asUser(userB, (tx) =>
      tx`update users set plan = 'monthly' where id = ${userA} returning *`
    )
    expect(crossUserProfileUpdate).toHaveLength(0)
  })

  // The regression test for issue #14 itself: before this fix, the role
  // below owned every table and carried BYPASSRLS, and it was what the app
  // connected as - so it saw everything. It is now migrations/DDL only, and
  // FORCE ROW LEVEL SECURITY plus no policy naming it means it can see no
  // user rows at all.
  it.skipIf(!MIGRATION_DATABASE_URL)('the table-owning migration role cannot read user rows either', async () => {
    const owner = postgres(MIGRATION_DATABASE_URL!, { prepare: false, max: 1 })
    try {
      const [{ rolsuper, rolbypassrls }] = await owner`
        select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user
      `
      // A superuser bypasses RLS unconditionally and would make the
      // assertions below meaningless, so treat that as a setup failure
      // rather than silently "passing".
      expect(rolsuper).toBe(false)
      expect(rolbypassrls).toBe(false)

      expect(await owner`select * from users where id = ${userA}`).toHaveLength(0)
      expect(await owner`select * from documents where user_id = ${userA}`).toHaveLength(0)
    } finally {
      await owner.end()
    }
  })
})

// Regression suite for issue #23: before this fix, every child table's
// `withCheck` was a flat `user_id = caller` check with no verification that
// the row's parent FK (document_id/note_id/quiz_id) actually belonged to
// that same caller. User B could INSERT a child row with `user_id = B`
// while pointing its FK at user A's parent row - the FK itself resolves
// fine (Postgres FK referential-integrity checks bypass RLS by design), so
// nothing stopped it. `lib/db/schema.ts`'s `withCheck` clauses now add an
// EXISTS subquery requiring the parent row to be visible to (owned by) the
// caller; this suite proves that against the real `meminno_rls` connection,
// not a mock, for all four affected tables, and separately proves the
// legitimate same-user path was not broken by the tightening.
describe.skipIf(!DATABASE_URL)('child-table RLS withCheck rejects parent-ownership forgery (issue #23)', () => {
  let sql: postgres.Sql
  const userA = randomUUID()
  const userB = randomUUID()
  // A real parent chain, entirely owned by user A: documents -> notes ->
  // quizzes. Reused read-only by every forgery test below (user B never
  // succeeds in writing through it), then written to once more by the
  // final happy-path test.
  let documentId: string
  let noteId: string
  let quizId: string

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { prepare: false, max: 1 })

    await asUser(userA, (tx) => tx`insert into users (id, email) values (${userA}, 'a-parent-chain@example.com')`)
    await asUser(userB, (tx) => tx`insert into users (id, email) values (${userB}, 'b-forger@example.com')`)

    const [doc] = await asUser(userA, (tx) =>
      tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userA}, 'A parent doc', 'text') returning id`
    )
    documentId = doc.id as string

    const [note] = await asUser(userA, (tx) =>
      tx`insert into notes (id, document_id, user_id, content) values (gen_random_uuid(), ${documentId}, ${userA}, 'A parent note') returning id`
    )
    noteId = note.id as string

    const [quiz] = await asUser(userA, (tx) =>
      tx`insert into quizzes (id, note_id, user_id, questions) values (gen_random_uuid(), ${noteId}, ${userA}, '[]'::jsonb) returning id`
    )
    quizId = quiz.id as string
  })

  afterAll(async () => {
    if (!sql) return
    // Cascades take every child row (notes/flashcards/quizzes/quiz_attempts
    // this suite created) with them - same cleanup pattern as the describe
    // block above.
    for (const id of [userA, userB]) {
      await asUser(id, (tx) => tx`delete from users where id = ${id}`).catch(() => {})
    }
    await sql.end()
  })

  async function asUser<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_user_id', ${userId}, true)`
      return fn(tx)
    })
    return result as T
  }

  it('user B cannot INSERT a note claiming user_id=B while pointing document_id at user A\'s document', async () => {
    await expect(
      asUser(userB, (tx) =>
        tx`insert into notes (id, document_id, user_id, content) values (gen_random_uuid(), ${documentId}, ${userB}, 'forged note')`
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it('user B cannot INSERT a flashcard claiming user_id=B while pointing note_id at user A\'s note', async () => {
    await expect(
      asUser(userB, (tx) =>
        tx`insert into flashcards (id, note_id, user_id, front, back) values (gen_random_uuid(), ${noteId}, ${userB}, 'forged front', 'forged back')`
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it('user B cannot INSERT a quiz claiming user_id=B while pointing note_id at user A\'s note', async () => {
    await expect(
      asUser(userB, (tx) =>
        tx`insert into quizzes (id, note_id, user_id, questions) values (gen_random_uuid(), ${noteId}, ${userB}, '[]'::jsonb)`
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it('user B cannot INSERT a quiz_attempt claiming user_id=B while pointing quiz_id at user A\'s quiz', async () => {
    await expect(
      asUser(userB, (tx) =>
        tx`insert into quiz_attempts (id, quiz_id, user_id, score, answers) values (gen_random_uuid(), ${quizId}, ${userB}, 0, '[]'::jsonb)`
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it('legitimate same-user inserts through every tightened withCheck still succeed (happy path not broken)', async () => {
    const [ownNote] = await asUser(userA, (tx) =>
      tx`insert into notes (id, document_id, user_id, content) values (gen_random_uuid(), ${documentId}, ${userA}, 'legit note') returning id`
    )
    expect(ownNote?.id).toBeTruthy()

    const [ownFlashcard] = await asUser(userA, (tx) =>
      tx`insert into flashcards (id, note_id, user_id, front, back) values (gen_random_uuid(), ${noteId}, ${userA}, 'legit front', 'legit back') returning id`
    )
    expect(ownFlashcard?.id).toBeTruthy()

    const [ownQuiz] = await asUser(userA, (tx) =>
      tx`insert into quizzes (id, note_id, user_id, questions) values (gen_random_uuid(), ${noteId}, ${userA}, '[]'::jsonb) returning id`
    )
    expect(ownQuiz?.id).toBeTruthy()

    const [ownAttempt] = await asUser(userA, (tx) =>
      tx`insert into quiz_attempts (id, quiz_id, user_id, score, answers) values (gen_random_uuid(), ${quizId}, ${userA}, 100, '[]'::jsonb) returning id`
    )
    expect(ownAttempt?.id).toBeTruthy()
  })
})

// MEM-012 (issue #47): the `podcasts` table. Proves all five pieces of
// CLAUDE.md's new-table RLS convention actually hold on the new table, not
// just that the migration ran - the same standard the two suites above hold
// the original six tables to.
//
// One deliberate difference from those suites: the happy-path test here goes
// through `lib/db/index.ts`'s REAL `withUserContext()` + the real drizzle
// `podcasts` table object, not this file's hand-rolled `asUser` helper. The
// helper is a faithful copy of what withUserContext does, but a copy - and
// `podcasts` is the first table added since that helper was written, so it is
// worth proving once that the actual application entry point (the thing every
// future podcast route will call) resolves this table's policy correctly.
// The forgery/isolation tests below stay on the raw connection, where a
// rejected INSERT surfaces the underlying Postgres error verbatim.
describe.skipIf(!DATABASE_URL)('podcasts RLS (MEM-012, issue #47)', () => {
  let sql: postgres.Sql
  const userA = randomUUID()
  const userB = randomUUID()
  let documentA: string
  let documentB: string
  let podcastA: string

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { prepare: false, max: 1 })

    await asUser(userA, (tx) => tx`insert into users (id, email) values (${userA}, 'a-podcast@example.com')`)
    await asUser(userB, (tx) => tx`insert into users (id, email) values (${userB}, 'b-podcast@example.com')`)

    const [docA] = await asUser(userA, (tx) =>
      tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userA}, 'A podcast source doc', 'text') returning id`
    )
    documentA = docA.id as string

    const [docB] = await asUser(userB, (tx) =>
      tx`insert into documents (id, user_id, title, source_type) values (gen_random_uuid(), ${userB}, 'B own doc', 'text') returning id`
    )
    documentB = docB.id as string
  })

  afterAll(async () => {
    if (!sql) return
    for (const id of [userA, userB]) {
      await asUser(id, (tx) => tx`delete from users where id = ${id}`).catch(() => {})
    }
    await sql.end()
  })

  async function asUser<T>(userId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_user_id', ${userId}, true)`
      return fn(tx)
    })
    return result as T
  }

  it('has all five pieces of the new-table convention applied on the live schema', async () => {
    const [table] = await sql`
      select c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'podcasts'
    `
    // (1) ENABLE and (5) FORCE - without FORCE the owner would be exempt
    // from its own policy, which is exactly what MEM-002-fix closed.
    expect(table.relrowsecurity).toBe(true)
    expect(table.relforcerowsecurity).toBe(true)
    // ...and the connected runtime role is not that owner.
    expect(table.owner).not.toBe((await sql`select current_user`)[0].current_user)

    // (2) exactly one policy, FOR ALL, naming both real access paths and
    // never the owner/migration role.
    const policies = await sql`
      select polname,
             polcmd,
             (select array_agg(pg_get_userbyid(r)) from unnest(polroles) r) as roles,
             pg_get_expr(polwithcheck, polrelid) as with_check
      from pg_policy where polrelid = 'public.podcasts'::regclass
    `
    expect(policies).toHaveLength(1)
    expect(policies[0].polname).toBe('podcasts_own_rows')
    expect(policies[0].polcmd).toBe('*')
    expect([...(policies[0].roles as string[])].sort()).toEqual(['authenticated', 'meminno_rls'])
    // The parent-ownership clause (issue #23's shape), present from day one
    // on this table rather than added by a later tightening migration.
    expect(policies[0].with_check).toMatch(/EXISTS/i)
    expect(policies[0].with_check).toMatch(/documents/)

    // (3) + (4) the two hand-written GRANTs drizzle-kit never emits. Without
    // them every query fails with a blanket "permission denied for table",
    // one layer below where RLS is even evaluated. `anon` deliberately gets
    // nothing.
    const [privs] = await sql`
      select has_table_privilege('authenticated', 'public.podcasts', 'SELECT') as auth_select,
             has_table_privilege('meminno_rls', 'public.podcasts', 'SELECT') as rls_select,
             has_table_privilege('anon', 'public.podcasts', 'SELECT') as anon_select
    `
    expect(privs.auth_select).toBe(true)
    expect(privs.rls_select).toBe(true)
    expect(privs.anon_select).toBe(false)
  })

  it('an owner can insert and read back their own podcast row through the real withUserContext()', async () => {
    const inserted = await withUserContext(userA, (tx) =>
      tx.insert(podcasts).values({ documentId: documentA, userId: userA }).returning()
    )
    expect(inserted).toHaveLength(1)
    podcastA = inserted[0].id
    // Column defaults/nullability behave as the feature expects: a freshly
    // queued podcast is 'pending' with nothing populated yet.
    expect(inserted[0].status).toBe('pending')
    expect(inserted[0].storagePath).toBeNull()
    expect(inserted[0].durationSeconds).toBeNull()
    expect(inserted[0].errorMessage).toBeNull()

    const readBack = await withUserContext(userA, (tx) =>
      tx.select().from(podcasts).where(eq(podcasts.id, podcastA))
    )
    expect(readBack).toHaveLength(1)
    expect(readBack[0].documentId).toBe(documentA)
  })

  it('an owner can update their own podcast row through the whole generation lifecycle', async () => {
    const [ready] = await asUser(userA, (tx) =>
      tx`update podcasts set status = 'ready', storage_path = 'podcasts/a.mp3', duration_seconds = 480
         where id = ${podcastA} returning status, storage_path, duration_seconds`
    )
    expect(ready.status).toBe('ready')
    expect(ready.storage_path).toBe('podcasts/a.mp3')
    expect(ready.duration_seconds).toBe(480)

    const [failed] = await asUser(userA, (tx) =>
      tx`update podcasts set status = 'failed', error_message = 'not_configured'
         where id = ${podcastA} returning status, error_message`
    )
    expect(failed.status).toBe('failed')
    expect(failed.error_message).toBe('not_configured')
  })

  it('another user cannot see, update, or delete that podcast row', async () => {
    expect(await asUser(userB, (tx) => tx`select * from podcasts where id = ${podcastA}`)).toHaveLength(0)
    expect(
      await asUser(userB, (tx) => tx`update podcasts set status = 'ready' where id = ${podcastA} returning *`)
    ).toHaveLength(0)
    expect(
      await asUser(userB, (tx) => tx`delete from podcasts where id = ${podcastA} returning *`)
    ).toHaveLength(0)

    // ...and it is genuinely untouched afterwards.
    const stillThere = await asUser(userA, (tx) => tx`select status from podcasts where id = ${podcastA}`)
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0].status).toBe('failed')
  })

  it('a session with no identity set sees no podcast rows at all (default deny)', async () => {
    expect(await sql`select * from podcasts where id = ${podcastA}`).toHaveLength(0)
  })

  it('user B cannot forge a podcast against user A\'s document (parent-ownership withCheck)', async () => {
    // user_id = B (so the flat half of withCheck passes) but document_id
    // points at user A's document. The FK resolves fine - Postgres checks FK
    // referential integrity with RLS bypassed by design - so only the EXISTS
    // clause stops this.
    await expect(
      asUser(userB, (tx) =>
        tx`insert into podcasts (id, document_id, user_id) values (gen_random_uuid(), ${documentA}, ${userB})`
      )
    ).rejects.toThrow(/row-level security/i)

    // The mirror-image forgery: user_id = A while pointing at B's own
    // document, i.e. claiming a row on someone else's behalf.
    await expect(
      asUser(userB, (tx) =>
        tx`insert into podcasts (id, document_id, user_id) values (gen_random_uuid(), ${documentB}, ${userA})`
      )
    ).rejects.toThrow(/row-level security/i)

    // ...while B's own legitimate insert against B's own document succeeds,
    // proving the tightening didn't just break the table for everyone.
    const [ownPodcast] = await asUser(userB, (tx) =>
      tx`insert into podcasts (id, document_id, user_id) values (gen_random_uuid(), ${documentB}, ${userB}) returning id`
    )
    expect(ownPodcast?.id).toBeTruthy()
  })

  it('user B cannot UPDATE their own podcast row to repoint it at user A\'s document', async () => {
    // withCheck applies to the post-update row too, so a repoint is the same
    // forgery as an INSERT and must fail the same way.
    await expect(
      asUser(userB, (tx) =>
        tx`update podcasts set document_id = ${documentA} where user_id = ${userB}`
      )
    ).rejects.toThrow(/row-level security/i)
  })

  it.skipIf(!MIGRATION_DATABASE_URL)('the table-owning migration role cannot read podcast rows either', async () => {
    const owner = postgres(MIGRATION_DATABASE_URL!, { prepare: false, max: 1 })
    try {
      const [{ rolsuper, rolbypassrls }] = await owner`
        select r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user
      `
      // A superuser or a BYPASSRLS role would make the assertion below
      // meaningless rather than passing for the right reason.
      expect(rolsuper).toBe(false)
      expect(rolbypassrls).toBe(false)

      expect(await owner`select * from podcasts where id = ${podcastA}`).toHaveLength(0)
      expect(await owner`select * from podcasts where user_id in (${userA}, ${userB})`).toHaveLength(0)
    } finally {
      await owner.end()
    }
  })
})

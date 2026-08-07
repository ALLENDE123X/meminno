// The app's RUNTIME database connection.
//
// DATABASE_URL here is the `meminno_rls` role (MEM-002-fix, issue #14), NOT
// the `meminno_app` role that owns the tables and runs migrations. That
// split is the whole point: `meminno_rls` owns nothing, holds only explicit
// per-table grants, and has no BYPASSRLS attribute, so every RLS policy in
// ./schema.ts genuinely applies to every query this module issues. The
// migration role lives in MIGRATION_DATABASE_URL and is only ever used by
// drizzle-kit (see drizzle.config.ts) - never import it here.
//
// Consequence, and the reason `withUserContext()` below exists: because
// every user table is `FORCE ROW LEVEL SECURITY` with policies scoped to
// `public.meminno_current_user_id()`, a bare `db.select().from(documents)`
// on this connection returns ZERO rows unless the caller's identity has
// been put on the session first. Route handlers must go through
// `withUserContext(session.user.id, ...)`; that is not a convention to
// remember, it is enforced by the database.
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema'

// max: 1 + a short idle_timeout is the standard postgres.js configuration
// for a serverless target sitting behind Supabase's transaction-mode pooler
// (port 6543, PgBouncer/Supavisor). Every Vercel/Inngest invocation gets its
// own fresh module scope and therefore its own postgres() client - with no
// cap, each client defaults to up to 10 connections, so a handful of
// concurrent invocations can exhaust the pooler's shared connection slots. A
// single serverless invocation only ever needs one connection at a time
// (queries within it are sequential), so max: 1 costs nothing and lets far
// more concurrent invocations succeed within the pooler's real capacity.
// idle_timeout releases that one connection back to the pooler quickly once
// a request finishes, rather than holding it for a container's whole
// (possibly long) idle-then-reused lifetime.
//
// Mirrors Propinno's lib/db/index.ts verbatim (same pooling rationale, same
// lazy-Proxy fallback so static analysis/build doesn't crash when
// DATABASE_URL is absent).
const POOL_OPTIONS = { prepare: false, max: 1, idle_timeout: 20 } as const

let db: PostgresJsDatabase<typeof schema>

if (process.env.DATABASE_URL) {
  const client = postgres(process.env.DATABASE_URL, POOL_OPTIONS)
  db = drizzle(client, { schema })
} else {
  // Create a dummy client and database instance to act as the Proxy target.
  // This ensures prototype checks (like Drizzle's `is(db, PgDatabase)`) succeed during static compilation
  // and do not throw "Unsupported database type" errors in adapter initializations like NextAuth.
  const dummyClient = postgres('postgresql://localhost:5432/postgres', POOL_OPTIONS)
  const dummyDb = drizzle(dummyClient, { schema })

  // Use Proxy to handle database operations lazily when DATABASE_URL is available
  db = new Proxy(dummyDb, {
    get(target, prop) {
      // Delegate symbols, constructor, and then-able checks to the dummy database to avoid crashing
      // during library initialization and static analysis when DATABASE_URL is absent.
      if (
        !process.env.DATABASE_URL &&
        (typeof prop === 'symbol' || prop === 'constructor' || prop === 'then')
      ) {
        return Reflect.get(target, prop)
      }

      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is missing from environment variables. Cannot execute database operations.')
      }
      const client = postgres(process.env.DATABASE_URL, POOL_OPTIONS)
      const actualDb = drizzle(client, { schema })
      return Reflect.get(actualDb, prop)
    }
  }) as PostgresJsDatabase<typeof schema>
}

export { db }
export type DbType = typeof db

/** The transaction handle `withUserContext()` hands to its callback. */
export type DbTransaction = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Runs `fn` inside a transaction whose session identity is `userId`, which
 * is what every RLS policy in ./schema.ts scopes rows by.
 *
 * `set_config(..., true)` is transaction-local, so the identity can never
 * leak into a later query that reuses the same pooled connection - this
 * matters specifically because Supabase's transaction-mode pooler (port
 * 6543) hands the same backend connection to unrelated requests between
 * transactions. Session-level `SET` would be a cross-tenant data leak here;
 * `SET LOCAL`/`set_config(_, _, true)` is the only safe form.
 *
 * `userId` is bound as a parameter (never interpolated), and additionally
 * validated as a UUID so a malformed value fails here with a clear error
 * rather than as an opaque cast failure inside every policy evaluation.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error('withUserContext: userId must be a UUID (got a non-UUID value)')
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_user_id', ${userId}, true)`)
    return fn(tx)
  })
}
